// fallow-ignore-file coverage-gaps -- DOM shell of the dev-only asset studio; manifest parsing and the pose diff live in catalog.ts and the walk cadence in game.package/rig.ts, both unit-tested
import { MOVE_SPEED } from '@kaede/shared';
import { type CSSProperties, useEffect, useState } from 'react';
import { advanceWalk, IDLE_WALK_STATE, loadAssetModules, selectPose } from '../game.package';
import { UI_GOLD, UI_GOLD_BORDER_SOFT, UI_PANEL_BG, UI_TEXT_COLOR } from '../theme';
import { AvatarCard, CompareStrip, ItemCard, SectionHeading } from './cards';
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
 * SAME rig rules the game renders with (advanceWalk/selectPose via the
 * game.package index), so the preview cadence — 200ms per frame at 240
 * px/s, intensity ease included — is the in-game cadence by construction,
 * and every card animates in the same phase (what makes the comparison
 * strip a comparison). Paused shows stand, the rig's idle pose.
 */
function useWalkPose(playing: boolean): string {
  const [pose, setPose] = useState('stand');
  useEffect(() => {
    if (!playing) {
      setPose('stand');
      return;
    }
    let walk = IDLE_WALK_STATE;
    let last: number | undefined;
    let cancelled = false;
    let raf = requestAnimationFrame(function tick(now: number) {
      if (cancelled) return;
      const dt = last === undefined ? 0 : Math.min(now - last, 100);
      last = now;
      walk = advanceWalk(walk, (MOVE_SPEED * dt) / 1000, dt);
      setPose(selectPose(walk));
      raf = requestAnimationFrame(tick);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [playing]);
  return pose;
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
  const pose = useWalkPose(playing);

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
            pose={pose}
            onSelectOutfit={setOutfitId}
            onToggleItem={toggleItem}
          />
        </>
      )}
      {compared.length > 0 && (
        <>
          <SectionHeading>比較（同位相で再生中）</SectionHeading>
          <CompareStrip avatars={compared} pose={pose} showAnchors={showAnchors} />
        </>
      )}
      <SectionHeading>キャラクター（avatar-body）</SectionHeading>
      <div style={gridStyle}>
        {catalog.avatars.map((avatar) => (
          <AvatarCard
            key={avatar.dir}
            avatar={avatar}
            pose={pose}
            showAnchors={showAnchors}
            compared={compareIds.includes(avatar.id)}
            onCompare={(on) => toggleCompare(avatar.id, on)}
          />
        ))}
      </div>
      <SectionHeading>手持ちアイテム（held-item）</SectionHeading>
      <div style={itemGridStyle}>
        {catalog.items.map((item) => (
          <ItemCard key={item.dir} item={item} showAnchors={showAnchors} />
        ))}
      </div>
    </main>
  );
}
