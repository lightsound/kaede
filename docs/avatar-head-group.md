# ①d 頭グループ分離+髪・顔の着せ替え — 設計叩き台(第 1 ラウンド)

状態: **オーナー裁定待ち(2026-08-12)**。本実装(スキーマ変更・クライアント
配線)は裁定後の次ラウンド。①c の前例どおり、本ラウンドのコミットは本設計
文書+最小ベンチ(素材は R2 記録)+ベンチ用スクリプト
(`scripts/factory/bench_head_swap.py`)のみ。方式の土台は
[docs/avatar-rig.md](./avatar-rig.md) §2〜4・§7、資産規格は
[docs/asset-pipeline.md](./asset-pipeline.md) §2、増分の定義は
[ROADMAP Phase 5 ①d](./ROADMAP.md)。

## 0. スコープと①e との境界

- **①d**: `AvatarView` への `setSkin` 追加(素体シート切替 — girl 配線が
  即成立)+頭グループ分離(髪・顔=表情の 1 枚差し替え)+選択の永続化
  (account)。
- **①e**: コーデ単位の**全身シート**差し替え UI+持ち物スキーマ(安定 ID・
  account スコープ)。
- 境界の注意: 「素体切替」は機構としては全身シート差し替え(①e と同型)
  だが、girl 資産(walk 5 セル+gestures 12 セル — PR #105 まで工場出荷済み・
  未消費)の表示配線は一貫して①d の領分とされてきた。本叩き台は素体切替を
  ①d 段階 1、頭グループ分離を段階 2 として扱う(§4)。

## 1. 設計の前提(実測・実体確認済み)

- **committed 資産**: boy 素体 7 種(basic/red/pants ± carry)+
  boy gestures+headgear(ヘッドホン — boy stand からの差分抽出)。girl は
  walk 5 セル+gestures 12 セルが揃っていて未消費。
- **全シートは頭を体コマに焼き込み済み**。walk は stand 頭の
  erase-then-paste でピクセル同一だが、**dance は動画ネイティブ頭**
  (erase が首線を跨ぐ腕ごと消す — 構造不適合、factory-yield 2026-08-10
  ベンチ(b))、sit/sleep/wave も各テイクの頭。「全ポーズで頭を後付け合成
  できる」前提は成立しない。
- **ポーズ分類(本ベンチで sit/wave を実測し確定)**:
  | 分類 | ポーズ | 根拠 |
  | --- | --- | --- |
  | 頭合成可能 | stand・walk×4・**sit** | 首線より上に体パーツが入らない(sit は本ベンチで実測成立) |
  | native-head | **wave**・dance×8・sleep | wave は挙手が首線を跨ぎ erase が腕を消す(本ベンチ実測 — ①c の dance 実測と同型)。sleep は頭が横倒し(回転頭が必要 — headgear 非表示の前例) |
- **neckAnchors は全ポーズの manifest に記録済み**(sleep は設計上の近似)。
- **描画の現状**: シート束(base sheet+gesture kit+held)は
  `createGameApp` が一度ロードし全 `createPlayerView` に注入 — 「タブ内
  全員同じ見た目」が構造。①d はこれを「プレイヤーごとの look 解決」に
  変える(§4)。
- **fal replace レーンが既設**(①c 後続 — `replace_lane.py`+マスター台帳):
  「マスターテイク×identity 画像 1 枚」で振り付けを完全転写した新テイクを
  $0.20〜0.30/本で生成できる。native-head ポーズの髪替え対応(§5 案 N3)の
  道具はすでにある。

## 2. 最小ベンチ結果(2026-08-12、nano-banana-2 ×3 = $0.233 実測)

問い: **髪(顔)1 枚差し替えが「頭グループ絵の生成+neck 合成」でスタイル
忠実に成立するか**。方式は ①c ベンチ(a) の参照+指示(committed stand を
720px 緑キャンバスへ→keep-everything 編集→頭グループ抽出→committed セルの
manifest neck へ erase-then-paste)。再現は `bench_head_swap.py`(prepare /
composite)。

| テイク | 内容 | 結果 |
| --- | --- | --- |
| (a) 髪 boy | 金髪ショートボブ($0.082) | **一発成立**。stand/walk×4/sit の全コマに残渣ゼロ・首継ぎ目なし・頭ボビング追従(videoReview 検収) |
| (b) 顔 boy | 閉眼笑い($0.068) | **一発成立**。表情=頭グループ 1 枚差し替えで表現できることを確認 |
| (c) 髪 girl | ロングツインテール($0.083) | **成立(条件つき)**。スタイル忠実(チェリーピン保持)。首下に垂れる髪は「首上=全置換+首下=ベース差分(髪のみ)」の抽出で体の前面レイヤーに載る。**限界 2 つを記録**: 髪が硬直(揺れなし)・腕スイングが髪の後ろに隠れる(前面固定 z) — ゲームスケール(実表示 1/6)では許容と検収。初版の**首切れ(オーナー差し戻し)は component erase で解消**(下の付随実測) |

