# UR空室ウォッチャー

UR賃貸の団地に新しい空室が出たら、LINEにすぐ通知する。

監視対象はいま **新柳沢（西東京市柳沢3-4）** のみ。追加は [config.json](config.json) にURLを足すだけ。

## しくみ

UR公式サイトが内部で使っているJSON APIを叩いて、団地の募集中の部屋一覧を取得する。

```
POST https://chintai.r6.ur-net.go.jp/chintai/api/bukken/detail/detail_bukken_room/
     shisya=20&danchi=490&shikibetu=0   ← 団地ページURL 20_4900.html から自動で組み立てる
```

- 空室ゼロなら `null`、空室があれば部屋ごとのJSON（部屋ID・号室・間取り・家賃・共益費・階・面積・間取り図）が返る
- 部屋IDを [state.json](state.json) に覚えておき、**前回なかったIDが出たら新着**として通知する
- 募集終了した部屋はstateから消えるので、同じ部屋が再募集されたらまた通知される
- 初回に見つけた部屋は通知しない（今ある空室で通知が埋まらないように）。初回から通知したいときは `--notify-first`

## セットアップ

### 1. LINEの通知先を決める

送信方法は2つあり、環境変数で自動的に切り替わる。

| 環境変数 | 送信方法 | 使う場面 |
| --- | --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` だけ | broadcast（**友だち全員**に配信） | この通知専用に新しく作ったアカウント（友だちが自分だけ） |
| `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_USER_ID` | push（**自分だけ**に送信） | 既存のアカウントを流用するとき |

> **既存の公式アカウントを使うなら `LINE_USER_ID` を必ず設定すること。**
> 未設定だとbroadcastになり、そのアカウントの友だち全員に空室通知が飛ぶ。
> 友だちの多いアカウント（顧客が登録しているもの）は、トークンが漏れたときの被害も大きいので避けたほうがよい。

#### 新しくアカウントを作る場合（10分くらい）

LINE Notifyは2025年に終了したので、**自分専用のLINE公式アカウント**を1つ作って、そこから自分に送る。
友だちが自分だけなら「全員に配信（broadcast）」＝自分だけに届くので、ユーザーIDの取得もWebhookも不要。

1. [LINE Developersコンソール](https://developers.line.biz/console/) にLINEアカウントでログイン
2. プロバイダーを新規作成（名前は自分の名前などでOK）
3. 「新規チャネル作成」→ **Messaging API** を選ぶ
   - 途中でLINE公式アカウントの作成画面（LINE Official Account Manager）に移る。アカウント名は「UR空室通知」など自分がわかる名前で。業種などは適当でよい
   - 作成後、Developersコンソールに戻ってMessaging APIチャネルとして表示される
4. チャネルの **[Messaging API設定]** タブを開く
   - 一番下の **チャネルアクセストークン（長期）** を「発行」→ この文字列をコピーしておく（有効期限なし）
   - 同じタブのQRコードを自分のLINEで読み取って、**友だち追加**する（これをしないと通知が届かない）
5. [LINE Official Account Manager](https://manager.line.biz/) の 設定 → 応答設定 で
   - **応答メッセージ：オフ**（「メッセージありがとうございます」の自動返信を止める）
   - あいさつメッセージもオフでよい

#### 既存のアカウントを流用する場合

1. [LINE Developersコンソール](https://developers.line.biz/console/) で そのアカウントのMessaging APIチャネルを開く
   - Official Account Managerで作ったアカウントは、[Messaging API設定]から利用開始するとDevelopers側に現れる
2. **[Messaging API設定]** タブ → チャネルアクセストークン（長期）を発行
3. **[チャネル基本設定]** タブの一番下 → **「あなたのユーザーID」**（`U`で始まる33文字）をコピー
   - これが `LINE_USER_ID`。この値を入れると自分だけに届く
4. そのアカウントを自分のLINEで友だち追加しておく（未追加だとpushが届かない）

> トークンは他人に見せない。このリポジトリにも絶対にコミットしない（GitHub Secretsに入れる）。

### 2. ローカルで試す

```bash
cd ~/Desktop/ur_watcher
python3 watch.py --dry-run --notify-first
```

LINEに実際に届くか試すなら:

```bash
read -s LINE_CHANNEL_ACCESS_TOKEN && export LINE_CHANNEL_ACCESS_TOKEN && python3 watch.py --notify-first
```

（`read -s` にすると、貼り付けたトークンが画面にもシェル履歴にも残らない）

既存アカウントを使う場合はユーザーIDも一緒に:

```bash
read -s LINE_CHANNEL_ACCESS_TOKEN && export LINE_CHANNEL_ACCESS_TOKEN
export LINE_USER_ID=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
python3 watch.py --notify-first
```

実行時に `送信方法: push（自分だけに送信）` と出れば正しい。`broadcast` と出たら `LINE_USER_ID` が読めていないので中止すること。

### 3. GitHub Actionsで24時間動かす

Macの電源に関係なく動かすため、GitHubに置いて5分ごとに実行する。

```bash
cd ~/Desktop/ur_watcher
git init && git add -A && git commit -m "初期コミット"
gh repo create ur_watcher --public --source=. --push
```

**publicにする理由**: GitHub Actionsはpublicリポジトリなら実行時間が無料無制限。privateだと無料枠が月2,000分で、
5分ごと（月約8,600回、1回あたり最低1分課金）だと確実に超える。
公開されるのは監視スクリプトと団地の空室状況だけで、トークンはSecretsに入るのでリポジトリには含まれない。
privateにしたい場合は [.github/workflows/watch.yml](.github/workflows/watch.yml) のcronを `*/30 * * * *`（30分ごと）以上にすること。

続いてトークンをSecretsに登録する:

```bash
gh secret set LINE_CHANNEL_ACCESS_TOKEN
gh secret set LINE_USER_ID   # 既存アカウントを流用する場合は必須
```

（プロンプトが出たら値を貼り付けてEnter）

最後に手動で1回動かして確認:

```bash
gh workflow run "UR空室チェック" && sleep 20 && gh run list --limit 3
```

## 監視する団地を増やす

団地ページのURLをコピーして [config.json](config.json) に足すだけ。

```json
{
  "danchi": [
    {"name": "新柳沢", "url": "https://www.ur-net.go.jp/chintai/kanto/tokyo/20_4900.html"},
    {"name": "竹の塚第一", "url": "https://www.ur-net.go.jp/chintai/kanto/tokyo/20_1300.html"}
  ]
}
```

条件で絞りたいときは `filters` を使う（未指定なら全部通知）:

```json
"filters": {
  "rent_max": 100000,        // 家賃10万円以下だけ
  "madori": ["2DK", "2LDK"], // この間取りだけ
  "floorspace_min": 45       // 45㎡以上だけ
}
```

## 見逃す可能性があるケース

完全ではないので、ここは把握しておく。

- **チェックの合間に出て消えた部屋**: 5分間隔なので、その間に出て埋まった部屋は拾えない。GitHubのcron遅延（混雑時は数分〜十数分）で間隔が開くこともある
- **UR側のAPI仕様変更**: 空室ゼロも団地が存在しない場合も同じ `null` が返るため、変更に気づけないと黙って「空室なし」を返し続ける。対策として、常に空室がある団地（`config.json` の `canary`）を毎回チェックし、**そこまで一斉に0件ならジョブを失敗させる**。GitHubから実行失敗の通知が届くので気づける
- **取得エラー**: 団地の取得に失敗した場合もジョブを失敗させる（黙って通り過ぎない）
- **LINEの無料枠**: 月200通を超えると送信できない。1通知＝1通なので通常は問題ない
- **60日ルール**: GitHubはリポジトリに60日間活動がないとスケジュール実行を自動停止する。state.jsonの日付が毎日更新されて1日1コミット入るので、これは自動的に回避される

もっと速くしたい場合は、ワークフローのcronはGitHubの仕様で5分が最短なので、1回のジョブの中で60秒おきに数回チェックするループを入れる（実質1分間隔にできる）。

## 注意

- **通知の速さ**: GitHubのcronは混雑すると数分〜十数分遅れる。UR側の空室情報も「前日以前の状況」を含むため、サイト反映と同時ではない
- **LINEの無料枠**: 月200通まで無料。1回の通知＝1通（新着が複数でも1通にまとめている）なので、通常は使い切らない
- **先着順**: URは先着順なので、通知が来たらすぐ [UR賃貸の申込ページ](https://www.ur-net.go.jp/chintai/) か電話で押さえる

## ファイル

| ファイル | 中身 |
| --- | --- |
| [watch.py](watch.py) | 本体。取得・差分判定・LINE通知 |
| [config.json](config.json) | 監視する団地と絞り込み条件 |
| [state.json](state.json) | 前回見えていた部屋ID（自動更新。手で触らない） |
| [.github/workflows/watch.yml](.github/workflows/watch.yml) | 5分ごとの実行設定 |
