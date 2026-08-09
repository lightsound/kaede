// fallow-ignore-file coverage-gaps -- DOM cards for the dev-only asset studio; the catalog they render (parsing, pose diff, integrity checks) lives in catalog.ts, which is unit-tested
import type { CSSProperties, ReactNode } from 'react';
import { UI_GOLD, UI_GOLD_BORDER_SOFT, UI_PANEL_BG, UI_TEXT_COLOR } from '../theme';
import type { AssetFrame, AvatarAsset, ItemAsset } from './catalog';
import { frameFor, maxFrameSize } from './dressup';

/**
 * Anchor marker colors by anchor name (neck/hand from avatar-body poses,
 * grip from held-item frames and hand layers); unknown names fall back to
 * the kaede gold.
 */
const ANCHOR_COLORS: Record<string, string> = {
  neck: '#7aa2f7',
  hand: '#f2777a',
  grip: '#9ec07c',
};

const cardStyle: CSSProperties = {
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER_SOFT,
  borderRadius: 8,
  padding: 12,
  color: UI_TEXT_COLOR,
};

const cardHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 12,
  marginBottom: 8,
};

const idStyle: CSSProperties = { marginLeft: 8, opacity: 0.6, fontSize: 12 };

const missingBadgeStyle: CSSProperties = {
  color: '#e8a2a2',
  border: '1px solid rgba(232, 162, 162, 0.5)',
  borderRadius: 4,
  padding: '2px 8px',
  marginBottom: 8,
  fontSize: 12,
  display: 'inline-block',
};

const missingBoxStyle: CSSProperties = {
  width: 52,
  height: 96,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px dashed #e8a2a2',
  color: '#e8a2a2',
  fontSize: 11,
};

const captionStyle: CSSProperties = { fontSize: 11, opacity: 0.7, marginTop: 4 };

const figureStyle: CSSProperties = { margin: 0, textAlign: 'center' };

/** The pixel-exact img sizing: `scale` × the manifest size, or natural when the size is absent. */
function frameImageStyle(size: AssetFrame['size'], scale: number): CSSProperties {
  const [w, h] = size ?? [undefined, undefined];
  return {
    imageRendering: 'pixelated',
    width: w === undefined ? undefined : w * scale,
    height: h === undefined ? undefined : h * scale,
  };
}

/** The anchor-point overlay dots, positioned at the manifest coordinates. */
function AnchorMarkers(props: { anchors: AssetFrame['anchors']; scale: number }) {
  return (
    <>
      {Object.entries(props.anchors).map(([name, [x, y]]) => (
        <span
          key={name}
          title={`${name} (${x}, ${y})`}
          style={{
            position: 'absolute',
            left: x * props.scale - 3,
            top: y * props.scale - 3,
            width: 6,
            height: 6,
            borderRadius: 999,
            background: ANCHOR_COLORS[name] ?? UI_GOLD,
            boxShadow: '0 0 0 1px #000',
          }}
        />
      ))}
    </>
  );
}

/**
 * One manifest-referenced frame at `scale` × source pixels (the sources
 * ship at 2x display resolution, so scale 1 already doubles the in-game
 * size — the point of an inspection view). Anchor markers overlay at the
 * manifest coordinates when enabled; a frame whose PNG is absent renders
 * as a labeled hole instead of a broken image.
 */
function FrameImage(props: {
  frame: AssetFrame;
  scale: number;
  showAnchors: boolean;
  alt: string;
}) {
  const { frame, scale, showAnchors, alt } = props;
  if (frame.url === undefined) return <span style={missingBoxStyle}>PNG なし</span>;
  return (
    <span style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
      <img src={frame.url} alt={alt} style={frameImageStyle(frame.size, scale)} />
      {showAnchors && <AnchorMarkers anchors={frame.anchors} scale={scale} />}
    </span>
  );
}

/** The identity row every card starts with: display name, stable id, optional trailing controls. */
function CardHeader(props: { name: string; id: string; children?: ReactNode }) {
  return (
    <header style={cardHeaderStyle}>
      <span>
        <strong>{props.name}</strong>
        <code style={idStyle}>{props.id}</code>
      </span>
      {props.children}
    </header>
  );
}

/**
 * A fixed box that grounds its frame at the bottom edge: every preview
 * reserves the sheet's largest frame footprint (maxFrameSize) so a pose
 * swap can never resize the layout — the frames' ground baseline is their
 * bottom edge (the import-line rule), exactly like the in-game AABB
 * anchoring. The fix for the owner's 横揺れ feedback (2026-08-09).
 */
