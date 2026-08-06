#!/usr/bin/env bash
# 本番データベース(Maincloud)の全テーブルを JSON でエクスポートする。
# 手順・復旧方法の全体は docs/backup-restore.md を参照。
#
# 使い方:
#   scripts/backup-maincloud.sh [出力ディレクトリ]
#     出力先の既定は backups/<UTC タイムスタンプ>/
#
# 前提:
#   - SpacetimeDB CLI でログイン済みであること
#     (CI では `spacetime login --token "$SPACETIMEDB_TOKEN"` を先に実行する)
#   - 環境変数:
#     SPACETIME_BIN  CLI のバイナリ名 (既定 spacetime。リリース tarball 直置きの
#                    環境では spacetimedb-cli — packages/e2e と同じ流儀)
#     DATABASE       対象データベース名 (既定 kaede)
#     SERVER         対象サーバー (既定 maincloud)
#
# 設計メモ:
#   - テーブル一覧は `describe --json` から動的に取るので、スキーマにテーブルを
#     足してもこのスクリプトの更新は不要(取り忘れが起きない)。
#   - `sql` はデータベースオーナーとして実行され、RLS も public フラグも
#     受けない(非公開テーブルも全部読める)。JSON はスキーマ+行の自己記述形式。
#   - CLI の WARNING は stderr、JSON は stdout に分かれる(2026-08-04 実測)。
#   - 秘密テーブルは名前で除外する(下の EXCLUDE_TABLES)。バックアップの
#     成果物は GitHub artifacts に 90 日残るため、API トークン・S3 資格情報を
#     持つ行を絶対に書き出さない(ROADMAP Phase 4 増分⑥ D5)。復旧は
#     リストアではなく owner SQL での再播種(docs/backup-restore.md)。
set -euo pipefail

# 除外テーブル(スペース区切り)。call_config = 通話/録画 API の資格情報
# (packages/server/src/tables.ts のテーブルコメントと対で更新すること)。
EXCLUDE_TABLES="call_config"

SPACETIME_BIN="${SPACETIME_BIN:-spacetime}"
DATABASE="${DATABASE:-kaede}"
SERVER="${SERVER:-maincloud}"
OUT="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"

mkdir -p "$OUT"

tables=$(
  "$SPACETIME_BIN" describe "$DATABASE" --server "$SERVER" --no-config --json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const t of JSON.parse(s).tables)console.log(t.name)})'
)

if [ -z "$tables" ]; then
  echo "no tables found in $DATABASE @ $SERVER" >&2
  exit 1
fi

for t in $tables; do
  for excluded in $EXCLUDE_TABLES; do
    if [ "$t" = "$excluded" ]; then
      echo "skipped $t (secret table — see EXCLUDE_TABLES)"
      continue 2
    fi
  done
  "$SPACETIME_BIN" sql "$DATABASE" --server "$SERVER" --no-config --format json \
    "SELECT * FROM $t" > "$OUT/$t.json"
  echo "exported $t"
done

echo "backup written to $OUT"
