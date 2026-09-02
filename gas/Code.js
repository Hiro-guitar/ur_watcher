/**
 * UR賃貸の空室監視（私用）
 *
 * 5分おきの時間主導トリガーで checkVacancy() が動き、
 * 前回なかった部屋が出ていたらLINEに通知する。
 *
 * ▼ 初回セットアップ
 *   1. プロジェクトの設定 → スクリプトプロパティに LINE_CHANNEL_ACCESS_TOKEN を追加する
 *      （友だちが自分だけでないアカウントを使う場合は LINE_USER_ID も追加すること。
 *        未設定だとbroadcastになり、そのアカウントの友だち全員に通知が飛ぶ）
 *   2. setup() を1回だけ実行する（5分おきのトリガー作成＋今ある空室の記録）
 *
 * ▼ 監視する団地を増やす
 *   CONFIG.danchi にURLを足して保存するだけ。
 */

const API_URL = 'https://chintai.r6.ur-net.go.jp/chintai/api/bukken/detail/detail_bukken_room/';
const LINE_BROADCAST_URL = 'https://api.line.me/v2/bot/message/broadcast';
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const SITE_BASE = 'https://www.ur-net.go.jp';

const CONFIG = {
  danchi: [
    { name: '新柳沢', url: 'https://www.ur-net.go.jp/chintai/kanto/tokyo/20_4900.html' }
  ],
  // 常に空室がある団地。ここまで一斉に0件ならURのAPIが変わった疑いがあるので警告する。
  canary: [
    { name: '館ヶ丘', url: 'https://www.ur-net.go.jp/chintai/kanto/tokyo/20_2600.html' },
    { name: '赤羽北二丁目', url: 'https://www.ur-net.go.jp/chintai/kanto/tokyo/20_2800.html' },
    { name: 'ニュータウン小山田桜台', url: 'https://www.ur-net.go.jp/chintai/kanto/tokyo/20_3600.html' }
  ],
  filters: {
    rentMax: null,        // 例: 100000 で家賃10万円以下だけ
    madori: [],           // 例: ['2DK', '2LDK']
    floorspaceMin: null   // 例: 45 で45㎡以上だけ
  }
};

// ------------------------------------------------------------ 入口

/** トリガーから5分おきに呼ばれる。 */
function checkVacancy() {
  run(false);
}

/** 初回セットアップ：トリガーを作り、今ある空室は通知せず記録だけする。 */
function setup() {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    throw new Error('スクリプトプロパティ LINE_CHANNEL_ACCESS_TOKEN が未設定です。先に設定してください。');
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkVacancy') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkVacancy').timeBased().everyMinutes(5).create();
  run(false);
  Logger.log('セットアップ完了：5分おきのトリガーを作成しました。');
}

/** 今ある空室を強制的に通知する（動作確認用）。 */
function testNotify() {
  run(true);
}

/** 記録をリセットする（次回、今ある空室がすべて新着として通知される）。 */
function resetState() {
  PropertiesService.getScriptProperties().deleteProperty('STATE');
  Logger.log('記録を消しました。');
}

// ------------------------------------------------------------ 本体

function run(notifyAll) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  const userId = props.getProperty('LINE_USER_ID') || '';
  if (!token) throw new Error('スクリプトプロパティ LINE_CHANNEL_ACCESS_TOKEN が未設定です。');

  const state = getState();
  const nextState = {};
  const newRooms = [];
  const failed = [];
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  CONFIG.danchi.forEach(function (entry) {
    const code = parseDanchiUrl(entry.url);
    let rooms;
    try {
      rooms = fetchRooms(code).map(function (raw) { return toRoom(raw, entry.name); });
    } catch (e) {
      Logger.log('[' + entry.name + '] 取得に失敗: ' + e);
      failed.push(entry.name);
      // 取得できなかった団地は前回の記録をそのまま引き継ぐ（消すと次回に誤通知するため）
      if (state[code.key]) nextState[code.key] = state[code.key];
      return;
    }

    const known = (state[code.key] && state[code.key].roomIds) || [];
    const firstTime = !state[code.key];
    const found = rooms.filter(function (r) {
      return known.indexOf(r.id) === -1 && passesFilter(r);
    });

    if (firstTime && !notifyAll) {
      Logger.log('[' + entry.name + '] 初回のため通知せず記録のみ（現在 ' + rooms.length + '件）');
    } else {
      Logger.log('[' + entry.name + '] 募集中 ' + rooms.length + '件 / 新着 ' + found.length + '件');
      (notifyAll ? rooms : found).forEach(function (r) { newRooms.push(r); });
    }

    nextState[code.key] = {
      name: entry.name,
      url: entry.url,
      checkedAt: today,
      // 募集終了した部屋はここから消える＝再募集されたらまた通知される
      roomIds: rooms.map(function (r) { return r.id; })
    };
  });

  if (newRooms.length > 0) {
    // 送信できなかった分を次回また拾えるよう、通知が成功してから記録を更新する
    notifyLine(newRooms, token, userId);
    Logger.log('LINEに通知しました（' + newRooms.length + '件）');
  }
  saveState(nextState);

  if (failed.length > 0) {
    warnOnce('取得失敗:' + failed.join(','),
             '⚠️ UR空室監視：' + failed.join('、') + ' の空室情報を取得できませんでした。'
             + '一時的な不調なら次回復帰します。続くようなら確認してください。', token, userId);
    return;
  }
  checkCanary(token, userId);
}

