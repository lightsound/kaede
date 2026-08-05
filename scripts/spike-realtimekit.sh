#!/usr/bin/env bash
# RealtimeKit 参加トークン発行スパイク (ROADMAP Phase 4 増分0)。
# 発見事項の記録先は docs/ROADMAP.md の Phase 4 セクション。
#
# 何を検証するか:
#   1. 認証モデル: RealtimeKit API は独立キーではなく Cloudflare API トークン
#      (Realtime 権限) で叩ける — アプリ一覧の取得が通ることで確認
#   2. アプリ/プリセット: kaede 用アプリを作成し、既定プリセットの有無と
#      内容 (view_type・can_record 等) を確認
#   3. ミーティング作成 → 参加トークン発行 (Add Participant) → トークンの
#      形式と有効期限 (JWT なら exp を読む) → リフレッシュ API
#   4. Webhook 登録 API (recording.statusUpdate ほか) — 登録と一覧のみ。
#      受信の実地確認は Worker を持つ増分①/③ で行う
#
# 使い方:
#   REALTIMEKIT_API_TOKEN=... scripts/spike-realtimekit.sh
#
# 前提:
#   - REALTIMEKIT_API_TOKEN: Realtime 権限 (Realtime Admin) を持つ
#     Cloudflare API トークン。増分①では Worker のランタイムシークレットに
#     なる (Alchemy 経由で注入)
#   - jq がインストール済み
#
# 設計メモ:
#   - 冪等: アプリは名前 (kaede) で検索して再利用し、無ければ作成する。
#     ミーティング・参加者は毎回作る (スパイクの使い捨てデータ。ミーティングは
#     RealtimeKit 側に残るが課金はセッション分のみ)
#   - このスクリプトは削除せず残す: トークンローテーションや障害調査で
#     「API がこの形で通ること」を最短で再確認する道具になる
set -euo pipefail

: "${REALTIMEKIT_API_TOKEN:?REALTIMEKIT_API_TOKEN (Realtime 権限付き Cloudflare API トークン) が必要です}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-751c8a59858c9c04a8e722df7330444d}" # アカウント「Kaede」(infra/alchemy.run.ts と同じ公開識別子)
BASE="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/realtime/kit"
APP_NAME="${APP_NAME:-kaede}"

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

step() { printf '\n== %s ==\n' "$1"; }

step "1. 認証モデル: アプリ一覧 (Realtime 権限の確認)"
apps=$(api GET /apps)
echo "$apps" | jq .
if [ "$(echo "$apps" | jq -r '.success')" != "true" ]; then
  echo "認証失敗: トークンに Realtime 権限 (Realtime Admin) が無い。ここで終了" >&2
  exit 1
fi

step "2. アプリ ${APP_NAME} の再利用 or 作成"
app_id=$(echo "$apps" | jq -r --arg n "$APP_NAME" '.data[]? // empty | select(.name == $n) | .id' | head -1)
if [ -z "$app_id" ] || [ "$app_id" = "null" ]; then
  created=$(api POST /apps "{\"name\": \"${APP_NAME}\"}")
  echo "$created" | jq .
  app_id=$(echo "$created" | jq -r '.data.app.id // empty')
fi
if [ -z "$app_id" ]; then
  echo "アプリ ID が取得できない (再利用も作成も失敗 — 上のレスポンスを確認)。以降は //presets のような壊れた URL を叩くだけなのでここで終了" >&2
  exit 1
fi
echo "app_id=${app_id}"

step "3. プリセット一覧 (既定プリセットの有無と内容)"
api GET "/${app_id}/presets" | jq .

step "4. ミーティング作成"
meeting=$(api POST "/${app_id}/meetings" '{"title": "spike 会議"}')
echo "$meeting" | jq .
meeting_id=$(echo "$meeting" | jq -r '.data.id // empty')
if [ -z "$meeting_id" ]; then
  echo "ミーティング ID が取得できない (上のレスポンスを確認)。ここで終了" >&2
  exit 1
fi
echo "meeting_id=${meeting_id}"

step "5. 参加トークン発行 (Add Participant)"
preset_name="${PRESET_NAME:-group_call_participant}"
participant=$(api POST "/${app_id}/meetings/${meeting_id}/participants" \
  "{\"name\": \"スパイク参加者\", \"preset_name\": \"${preset_name}\", \"custom_participant_id\": \"spike-account-1\"}")
echo "$participant" | jq 'if .data.token then .data.token = "[取得済み・後段で解析]" else . end'
token=$(echo "$participant" | jq -r '.data.token // empty')
participant_id=$(echo "$participant" | jq -r '.data.id // empty')

step "6. トークンの形式と有効期限"
if [ -n "$token" ]; then
  # JWT なら 2 番目のセグメントが claims。exp/iat から寿命を読む。
  payload=$(echo "$token" | cut -d. -f2 | tr '_-' '/+' | { p=$(cat); pad=$(( (4 - ${#p} % 4) % 4 )); printf '%s%s' "$p" "$(printf '=%.0s' $(seq 1 $pad) 2>/dev/null || true)"; } | base64 -d 2>/dev/null || echo '{}')
  echo "claims: $payload" | head -c 2000; echo
  echo "$payload" | jq -r 'if .exp and .iat then "トークン寿命: \((.exp - .iat) / 3600) 時間" else "exp/iat が読めない (JWT でない可能性)" end' 2>/dev/null || echo "(JWT として解析できない形式)"
else
  echo "トークンが取得できていない (上のレスポンスを確認)"
fi

step "7. トークンリフレッシュ API"
if [ -n "$participant_id" ]; then
  api POST "/${app_id}/meetings/${meeting_id}/participants/${participant_id}/token" \
    | jq 'if .data.token then .data.token = "[再発行された]" else . end'
fi

step "8. Webhook 登録 API (登録 → 一覧 → 削除)"
webhook=$(api POST "/${app_id}/webhooks" '{
  "name": "spike webhook",
  "url": "https://example.invalid/webhook",
  "events": ["meeting.started", "meeting.ended", "recording.statusUpdate"],
  "enabled": false
}')
echo "$webhook" | jq .
webhook_id=$(echo "$webhook" | jq -r '.data.id // empty')
api GET "/${app_id}/webhooks/all" | jq '.data | if type == "object" then {events: .events} else . end' 2>/dev/null || true
if [ -n "$webhook_id" ]; then
  api DELETE "/${app_id}/webhooks/${webhook_id}" | jq -c .
fi

step "完了"
echo "app_id=${app_id} meeting_id=${meeting_id} — 結果を docs/ROADMAP.md Phase 4 に追記すること"