付随実測:

- **構造 neck 検出は長髪で壊れる**(①b(a)⑵ の hoodie-class の再現 —
  ツインテールが首の谷を埋める)。ただし keep-everything 編集は体が
  ピクセル同一なので、**ベース stand の実測 neck がそのまま転写でき、
  編集画像側の検出は不要**(ベンチスクリプトに実装済み — 工場レーン化
  してもこの規則で足りる)。
- **負例の可視化**: wave・dance-a に同じ合成を適用すると挙手・振り上げた
  腕が erase で消える(PR 添付のモンタージュ) — §5 の裁定が必要な理由の
  実物。
- **首切れとその解消(オーナー差し戻し 2026-08-12、原因は 2 つ)**:
  ①girl の walk-c(前傾ストライド)は**肩ラインが首行より上に上がる**
  ため、首行より上の全行 erase(walk 取り込みの paste_head 規則をセル
  スケールで実行)が肩を削り、頭グループのあご被覆(縮小後 ~3px)が
  届かず隙間が出た → **旧頭の連結成分だけを消す component erase**
  (首行の 60% より上へ届く成分=旧頭、肩の出っ張りは残す —
  `erase_old_head`)で解消。②全テイクに共通の主因は**自己マスク
  貼り付けのアルファ二乗劣化**: `paste(im, box, im)` は半透明画素の
  αを α²/255 に落とす(α86→29 実測)ため、体全体のアンチエイリアス
  輪郭が薄くなり、最も細い首の接合部が再生速度で「切れて」見えた
  (committed セル自体は画素連続 — 元は切れていない。取り込みラインの
  paste_head も同じ書き方だが、直後に緑へフラット化するため無害) →
  **alpha_composite に修正**。committed 元セルとの並走比較で全コマの
  首連続・輪郭濃度の一致を videoReview 再検収。**①d-2 の headless
  変種生成レーンは component erase と alpha_composite の両規則を
  引き継ぐこと。**
- **R3 への設計注意(同実測から)**: component erase は**首行より下の
  旧髪**(girl のボブの裾など)を消さない。本ベンチは差し替え髪が
  大きく覆ったため無害だったが、headless 変種の工場生成では「首下の
  旧髪も含む頭全体の除去」(ベース差分のフルマスク等)が必要 — 小さい
  髪への差し替えで旧髪の裾が残る穴を①d-2 で塞ぐ。
- R2 記録(kaede-asset-originals、content-addressed。key = `originals/<sha256>`):
  - ボブ `312440472f4694ba8232d35b1024a75056938cfef8374cb09418fd6a7e9e3e6d`
  - 閉眼笑い `3e368d04f71c257cf661bff4d4011104f653227296943312e7dcf6eb72bc8848`
  - ツインテール `ab836a3aacc4cb370de5256cc69fc83b4e0979573e463240da2e18b1ad305867`
- **含意**: 「髪 N 種=nano 編集 N 回($0.09/枚)+機械抽出」の工場が
  頭合成可能ポーズについて成立。ポーズ数と独立(avatar-rig.md §2 の
  足し算の実証)。

## 3. 論点 1 — 頭グループの資産構造(分離粒度)

| 案 | 構造 | 評価 |
| --- | --- | --- |
| **H1: 頭グループ=1 枚絵**(頭+髪+顔を焼き込んだ 1 レイヤー) | 着せ替え単位は頭グループ丸ごと。「髪 20 種=画像 20 枚」(既定顔)。表情違いは別の頭グループ画像 | **推奨**。抽出・manifest・描画とも 1 レイヤーで最小。生成 $0.09/枚なので髪×顔の掛け算も安い。ベンチ (a)(b) がこの形 |
| H2: 頭ベース+髪+顔の 3 レイヤー(本家準拠) | 真の足し算 | 髪と顔の相互レジストレーション(前髪と目の重なり等)の規格化が必要で未検証。H1 から additive に拡張可能(manifest はどちらも表現できる)なので、顔バリエーションの実需が出てから |

## 4. 論点 2 — 描画方式: 段階案 vs 一括案

### 段階 1: `setSkin` の最小形=素体シート切替(girl 配線が即成立)

