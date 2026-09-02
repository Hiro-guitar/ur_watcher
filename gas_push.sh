#!/usr/bin/env bash
#
# gas_push.sh - gas/ の中身をGASプロジェクトに反映する
#
# Apps Script REST API を直接叩く（claspのログイン情報 ~/.clasprc.json を借りる）。
# トリガーやスクリプトプロパティはGAS側に残るので、コードだけ入れ替わる。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/gas"
CLASPRC="$HOME/.clasprc.json"
SCRIPT_ID=$(jq -r '.scriptId' "$SRC_DIR/.clasp.json")

CLIENT_ID=$(jq -r '.tokens.default.client_id' "$CLASPRC")
CLIENT_SECRET=$(jq -r '.tokens.default.client_secret' "$CLASPRC")
REFRESH_TOKEN=$(jq -r '.tokens.default.refresh_token' "$CLASPRC")

echo "アクセストークンを更新中..."
TOKEN=$(curl -sS -X POST "https://oauth2.googleapis.com/token" \
    -d "grant_type=refresh_token" \
    -d "client_id=${CLIENT_ID}" \
    -d "client_secret=${CLIENT_SECRET}" \
    -d "refresh_token=${REFRESH_TOKEN}" | jq -r '.access_token')

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
    echo "ERROR: アクセストークンを取得できませんでした。npx @google/clasp login を実行してください。"
    exit 1
fi

PAYLOAD=$(python3 -c "
import json, glob, os, sys
src = sys.argv[1]
files = [{'name': 'appsscript', 'type': 'JSON',
          'source': open(os.path.join(src, 'appsscript.json'), encoding='utf-8').read()}]
for path in sorted(glob.glob(os.path.join(src, '*.js'))):
    files.append({'name': os.path.splitext(os.path.basename(path))[0], 'type': 'SERVER_JS',
                  'source': open(path, encoding='utf-8').read()})
print(json.dumps({'files': files}, ensure_ascii=False))
" "$SRC_DIR")

echo "送信中: $(echo "$PAYLOAD" | jq '.files | length') ファイル"
RESPONSE=$(printf '%s' "$PAYLOAD" | curl -sS -X PUT \
    "https://script.googleapis.com/v1/projects/${SCRIPT_ID}/content" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "@-")

ERROR=$(echo "$RESPONSE" | jq -r '.error.message // empty')
if [[ -n "$ERROR" ]]; then
    echo "ERROR: $ERROR"
    exit 1
fi

echo "反映しました: $(echo "$RESPONSE" | jq -r '[.files[].name] | join(", ")')"
echo "エディタ: https://script.google.com/home/projects/${SCRIPT_ID}/edit"
