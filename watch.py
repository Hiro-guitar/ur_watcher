#!/usr/bin/env python3
"""UR賃貸の空室を監視して、新しい部屋が出たらLINEに通知する。

UR公式サイトが内部で使っているJSON APIを叩いて、団地ごとの募集中の部屋一覧を取得する。
前回の実行時に見えていなかった部屋IDが現れたら「新着」として通知する。

使い方:
    python watch.py                # 通常実行（新着があればLINE通知）
    python watch.py --dry-run      # 通知せず、新着の内容だけ表示
    python watch.py --notify-first # 初回でも今ある空室をまとめて通知
"""

import argparse
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API_URL = "https://chintai.r6.ur-net.go.jp/chintai/api/bukken/detail/detail_bukken_room/"
LINE_BROADCAST_URL = "https://api.line.me/v2/bot/message/broadcast"
LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push"
SITE_BASE = "https://www.ur-net.go.jp"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
JST = timezone(timedelta(hours=9))

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- UR API

def parse_danchi_url(url):
    """団地ページのURLから API に渡す (shisya, danchi, shikibetu) を取り出す。

    例) .../kanto/tokyo/20_4900.html -> ('20', '490', '0')
    """
    m = re.search(r"/(\d{2})_(\d{3})(\d)\.html", url)
    if not m:
        raise ValueError("団地ページのURLとして解釈できません: %s" % url)
    return m.group(1), m.group(2), m.group(3)


def http_post(url, data, headers, timeout=30):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8")


def fetch_rooms(shisya, danchi, shikibetu):
    """団地の募集中の部屋一覧を取得する。空室ゼロなら空リスト。"""
    body = urllib.parse.urlencode({
        "shisya": shisya,
        "danchi": danchi,
        "shikibetu": shikibetu,
        "orderByField": "0",
        "orderBySort": "0",
        "pageIndex": "0",
        "sp": "",
    }).encode("utf-8")
    text = http_post(API_URL, body, {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": SITE_BASE + "/chintai/",
    })
    payload = json.loads(text)
    # 空室が1件も無いときは null が返る
    return payload if isinstance(payload, list) else []


def clean(value):
    """APIの値をそのまま人に見せられる文字列にする（&#13217; -> ㎡ など）。"""
    if value is None:
        return ""
    return html.unescape(str(value)).strip()


def fix_url(url):
    """`https://host//path` のような二重スラッシュを直す。"""
    if not url:
        return ""
    if url.startswith("/"):
        url = SITE_BASE + url
    scheme, _, rest = url.partition("://")
    if not rest:
        return url
    return scheme + "://" + re.sub(r"/{2,}", "/", rest)


def to_room(raw, danchi_name):
    """APIの生データから、通知と保存に使う分だけ取り出す。"""
    return {
        "id": clean(raw.get("id")),
        "danchi": danchi_name,
        "name": clean(raw.get("name")),
        "type": clean(raw.get("type")),
        "floorspace": clean(raw.get("floorspace")),
        "floor": clean(raw.get("floor")),
        "rent": clean(raw.get("rent")),
        "commonfee": clean(raw.get("commonfee")),
        "shikikin": clean(raw.get("shikikin")),
        "madori": fix_url(clean(raw.get("madori"))),
        "url": fix_url(clean(raw.get("roomDetailLink"))),
    }


def rent_to_int(rent):
    """'77,800円' -> 77800。読めなければ None。"""
    digits = re.sub(r"[^\d]", "", rent or "")
    return int(digits) if digits else None


def passes_filter(room, filters):
    """config.json の filters に合う部屋だけ通知する。"""
    if not filters:
        return True
    rent_max = filters.get("rent_max")
    if rent_max:
        rent = rent_to_int(room["rent"])
        if rent is not None and rent > rent_max:
            return False
    madori = filters.get("madori") or []
    if madori and room["type"] not in madori:
        return False
    floorspace_min = filters.get("floorspace_min")
    if floorspace_min:
        m = re.search(r"[\d.]+", room["floorspace"])
        if m and float(m.group()) < floorspace_min:
            return False
    return True


# ---------------------------------------------------------------- LINE