`AvatarView` に `setSkin(skinId)` を切り、シート解決を「タブ共有の 1 束」
から「skinId → シート束(base sheet+gesture kit+per-pose anchors)」の
解決に変える。girl は committed 資産の消費だけで表示でき、**頭グループ
分離なしで出荷できる**。実装形の要点:

- シート束のロードは skin ごとの遅延 import(`loadRedSheet` の前例)+
  ロード完了までは既定シートで描画(look はいつでも後から届く行イベント)。
- headgear(busy)はポーズの neck に乗る共有オーバーレイのまま。girl 用の
  ヘッドホン差分抽出は §6。
- studio.package の試着ステージ(dressup.ts)は同じ解決規則を共用。

### 段階 2: 頭グループ分離(髪・顔 1 枚差し替え)

| 案 | 方式 | 評価 |
| --- | --- | --- |
| R1: ランタイム重ね描き(headgear の拡張) | 体セルは頭付きのまま、頭グループを neck に重ねる | **棄却**。旧頭が新頭の輪郭外にはみ出す(paste-alone の二重頭 — PR #94 実測)。「頭グループが既定頭を完全被覆する」制約は髪デザインを縛る |
| R2: 工場ベイク(look ごとに全シート焼き直し・同梱) | 組合せをビルド成果物に展開 | スキン×髪×ポーズの掛け算がバンドルに乗る。全クライアントが他人の任意 look を描く必要があるため同梱は肥大の一途 — DP-1(R2 配信)前提の規模で破綻。棄却寄り |
| **R3: headless 体セル+ランタイム neck 合成**(本家準拠) | 工場が頭合成可能ポーズの「頭なし」変種セルを機械生成(erase 側だけ実行 — $0)し、ランタイムは 体(headless)→首下髪→頭グループ の合成 | **推奨**。組合せは足し算のまま。ベンチの合成規則(首上全置換+首下差分)がそのまま headless 化+頭グループ資産の抽出レーンになる。native-head ポーズの扱いは論点 3 |

**推奨は段階案(段階 1 → 裁定後に段階 2=R3)**。一括案(段階 1+2 を
1 増分)は論点 3 の裁定と頭グループ資産クラスの整備が全部先に必要で、
girl 配線(committed 資産の消費・実需シグナルへの最短の応答)まで
道連れにする。段階 1 はスキーマも段階 2 と共有できる(§7 — 列を最初から
2 本 additive に切っておけば再 publish 不要)。

## 5. 論点 3 — native-head ポーズ(dance×8・wave・sleep)の扱い

髪・顔を替えたプレイヤーがダンス・wave・sleep したとき、頭合成できない
セルに何を描くか。①d の設計整合の本丸。

| 案 | 方式 | 評価 |
| --- | --- | --- |
| N1: 既定 look へフォールバック | native-head ポーズ中は素体既定のセルをそのまま描く(髪替えがダンス中だけ元に戻る) | 実装ゼロ・違和感は明白。**暫定としては許容**: gesture は一時的・96px・回転中の頭は判別しづらい |
| N2: 頭グループを重ねる | ダンス中も stand 用頭グループを neck に重ねる | 棄却(R1 と同じ二重頭。ダンスは頭の向き・傾きが毎コマ違い被覆保証もない) |
| **N3: fal replace レーンで look ごとに再生成** | マスターテイク×「髪替え済み stand」identity 画像 → 新テイク → gesture シート再構成(既設の `replace_lane.py`+`compose_gesture_sheet.py`) | **推奨(工場の運転として順次)**。振り付け完全転写・$0.20〜0.30/本+sit/sleep/wave は nano $0.09×3。look 1 種あたり合計 ~$0.6・機械。掛け算(look×gesture)を工場が負い、ランタイムは足し算のまま |

**推奨は N1 で出荷し N3 で順次埋める**: manifest 駆動なので「この look の
gesture シートの有無」をカタログが知っていて、無ければ N1 フォールバック、
届けば自動で使われる(アセット=データの不変条件 — コード変更なしで
埋まっていく)。全 look の gesture シートを揃えるまで①d を止めない。

## 6. 論点 4 — headgear(ヘッドホン)の girl・頭グループ対応

- **girl 対応**: `extract_headgear.py` の前例流用 — girl stand への着用編集
  (nano $0.10)+差分抽出で `item.headphones-girl` 級を 1 発。boy 用の
  流用(grip=boy stand neck 実測)は頭サイズ・髪形状が違うため非推奨。
  **実施時期は段階 1(girl 配線)と同時**が自然: girl 表示が入った瞬間に
  「取り込み中の girl」が視覚化対象になる。
- **頭グループとの相互作用**: headgear は「ポーズの neck に乗る前面
  オーバーレイ」のまま変えない。髪が大きい頭グループ(ツインテール等)
  では装着位置の見た目が変わり得るが、MVP は共通 grip で許容し、実測で
  問題が出たら manifest に per-head-group grip オーバーライドを additive に
  足す(neckAnchors オーバーライドの前例)。

## 7. 論点 5 — スキーマ案(選択の永続化)

前例: `player_name`(低頻度公開行・join/変更時のみ書く)+
`account.displayName`(join 時復元)+ 専用ガード(`status_guard` 系)。
additive のみ・E2E から SQL シード可能(timestamp 列なし)を守る。

### 案 S1(推奨): 新テーブル `player_avatar`+account 列追加

```
player_avatar(公開): identity PK / skin string / headGroup string
  - 行がなければ全既定(missing-row default — player_status の前例)。
    既定は '' ではなく行の不在で表現し、初期行の挿入は不要
  - 低頻度(join/着せ替え時のみ)・removePlayer で掃除(player_name と同寿命)
  - 段階 1 は skin だけ書く。headGroup 列も最初から切っておく(additive の
    再 publish を 1 回に畳む — 段階 2 で列追加の publish を挟まない)
account: avatarSkin / avatarHead を default '' で末尾追加
  - optional は移行拒否の実測があるため default ''(subject 列の前例)。
    '' = 未設定。メンバーの join 時に player_avatar 行へ復元
    (displayName の前例)。ゲストはタブ限り(player_name の前例)
reducer set_avatar(skin, headGroup):
  - 資格 = チャット系と同一(in-world player 行+admission 再検証)
  - 検証は**形式検証**(isAssetIdLike — 接頭辞・長さ・文字クラスの
    完全一致級の純関数)であって実在検証ではない: アセットの正は
    client 側 manifest で、サーバーに ID 台帳を持たせると「アセット追加に
    コード変更(publish)を要しない」不変条件(asset-pipeline §5)が壊れる。
    未知 ID はクライアントが既定 look で描画(unknown-kind の前例)
  - 専用バケット avatar_guard(公開行を書く呼び出し — status_guard の前例)
```

- 表示は行イベント+seed の両方から(look は状態 — player_status の規約)。
- ①e との整合: `skin`/`headGroup` は「装着中」を表す列で、①e の持ち物
  (account スコープの belongings テーブル)は additive に後付けできる。
  MVP は全部無料開放(VISION)なので所有検証はまだ無い。

### 案 S2: `player_name` に列追加

`skin`/`headGroup` を default '' で `player_name` に足す(mapId/online の
additive 前例)。テーブル・購読・掃除が増えない利点はあるが、
①「在席ディレクトリ」への関心の混入(DM 候補・presence の読者に look が
無関係)②rename・online 反転のたびに look 込みの行が再配信 ③①e の
belongings と規約が揃わない、で S1 に劣後。

### 案 S3: account のみ(公開行なし)

他クライアントが look を読めないため不可(記載のみ)。

## 8. 増分分割の提案(裁定後の実装ラウンド)

1. **①d-1(段階 1)**: スキーマ S1(2 列とも)+`setSkin`+skin 解決の
   プレイヤー別化+girl 配線+選択 UI(最小)+girl headgear 抽出+
   E2E(2 ブラウザ: 切替が相手に届く・リロード/再入場で復元・ゲストは
   タブ限り)。ベンチ不要 — committed 資産の消費のみ。
2. **①d-2(段階 2=R3)**: 頭グループ資産クラス(`head-group` manifest —
   asset-pipeline §2 に既定義)+抽出レーン(本ベンチのスクリプト昇格:
   keep-everything 編集→首上全置換+首下差分→headless 変種セル生成)+
   `AvatarView` の頭合成描画+headGroup 選択 UI。native-head は N1
   フォールバックで出荷。
3. **工場の運転(増分外)**: look ごとの gesture シートを N3(replace
   レーン)で順次生成(~$0.6/look)。headgear の per-head-group grip は
   実測次第。

## 9. 実装時の注意(fallow・境界)

- 新規 shared 語彙(`isAssetIdLike` 等)は**既存ファイル同居**
  (①c が語彙を reaction.ts に同居させた前例 — 型カップリング証跡は
  40 エッジ上限ちょうど)。
- skin→シート束の解決は game.package 内(assetCatalog の
  import.meta.glob 前例)に閉じ、studio.package は index 経由で共用。
- 新規ファイルで単体テスト不能なもの(描画配線)は `fallow-ignore-file
  coverage-gaps` ヘッダー+テスト可能ロジックの所在を明記(AGENTS.md)。
- bindings 再生成時は spacetimedb-cli 2.8.0 を確認(VM に 2.7.0 が
  preinstall されている実測 — AGENTS.md)。
