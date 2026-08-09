# アセットファクトリー運転手順（Phase 5 ①b）

状態: **①b 本体で整備**（前提 ⑴〜⑷ 完了済み）。規格の憲法は
[asset-pipeline.md](./asset-pipeline.md)、歩行レシピは
[avatar-rig.md](./avatar-rig.md) と ROADMAP ①b(c)/(a)⑵。

## 目標状態

**発注書（`order.json`）を書けば、コードを触らずにアセットが増える。**
人のゲートは検品ビューア（`/assets`）での目視 1 回と、シート画像が見える PR
のオーナー承認だけ。

## 工程

| # | 工程 | 実装 |
| --- | --- | --- |
| 1 | 発注書 | `game.package/<dir>/order.json`。`template` + `vars` で種別テンプレを展開（直書き `prompt` も可） |
| 2a | 立ちコマ生成 | `google/nano-banana-2` ＋ 基準リファレンス（`canonical/`） |
| 2b | 歩行動画 | `alibaba/wan-2.7-i2v`（誇張スイング。carry は腕固定プロンプト） |
| 2c | コマ位相選定 | `scripts/factory/foot_phase.py` — 足位置の構造解析で contact/pass を自動選定 |
| 2d | 頭部合成 | stand の頭部を各 walk コマの neck へ合成（動画の頭部揺れを潰す） |
| 2e | シート組立 | 5 コマ横一列のグリーンバックシート → `sheet-original.png` |
| 3 | 取り込み | `scripts/import-avatar-sheet.py`（R2 原本解決込み） |
| 4 | アート lint | 構造ベースのアンカー乖離・寸法・残渣・**ベース服とのパレットコントラスト** |
| 5 | アトラス化 | AssetPack（`pnpm assets:pack`）— ビルド派生物。正は個別 PNG |
| 6 | 原本アップロード | `scripts/upload-asset-originals.py` → R2 `kaede-asset-originals` |
| 7 | PR | 取り込み結果 PNG が見える PR → オーナー目視 |

運転の入口:

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
python3 scripts/factory/run_avatar.py packages/client/src/game.package/<dir>/order.json
python3 scripts/upload-asset-originals.py packages/client/src/game.package/<dir>/order.json
pnpm assets:pack   # 任意・アトラス派生物の確認
```

歩留まり・コスト・所要時間は各通し運転のたびに
[factory-yield.md](./factory-yield.md) へ追記する（DP-B の判定材料）。

## 量産で守る製品ルール

- 女の子のデフォルトコーデは**パンツ一丁ではなく上のインナーを着用**
  （オーナー指定 2026-08-09）
- 男の子のパンツ一丁ベースコーデを 1 着持ち、検品ビューア試着ステージの
  **デフォルト**にする
- 歩行は wan-2.7-i2v 採用ライン（誇張スイング＋立ちコマ頭部の neck 合成）

## アート lint（①b(a)⑵ の穴への構造対応）

1. **neck**: 色（肌ブロブ）ではなく、シルエット幅プロファイルの
   「頭ピーク → くびれ → 胴ピーク」構造で検出。フード等で最細行ヒューリスティック
   が腰へ落ちる失敗を機械で弾く
2. **hand**: 携带（carry）は腰前の手前側突起、swing は発注書オーバーライド優先
3. **パレット**: ベース服（既定 `avatar.boy-basic`）の主要色との最小距離が
   閾値未満なら不合格（白いアイテムが白シャツに溶ける実測への対応）
