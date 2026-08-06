#!/usr/bin/env bash
# RealtimeKit の録画 Webhook 登録 (ROADMAP Phase 4 増分④)。冪等 — 同じ URL の
# 登録が既にあれば何もしない。spike-realtimekit.sh と同じく削除せず残す道具:
# アプリを作り直した・Webhook を消してしまった・URL が変わった、を最短で復旧する。
#
# 使い方:
#   REALTIMEKIT_API_TOKEN=... scripts/ensure-realtimekit-webhook.sh [APP_ID] [WEBHOOK_URL]
#
# 既定はプロダクション (アプリ kaede → kaede-call Worker の受け口)。ローカル
# wrangler dev は公開 URL を持たないため登録できない — Webhook のライブ検証は
# 一時デプロイした Worker に対して行う (増分④の手動テスト記録を参照)。
set -euo pipefail

: "${REALTIMEKIT_API_TOKEN:?REALTIMEKIT_API_TOKEN (Realtime 権限付き Cloudflare API トークン) が必要です}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-751c8a59858c9c04a8e722df7330444d}"
APP_ID="${1:-84053947-0a8e-4b23-840a-a47731b7310b}" # 本番アプリ kaede (infra/wrangler-call.jsonc と同じ公開識別子)
WEBHOOK_URL="${2:-https://kaede-call.kaede-751.workers.dev/webhooks/realtimekit}"
BASE="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/realtime/kit"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "${BASE}${path}" \
      -H "Authorization: Bearer ${REALTIMEKIT_API_TOKEN}" \
      -H 'Content-Type: application/json' \
      --data "$body"
  else
    curl -sS -X "$method" "${BASE}${path}" \
      -H "Authorization: Bearer ${REALTIMEKIT_API_TOKEN}"
  fi
}

# GET /webhooks が登録済み一覧(/webhooks/all は利用可能イベントの語彙なので別物)。
# 未登録のアプリは success=false + "Webhook not found" を返す — 空一覧として扱う。
existing=$(api GET "/${APP_ID}/webhooks")
if [ "$(echo "$existing" | jq -r '.success')" != "true" ]; then
  message=$(echo "$existing" | jq -r '.error.message // empty')
  if [ "$message" != "Webhook not found" ]; then
    echo "Webhook 一覧の取得に失敗: $existing" >&2
    exit 1
  fi
fi

match=$(echo "$existing" | jq -r --arg url "$WEBHOOK_URL" \
  '[.data? // empty | if type == "array" then .[] else . end | select(.url == $url)] | length')
if [ "$match" -gt 0 ]; then
  echo "登録済み: ${WEBHOOK_URL} (${match} 件) — 何もしない"
  exit 0
fi

created=$(api POST "/${APP_ID}/webhooks" "$(jq -nc --arg url "$WEBHOOK_URL" \
  '{name: "kaede recording status", url: $url, events: ["recording.statusUpdate"], enabled: true}')")
if [ "$(echo "$created" | jq -r '.success')" != "true" ]; then
  echo "Webhook 登録に失敗: $created" >&2
  exit 1
fi
echo "登録した: ${WEBHOOK_URL} (id=$(echo "$created" | jq -r '.data.id'))"