def flex_bubble(room):
    detail = "　".join(x for x in [room["type"], room["floorspace"], room["floor"]] if x)
    rent_line = room["rent"] or "家賃不明"
    if room["commonfee"]:
        rent_line += "（共益費 %s）" % room["commonfee"]

    bubble = {
        "type": "bubble",
        "size": "kilo",
        "body": {
            "type": "box",
            "layout": "vertical",
            "spacing": "sm",
            "contents": [
                {"type": "text", "text": room["danchi"], "size": "sm", "color": "#888888"},
                {"type": "text", "text": room["name"] or "号室不明", "weight": "bold", "size": "lg", "wrap": True},
                {"type": "text", "text": rent_line, "size": "md", "color": "#D0021B", "wrap": True},
                {"type": "text", "text": detail, "size": "sm", "color": "#444444", "wrap": True},
                {"type": "text", "text": "敷金 " + (room["shikikin"] or "-"), "size": "xs", "color": "#888888"},
            ],
        },
    }
    # LINEのFlexが表示できる画像は JPEG/PNG のみ。URLの間取り図は GIF のことが多いので、
    # 貼れるときだけヒーロー画像にして、それ以外はボタンから開いてもらう。
    if re.search(r"\.(jpe?g|png)$", room["madori"], re.I):
        bubble["hero"] = {
            "type": "image",
            "url": room["madori"],
            "size": "full",
            "aspectRatio": "1:1",
            "aspectMode": "fit",
            "backgroundColor": "#FFFFFF",
        }

    buttons = []
    if room["url"]:
        buttons.append({
            "type": "button", "style": "primary", "height": "sm",
            "action": {"type": "uri", "label": "詳細を見る", "uri": room["url"]},
        })
    if room["madori"] and "hero" not in bubble:
        buttons.append({
            "type": "button", "style": "secondary", "height": "sm",
            "action": {"type": "uri", "label": "間取り図", "uri": room["madori"]},
        })
    if buttons:
        bubble["footer"] = {"type": "box", "layout": "vertical", "spacing": "sm", "contents": buttons}
    return bubble


def text_message(rooms):
    lines = ["【UR新着】%d件のお部屋が出ました" % len(rooms), ""]
    for room in rooms:
        lines.append("■ %s %s" % (room["danchi"], room["name"]))
        detail = " / ".join(x for x in [room["type"], room["floorspace"], room["floor"]] if x)
        lines.append("　%s（共益費 %s）" % (room["rent"], room["commonfee"] or "-"))
        lines.append("　" + detail)
        if room["url"]:
            lines.append("　" + room["url"])
        lines.append("")
    return "\n".join(lines).strip()


def line_send(messages, token, user_id=None):
    """LINE_USER_ID があれば本人だけにpush、無ければ友だち全員にbroadcast。

    自分専用のアカウントなら友だちは自分だけなのでbroadcastで足りる。
    顧客がいる既存アカウントを使う場合は、必ず LINE_USER_ID を設定してpushにすること
    （broadcastだと友だち全員に飛ぶ）。
    """
    if user_id:
        url = LINE_PUSH_URL
        payload = {"to": user_id, "messages": messages}
    else:
        url = LINE_BROADCAST_URL
        payload = {"messages": messages}
    http_post(url, json.dumps(payload, ensure_ascii=False).encode("utf-8"), {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
    })


def notify(rooms, token, user_id=None):
    """新着の部屋をLINEに送る。1回の通知は1メッセージ（無料枠の節約）。"""
    names = "、".join(r["name"] for r in rooms[:3])
    alt = "【UR新着】%s%s" % (names, " ほか%d件" % (len(rooms) - 3) if len(rooms) > 3 else "")
    # Flexのカルーセルは最大12バブル。溢れた分はテキストで補う。
    bubbles = [flex_bubble(r) for r in rooms[:12]]
    flex = {
        "type": "flex",
        "altText": alt[:400],
        "contents": {"type": "carousel", "contents": bubbles},
    }
    try:
        line_send([flex], token, user_id)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        print("Flexメッセージの送信に失敗（%s）。テキストで再送します: %s" % (e.code, detail), file=sys.stderr)
        line_send([{"type": "text", "text": text_message(rooms)[:4900]}], token, user_id)


# ---------------------------------------------------------------- 本体

def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