export function groundBoxStyle(size: readonly [number, number], scale: number): CSSProperties {
  return {
    width: size[0] * scale,
    height: size[1] * scale,
    display: 'inline-flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  };
}

/** The animated figure driven by the shared walk clock (data-pose carries the shown frame). */
function WalkPreview(props: { avatar: AvatarAsset; pose: string; showAnchors: boolean }) {
  const { avatar, pose, showAnchors } = props;
  const resolved = frameFor(avatar, pose);
  if (!resolved) return <span style={missingBoxStyle}>ポーズなし</span>;
  return (
    <span
      data-testid="walk-preview"
      data-pose={resolved.pose}
      style={groundBoxStyle(maxFrameSize(avatar), 2)}
    >
      <FrameImage
        frame={resolved.frame}
        scale={2}
        showAnchors={showAnchors}
        alt={`${avatar.id} 歩行再生`}
      />
    </span>
  );
}

function anchorCaption(frame: AssetFrame): string {
  const anchors = Object.entries(frame.anchors)
    .map(([name, [x, y]]) => `${name} (${x},${y})`)
    .join(' ');
  const size = frame.size ? `${frame.size[0]}×${frame.size[1]}` : '';
  return [size, anchors].filter((part) => part !== '').join(' ');
}

/** One avatar-body: identity, walk playback, every pose cell, the pose-gap badge. */
export function AvatarCard(props: {
  avatar: AvatarAsset;
  pose: string;
  showAnchors: boolean;
  compared: boolean;
  onCompare: (on: boolean) => void;
}) {
  const { avatar, pose, showAnchors, compared, onCompare } = props;
  return (
    <section style={cardStyle} data-testid="avatar-card" data-asset-id={avatar.id}>
      <CardHeader name={avatar.name} id={avatar.id}>
        <label style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={compared} onChange={(e) => onCompare(e.target.checked)} />{' '}
          比較に追加
        </label>
      </CardHeader>
      {avatar.missingPoses.length > 0 && (
        <div style={missingBadgeStyle} data-testid="missing-badge">
          ⚠ 欠落ポーズ: {avatar.missingPoses.join(', ')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <figure style={figureStyle}>
          <WalkPreview avatar={avatar} pose={pose} showAnchors={showAnchors} />
          <figcaption style={captionStyle}>歩行再生</figcaption>
        </figure>
        {avatar.poses.map(({ pose: name, frame }) => (
          <figure key={name} style={figureStyle} data-testid="pose-frame">
            <span style={groundBoxStyle(maxFrameSize(avatar), 1)}>
              <FrameImage
                frame={frame}
                scale={1}
                showAnchors={showAnchors}
                alt={`${avatar.id} ${name}`}
              />
            </span>
            <figcaption style={captionStyle}>
              {name}
              <br />
              {anchorCaption(frame)}
            </figcaption>
          </figure>
        ))}
        {avatar.handLayer && (
          <figure style={figureStyle} data-testid="hand-layer">
            <FrameImage
              frame={avatar.handLayer}
              scale={2}
              showAnchors={showAnchors}
              alt={`${avatar.id} handLayer`}
            />
            <figcaption style={captionStyle}>
              handLayer
              <br />
              {anchorCaption(avatar.handLayer)}
            </figcaption>
          </figure>
        )}
      </div>
    </section>
  );
}

/** The side-by-side comparison row: every checked avatar in the same walk phase. */
export function CompareStrip(props: {
  avatars: readonly AvatarAsset[];
  pose: string;
  showAnchors: boolean;
}) {
  const { avatars, pose, showAnchors } = props;
  return (
    <section style={{ ...cardStyle, borderColor: UI_GOLD }} data-testid="compare-strip">
      <div style={{ display: 'flex', gap: 32, alignItems: 'flex-end' }}>
        {avatars.map((avatar) => (
          <figure key={avatar.dir} style={figureStyle}>
            <WalkPreview avatar={avatar} pose={pose} showAnchors={showAnchors} />
            <figcaption style={captionStyle}>{avatar.name}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

/** How many source pixels per screen pixel an item frame gets: aim near 96px tall, clamped. */
function itemScale(size: readonly [number, number] | undefined): number {
  if (!size) return 2;
  return Math.max(1, Math.min(6, Math.round(96 / size[1])));
}

/** One held-item: the bare sprite with its grip point (the rest point on the carry mitten). */
export function ItemCard(props: { item: ItemAsset; showAnchors: boolean }) {
  const { item, showAnchors } = props;
  return (
    <section style={cardStyle} data-testid="item-card" data-asset-id={item.id}>
      <CardHeader name={item.name} id={item.id} />
      <figure style={figureStyle}>
        <FrameImage
          frame={item.frame}
          scale={itemScale(item.frame.size)}
          showAnchors={showAnchors}
          alt={item.id}
        />
        <figcaption style={captionStyle}>{anchorCaption(item.frame)}</figcaption>
      </figure>
    </section>
  );
}

/** A labeled section heading shared by the studio's blocks. */
export function SectionHeading(props: { children: ReactNode }) {
  return <h2 style={{ fontSize: 15, margin: '24px 0 12px', color: UI_GOLD }}>{props.children}</h2>;
}
