// fallow-ignore-file coverage-gaps -- DOM shell of the dev-only asset studio; manifest parsing and the pose diff live in catalog.ts and the walk cadence in game.package/rig.ts, both unit-tested
import { MOVE_SPEED } from '@kaede/shared';
import { type CSSProperties, useEffect, useState } from 'react';
import { advanceWalk, IDLE_WALK_STATE, loadAssetModules } from '../game.package';
import { UI_GOLD, UI_GOLD_BORDER_SOFT, UI_PANEL_BG, UI_TEXT_COLOR } from '../theme';
import { AvatarCard, CompareStrip, GestureCard, ItemCard, SectionHeading } from './cards';
import { type AssetCatalog, buildCatalog } from './catalog';
import { resolveStageLook } from './dressup';
import { DressUpStage } from './stage';

// The game shell disables document scrolling (index.html: html/body are
// overflow:hidden for the canvas), so the studio root is its own scroll
// container — height-bound with overflow auto — instead of relying on the
// page to scroll.
const pageStyle: CSSProperties = {
  height: '100vh',
  overflowY: 'auto',
  background: '#10131b',
  color: UI_TEXT_COLOR,
  fontFamily: 'sans-serif',
  fontSize: 13,
  padding: '20px 28px 48px',
  boxSizing: 'border-box',
};

const summaryStyle: CSSProperties = {
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER_SOFT,
  borderRadius: 8,
  padding: '10px 14px',
  display: 'grid',
  gap: 6,
  marginBottom: 12,
};

const gridStyle: CSSProperties = { display: 'grid', gap: 12 };

const itemGridStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
};

/**
 * The shared walk clock: a virtual avatar walking at MOVE_SPEED drives the
 * SAME rig rules the game renders with (advanceWalk via the game.package
 * index), so the preview cadence and intensity ease are the in-game
 * cadence by construction. It yields the WALK STATE rather than one pose
 * name: sheets differ in frame density since the A-3 densification (12
 * dense / 4 legacy carry-light), so each card derives its own frame from
 * the shared phase (walkPoseOf) — same phase, per-sheet frame, which is
 * what keeps the comparison strip a comparison. Paused yields idle.
 */