/** URのAPIが壊れていないかの確認。常に空室がある団地まで0件なら異常とみなす。 */
function checkCanary(token, userId) {
  if (!CONFIG.canary || CONFIG.canary.length === 0) return;
  let total = 0;
  for (let i = 0; i < CONFIG.canary.length; i++) {
    try {
      total += fetchRooms(parseDanchiUrl(CONFIG.canary[i].url)).length;
    } catch (e) {
      Logger.log('[健全性チェック] ' + CONFIG.canary[i].name + ' の取得に失敗: ' + e);
      return; // 一時的な失敗と区別できないので、ここでは警告しない
    }
  }
  if (total === 0) {
    warnOnce('カナリア全滅',
             '⚠️ UR空室監視：常に空室があるはずの団地まですべて0件でした。'
             + 'URのサイト仕様が変わって、空室を検知できなくなっている可能性があります。', token, userId);
  } else {
    Logger.log('[健全性チェック] 参照用の' + CONFIG.canary.length + '団地で ' + total + '件の募集を確認');
  }
}

/** 同じ警告を1日1回だけ送る。 */
function warnOnce(key, message, token, userId) {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const stamp = today + '|' + key;
  if (props.getProperty('LAST_WARN') === stamp) {
    Logger.log('警告は本日送信済みのため省略: ' + key);
    return;
  }
  props.setProperty('LAST_WARN', stamp);
  Logger.log(message);
  try {
    lineSend([{ type: 'text', text: message }], token, userId);
  } catch (e) {
    Logger.log('警告のLINE送信に失敗: ' + e);
  }
}

// ------------------------------------------------------------ UR API

/** 団地ページのURLから、APIに渡すコードを取り出す。 .../20_4900.html -> 20 / 490 / 0 */
function parseDanchiUrl(url) {
  const m = url.match(/\/(\d{2})_(\d{3})(\d)\.html/);
  if (!m) throw new Error('団地ページのURLとして解釈できません: ' + url);
  return { shisya: m[1], danchi: m[2], shikibetu: m[3], key: m[1] + '_' + m[2] + m[3] };
}

/** 団地の募集中の部屋一覧を取得する。空室ゼロなら空配列。 */
function fetchRooms(code) {
  const options = {
    method: 'post',
    payload: {
      shisya: code.shisya,
      danchi: code.danchi,
      shikibetu: code.shikibetu,
      orderByField: '0',
      orderBySort: '0',
      pageIndex: '0',
      sp: ''
    },
    headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01' },
    muteHttpExceptions: true
  };

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {  // 一時的な不調に備えて1回だけ再試行する
    try {
      const res = UrlFetchApp.fetch(API_URL, options);
      const status = res.getResponseCode();
      if (status !== 200) {
        lastError = new Error('HTTP ' + status);
        continue;
      }
      const data = JSON.parse(res.getContentText());
      return (data === null || !Array.isArray(data)) ? [] : data;  // 空室ゼロのときは null が返る
    } catch (e) {
      lastError = e;
    }
    Utilities.sleep(2000);
  }
  throw lastError;
}

function toRoom(raw, danchiName) {
  return {
    id: clean(raw.id),
    danchi: danchiName,
    name: clean(raw.name),
    type: clean(raw.type),
    floorspace: clean(raw.floorspace),
    floor: clean(raw.floor),
    rent: clean(raw.rent),
    commonfee: clean(raw.commonfee),
    shikikin: clean(raw.shikikin),
    madori: fixUrl(clean(raw.madori)),
    url: fixUrl(clean(raw.roomDetailLink))
  };
}