def main():
    parser = argparse.ArgumentParser(description="UR賃貸の空室を監視してLINEに通知する")
    parser.add_argument("--config", default=os.path.join(HERE, "config.json"))
    parser.add_argument("--state", default=os.path.join(HERE, "state.json"))
    parser.add_argument("--dry-run", action="store_true", help="LINEに送らず内容を表示するだけ")
    parser.add_argument("--notify-first", action="store_true", help="初回の団地でも今の空室を通知する")
    args = parser.parse_args()

    config = load_json(args.config, None)
    if not config:
        print("config.json が読めません: %s" % args.config, file=sys.stderr)
        return 1
    state = load_json(args.state, {})
    token = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "").strip()
    user_id = os.environ.get("LINE_USER_ID", "").strip()

    if not token and not args.dry_run:
        print("環境変数 LINE_CHANNEL_ACCESS_TOKEN が設定されていません", file=sys.stderr)
        return 1
    if not args.dry_run:
        print("送信方法: %s" % ("push（自分だけに送信）" if user_id else "broadcast（友だち全員に送信）"))

    new_rooms = []
    next_state = dict(state)
    failed = []
    # 秒まで記録すると毎回state.jsonに差分が出て、5分ごとにコミットが積まれてしまう。
    # 日付だけにして「1日1コミット（＝リポジトリの活動も途切れない）」に抑える。
    today = datetime.now(JST).strftime("%Y-%m-%d")

    for entry in config.get("danchi", []):
        url = entry["url"]
        name = entry.get("name") or url
        try:
            shisya, danchi, shikibetu = parse_danchi_url(url)
            raw_rooms = fetch_rooms(shisya, danchi, shikibetu)
        except Exception as e:  # 1団地の失敗で全体を止めない
            print("[%s] 取得に失敗: %s" % (name, e), file=sys.stderr)
            failed.append(name)
            continue

        rooms = [to_room(r, name) for r in raw_rooms]
        rooms = [r for r in rooms if r["id"]]
        key = "%s_%s%s" % (shisya, danchi, shikibetu)
        known = set((state.get(key) or {}).get("room_ids") or [])
        first_time = key not in state

        found = [r for r in rooms if r["id"] not in known and passes_filter(r, config.get("filters"))]
        if first_time and not args.notify_first:
            print("[%s] 初回のため通知せず記録のみ（現在 %d件）" % (name, len(rooms)))
        else:
            new_rooms.extend(found)
            print("[%s] 募集中 %d件 / 新着 %d件" % (name, len(rooms), len(found)))

        next_state[key] = {
            "name": name,
            "url": url,
            "checked_at": today,
            # 募集終了した部屋はここから消える＝再募集されたらまた新着として通知される
            "room_ids": sorted(r["id"] for r in rooms),
        }

    if new_rooms:
        print("--- 新着 %d件 ---" % len(new_rooms))
        print(text_message(new_rooms))
        if args.dry_run:
            print("(--dry-run のため通知しません)")
        else:
            try:
                notify(new_rooms, token, user_id)
                print("LINEに通知しました")
            except Exception as e:
                # 通知できなかった分を次回また拾えるよう、状態は保存しない
                print("LINE通知に失敗しました: %s" % e, file=sys.stderr)
                return 1

    if not args.dry_run:
        save_json(args.state, next_state)

    # 健全性チェック：常に空室があるはずの団地まで一斉に0件なら、
    # 空室が無いのではなくAPI側が変わった可能性が高い（黙って取りこぼすのを防ぐ）。
    canary = config.get("canary") or []
    if canary and not failed:
        total = 0
        for entry in canary:
            try:
                total += len(fetch_rooms(*parse_danchi_url(entry["url"])))
            except Exception as e:
                print("[健全性チェック] %s の取得に失敗: %s" % (entry.get("name"), e), file=sys.stderr)
                failed.append(entry.get("name") or entry["url"])
        if not failed and total == 0:
            print("[健全性チェック] 参照用の%d団地がすべて0件です。APIの仕様変更を疑ってください。"
                  % len(canary), file=sys.stderr)
            return 1
        print("[健全性チェック] 参照用の%d団地で %d件の募集を確認" % (len(canary), total))

    if failed:
        # 取得できないまま黙って動き続けると新着を取りこぼす。
        # ジョブを失敗させて、GitHubからの通知で気づけるようにする。
        print("取得に失敗した団地があります: %s" % "、".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