function useWalkClock(playing: boolean): { phase: number; intensity: number } {
  const [walk, setWalk] = useState<{ phase: number; intensity: number }>(IDLE_WALK_STATE);
  useEffect(() => {
    if (!playing) {
      setWalk(IDLE_WALK_STATE);
      return;
    }
    let state: { phase: number; intensity: number } = IDLE_WALK_STATE;
    let last: number | undefined;
    let cancelled = false;
    let raf = requestAnimationFrame(function tick(now: number) {
      if (cancelled) return;
      const dt = last === undefined ? 0 : Math.min(now - last, 100);
      last = now;
      state = advanceWalk(state, (MOVE_SPEED * dt) / 1000, dt);
      setWalk(state);
      raf = requestAnimationFrame(tick);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [playing]);
  return walk;
}

/** The roster-wide inspection summary: counts, pose vocabulary, gaps, integrity findings. */
function SummaryBar(props: { catalog: AssetCatalog }) {
  const { catalog } = props;
  const gaps = catalog.avatars.filter((avatar) => avatar.missingPoses.length > 0);
  return (
    <div style={summaryStyle}>
      <div>
        キャラクター {catalog.avatars.length} 体 ／ アイテム {catalog.items.length} 点 ／
        ポーズ語彙: {catalog.poseUnion.join(' · ')}
      </div>
      <div data-testid="missing-summary" style={{ color: gaps.length > 0 ? '#e8a2a2' : '#9ec07c' }}>
        {gaps.length === 0
          ? '✓ ポーズ欠落なし — 全キャラクターがポーズ語彙を満たしています'
          : gaps
              .map((avatar) => `⚠ ${avatar.id}: ${avatar.missingPoses.join(', ')} が欠落`)
              .join(' ／ ')}
      </div>
      {catalog.problems.length > 0 && (
        <ul data-testid="problems" style={{ color: '#e8a2a2', margin: 0, paddingLeft: 18 }}>
          {catalog.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The playback / anchor-marker controls row. */
function Controls(props: {
  playing: boolean;
  onPlayingChange: (on: boolean) => void;
  showAnchors: boolean;
  onShowAnchorsChange: (on: boolean) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'center', marginBottom: 12 }}>
      <button
        type="button"
        data-testid="playback-toggle"
        onClick={() => props.onPlayingChange(!props.playing)}
        style={{
          background: 'rgba(216, 166, 87, 0.15)',
          color: UI_TEXT_COLOR,
          border: UI_GOLD_BORDER_SOFT,
          borderRadius: 6,
          padding: '4px 12px',
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        {props.playing ? '⏸ 歩行再生を停止' : '▶ 歩行再生を開始'}
      </button>
      <label style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={props.showAnchors}
          onChange={(e) => props.onShowAnchorsChange(e.target.checked)}
        />{' '}
        アンカー表示（neck / hand / grip）
      </label>
    </div>
  );
}

/**
 * The read-only asset inspection viewer (Phase 5 ①b⑷ / ROADMAP ①b(b)):
 * every character × every pose from the bundled manifests, live walk
 * playback on the real rig cadence, side-by-side comparison, and the
 * missing-pose detection. Renders only what ships in the bundle — no
 * SpacetimeDB connection, no writes; the ordering console the roadmap
 * plans next lands as a sibling view in this package.
 */
export function AssetStudio() {
  const [catalog, setCatalog] = useState<AssetCatalog>();
  const [playing, setPlaying] = useState(true);
  const [showAnchors, setShowAnchors] = useState(false);
  const [compareIds, setCompareIds] = useState<readonly string[]>([]);
  // The try-on selections (owner feedback 2026-08-09): which outfit sheet
  // the stage wears and which item it holds. Page state only — the studio
  // stays read-only.
  const [outfitId, setOutfitId] = useState<string>();
  const [heldItemId, setHeldItemId] = useState<string>();
  const walk = useWalkClock(playing);

  useEffect(() => {
    let cancelled = false;
    void loadAssetModules().then(({ manifests, imageUrls }) => {
      if (!cancelled) setCatalog(buildCatalog(manifests, imageUrls));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!catalog) return <div style={pageStyle}>アセットを読み込んでいます…</div>;
  const compared = catalog.avatars.filter((avatar) => compareIds.includes(avatar.id));
  const toggleCompare = (id: string, on: boolean) =>
    setCompareIds((ids) => (on ? [...ids, id] : ids.filter((existing) => existing !== id)));
  const look = resolveStageLook(catalog, outfitId, heldItemId);
  const toggleItem = (id: string) => setHeldItemId((held) => (held === id ? undefined : id));
  return (
    <main style={pageStyle} data-testid="asset-studio">
      <h1 style={{ fontSize: 18, margin: '0 0 12px', color: UI_GOLD }}>
        アセット検品ビューア
        <span style={{ fontSize: 12, opacity: 0.6, marginLeft: 12 }}>
          読み取り専用 — 同梱アセットの manifest 駆動一覧（dev ビルド限定）
        </span>
      </h1>
      <SummaryBar catalog={catalog} />
      <Controls
        playing={playing}
        onPlayingChange={setPlaying}
        showAnchors={showAnchors}
        onShowAnchorsChange={setShowAnchors}
      />
      {look && (
        <>
          <SectionHeading>試着ステージ（服と持ち物をクリックで着せ替え）</SectionHeading>
          <DressUpStage
            catalog={catalog}
            look={look}
            walk={walk}
            onSelectOutfit={setOutfitId}
            onToggleItem={toggleItem}
          />
        </>
      )}
      {compared.length > 0 && (
        <>
          <SectionHeading>比較（同位相で再生中）</SectionHeading>
          <CompareStrip avatars={compared} walk={walk} showAnchors={showAnchors} />
        </>
      )}
      <SectionHeading>キャラクター（avatar-body）</SectionHeading>
      <div style={gridStyle}>
        {catalog.avatars.map((avatar) => (
          <AvatarCard
            key={avatar.dir}
            avatar={avatar}
            walk={walk}
            showAnchors={showAnchors}
            compared={compareIds.includes(avatar.id)}
            onCompare={(on) => toggleCompare(avatar.id, on)}
          />
        ))}
      </div>
      <SectionHeading>ジェスチャーシート（avatar-gesture — ①c）</SectionHeading>
      <div style={gridStyle}>
        {catalog.gestures.map((avatar) => (
          <GestureCard key={avatar.dir} avatar={avatar} showAnchors={showAnchors} />
        ))}
      </div>
      <SectionHeading>手持ちアイテム（held-item）</SectionHeading>
      <div style={itemGridStyle}>
        {catalog.items.map((item) => (
          <ItemCard key={item.dir} item={item} showAnchors={showAnchors} />
        ))}
      </div>
      <SectionHeading>ヘッドギア（headgear — 取り込み中の視覚化）</SectionHeading>
      <div style={itemGridStyle}>
        {catalog.headgear.map((item) => (
          <ItemCard key={item.dir} item={item} showAnchors={showAnchors} testId="headgear-card" />
        ))}
      </div>
    </main>
  );
}
