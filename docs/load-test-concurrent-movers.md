# 同時移動の負荷実測（ローカル standalone）

VISION の MVP ターゲットは同時接続 最大〜50 人。20〜30 人が同じマップで
歩き続けても体感が落ちないか、50 人だとどうなるかを、ローカル
SpacetimeDB 上で測った記録。測定日 2026-08-18。

Maincloud の TeV と日本からの RTT は対象外（ドッグフーディング
[§6](./dogfooding.md) のまま）。この数字は「移動同期が重くて使えないか」
への答えで、ビデオ通話の同時人数は別コスト。

## 条件

最悪寄り。全員が同じマップ（既定マップ）にいて、動かす側は本番と同じ
WebSocket + `submit_inputs`（400ms に 24 tick、目標 2〜3 calls/秒/人）。
観測は本物の Chromium 1 つ（メンバーが見る側）。移動側はヘッドレス
ゲスト。描画は SwiftShader（この VM に GPU が無い）。

| 項目 | 値 |
| --- | --- |
| ホスト | 4 vCPU / 16 GiB、SpacetimeDB CLI 2.8.0 standalone |
| 観測 | Playwright Chromium、1280×720、`?perf=1` |
| 移動 | 左右パトロール、端で折り返し、20 秒サンプリング |
| レンダラ | ANGLE + SwiftShader（GPU なし） |

再現:

```sh
spacetimedb-cli start
spacetimedb-cli publish kaede --server local --yes
pnpm --filter @kaede/client dev
node packages/e2e/measure-concurrent-movers.mjs --count 50 --movers 50 --seconds 20 --label 50_all_moving
```

`--movers` を `--count` より小さくすると、接続だけして歩かないゲストを混ぜられる。
開発クライアントは `?perf=1` で FPS / remotes / 行更新レート / x-spread の HUD を出す。

## 結果

| 条件 | remotes | FPS mean / min | 行更新/秒 | ホスト CPU（1コア%） | ack p50 / p99 / max | stalled / resends |
| --- | --- | --- | --- | --- | --- | --- |
| 20 人全員移動 | 20 | 60.0 / 59.7 | ~50 | 4.7% | 2 / 4 / 6 ms | 0 / 0 |
| 30 人全員移動 | 30 | 60.0 / 60.0 | ~75 | 7.6% | 2 / 5 / 7 ms | 0 / 0 |
| 50 人全員移動 | 50 | 60.0 / 59.8 | ~125 | 13.8% | 2 / 7 / 11 ms | 0 / 0 |
| 50 接続・12 人移動 | 50 | 60.0 / 59.9 | ~30 | 4.9% | 2 / 7 / 13 ms | 0 / 0 |

移動中の flush はどのランも約 2.4 batches/秒/人（目標 2〜3。当時の分母は
入場の stagger と観測後の尾を含んでおり、24 tick / 400ms = 2.5 よりやや低い）。
standalone の RSS は
110〜132 MB。観測側の x-spread は時間とともに広がっており、スプライトは止まっていない。

50 接続・12 人移動は、オフィス用途の「在席の約 25% が歩く」という Phase 2
試算と同じ割合。行更新は全員移動の約 1/4、ホスト CPU は 20 人全員移動と同程度。

## 判断

20〜30 人が同時に歩いても、このスタックでは描画 60fps も ack 数 ms も余裕がある。
50 人全員が歩き続けても同じ。ホスト CPU は 50 人全員移動で 1 コアの約 14% で、
サーバー権威物理がこの人数で飽和する兆しは出ていない。

日常のオフィスは全員が歩き続けない。50 人在席・12 人移動なら、負荷は 20 人
全員移動と同じ帯に戻る。アイドル抑制（静止中 0）が効いている証拠でもある。

ローカルホストなので RTT は数 ms。本番 Maincloud は日本から +150〜200ms 程度
乗る想定で、補間遅延 550ms がその吸収用。体感の「重い」が RTT 由来なら、
この数字ではなくドッグフーディングの日本回線測定が先。TeV も同様で、
CPU 命令数が Maincloud で支配項になって初めて、クライアント権威＋サーバー側
クランプへの縮退を再検討する（ROADMAP Phase 2）。

この VM の描画は SwiftShader。実ユーザーの GPU なら描画はさらに楽なはずで、
ここで落ちていないことが下限側の証拠になる。ビデオ通話（RealtimeKit）を
50 人同時に始めた場合のコストは、このプローブの対象外。