/** APIの値を人に見せられる文字列にする（&#13217; -> ㎡ など）。 */
function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/** `https://host//path` のような二重スラッシュを直す。 */
function fixUrl(url) {
  if (!url) return '';
  let full = (url.charAt(0) === '/') ? SITE_BASE + url : url;
  const i = full.indexOf('://');
  if (i === -1) return full;
  return full.slice(0, i + 3) + full.slice(i + 3).replace(/\/{2,}/g, '/');
}

function passesFilter(room) {
  const f = CONFIG.filters || {};
  if (f.rentMax) {
    const rent = parseInt(String(room.rent).replace(/[^\d]/g, ''), 10);
    if (rent && rent > f.rentMax) return false;
  }
  if (f.madori && f.madori.length > 0 && f.madori.indexOf(room.type) === -1) return false;
  if (f.floorspaceMin) {
    const m = String(room.floorspace).match(/[\d.]+/);
    if (m && parseFloat(m[0]) < f.floorspaceMin) return false;
  }
  return true;
}

// ------------------------------------------------------------ LINE

/** LINE_USER_ID があれば本人だけにpush、無ければ友だち全員にbroadcast。 */
function lineSend(messages, token, userId) {
  const url = userId ? LINE_PUSH_URL : LINE_BROADCAST_URL;
  const payload = userId ? { to: userId, messages: messages } : { messages: messages };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('LINE送信エラー HTTP ' + res.getResponseCode() + ': ' + res.getContentText());
  }
}

function notifyLine(rooms, token, userId) {
  const names = rooms.slice(0, 3).map(function (r) { return r.name; }).join('、');
  const alt = '【UR新着】' + names + (rooms.length > 3 ? ' ほか' + (rooms.length - 3) + '件' : '');
  const flex = {
    type: 'flex',
    altText: alt.slice(0, 400),
    contents: {
      type: 'carousel',
      contents: rooms.slice(0, 12).map(buildBubble)  // カルーセルは最大12バブル
    }
  };
  try {
    lineSend([flex], token, userId);
  } catch (e) {
    Logger.log('Flexの送信に失敗。テキストで再送します: ' + e);
    lineSend([{ type: 'text', text: buildText(rooms).slice(0, 4900) }], token, userId);
  }
}

function buildBubble(room) {
  const detail = [room.type, room.floorspace, room.floor].filter(String).join('　');
  let rentLine = room.rent || '家賃不明';
  if (room.commonfee) rentLine += '（共益費 ' + room.commonfee + '）';

  const bubble = {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: room.danchi, size: 'sm', color: '#888888' },
        { type: 'text', text: room.name || '号室不明', weight: 'bold', size: 'lg', wrap: true },
        { type: 'text', text: rentLine, size: 'md', color: '#D0021B', wrap: true },
        { type: 'text', text: detail, size: 'sm', color: '#444444', wrap: true },
        { type: 'text', text: '敷金 ' + (room.shikikin || '-'), size: 'xs', color: '#888888' }
      ]
    }
  };

  // LINEのFlexが表示できる画像は JPEG/PNG のみ。URの間取り図はGIFのことが多いのでボタンで開いてもらう。
  if (/\.(jpe?g|png)$/i.test(room.madori)) {
    bubble.hero = {
      type: 'image', url: room.madori, size: 'full',
      aspectRatio: '1:1', aspectMode: 'fit', backgroundColor: '#FFFFFF'
    };
  }

  const buttons = [];
  if (room.url) {
    buttons.push({
      type: 'button', style: 'primary', height: 'sm',
      action: { type: 'uri', label: '詳細を見る', uri: room.url }
    });
  }
  if (room.madori && !bubble.hero) {
    buttons.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'uri', label: '間取り図', uri: room.madori }
    });
  }
  if (buttons.length > 0) {
    bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons };
  }
  return bubble;
}

function buildText(rooms) {
  const lines = ['【UR新着】' + rooms.length + '件のお部屋が出ました', ''];
  rooms.forEach(function (room) {
    lines.push('■ ' + room.danchi + ' ' + room.name);
    lines.push('　' + room.rent + '（共益費 ' + (room.commonfee || '-') + '）');
    lines.push('　' + [room.type, room.floorspace, room.floor].filter(String).join(' / '));
    if (room.url) lines.push('　' + room.url);
    lines.push('');
  });
  return lines.join('\n').trim();
}

// ------------------------------------------------------------ 状態の保存

function getState() {
  const raw = PropertiesService.getScriptProperties().getProperty('STATE');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    Logger.log('記録の読み込みに失敗したので作り直します: ' + e);
    return {};
  }
}

function saveState(state) {
  PropertiesService.getScriptProperties().setProperty('STATE', JSON.stringify(state));
}
