// fallow-ignore-file coverage-gaps -- DOM stage for the studio's dress-up try-on; the try-on rules (outfit list, carry pairing, layer placement) live in dressup.ts, which is unit-tested
import type { CSSProperties } from 'react';
import { UI_GOLD, UI_GOLD_BORDER_SOFT, UI_PANEL_BG, UI_TEXT_COLOR } from '../theme';
import { groundBoxStyle } from './cards';
import type { AssetCatalog, AvatarAsset, ItemAsset } from './catalog';
import { frameFor, maxFrameSize, outfitOptions, type StageLook, stageOverlays } from './dressup';

// Halved from 3 when sources moved 2x → 4x (factory-v2 step 1): the stage
// figure keeps its on-screen size while the source pixels doubled.
const STAGE_SCALE = 1.5;

const stageSectionStyle: CSSProperties = {
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER_SOFT,
  borderRadius: 8,
  padding: 12,
  color: UI_TEXT_COLOR,
  display: 'flex',
  gap: 24,
  alignItems: 'flex-start',
  flexWrap: 'wrap',
};

const optionRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  alignItems: 'flex-end',
};

const optionLabelStyle: CSSProperties = { fontSize: 11, opacity: 0.8, marginTop: 4 };

const noteStyle: CSSProperties = { color: '#e8a2a2', fontSize: 12, marginTop: 8 };

/** A selectable thumbnail button (an outfit or an item), gold-framed while worn/held. */
function optionButtonStyle(selected: boolean): CSSProperties {
  return {
    background: selected ? 'rgba(216, 166, 87, 0.2)' : 'transparent',
    border: selected ? `1px solid ${UI_GOLD}` : UI_GOLD_BORDER_SOFT,
    borderRadius: 6,
    padding: '6px 8px',
    cursor: 'pointer',
    color: UI_TEXT_COLOR,
    font: 'inherit',
    textAlign: 'center',
  };
}

/** A thumbnail image at `height` CSS px, width following the aspect ratio. */
function thumbStyle(height: number): CSSProperties {
  return { imageRendering: 'pixelated', height, width: 'auto', display: 'block', margin: '0 auto' };
}

/**
 * The dressed figure: the worn sheet's frame for the current walk pose,
 * with the held layers composited at the hand anchor (body → item → hand,
 * the avatarView order). All placement math lives in dressup.ts; here it
 * is only multiplied by the stage scale.
 */
function StageFigure(props: { look: StageLook; pose: string }) {
  const { look, pose } = props;
  const resolved = frameFor(look.body, pose);
  if (!resolved || resolved.frame.url === undefined) {
    return <span style={{ color: '#e8a2a2' }}>表示できるコマがありません</span>;
  }
  const [w, h] = resolved.frame.size ?? maxFrameSize(look.body);
  return (
    <span style={groundBoxStyle(maxFrameSize(look.body), STAGE_SCALE)}>
      <span
        data-testid="stage-figure"
        data-pose={resolved.pose}
        data-body={look.body.id}
        style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}
      >
        <img
          src={resolved.frame.url}
          alt={look.body.name}
          style={{ imageRendering: 'pixelated', width: w * STAGE_SCALE, height: h * STAGE_SCALE }}
        />
        {stageOverlays(look, resolved).map((layer) => (
          <img
            key={layer.url}
            data-testid="stage-overlay"
            src={layer.url}
            alt=""
            style={{
              position: 'absolute',
              left: layer.left * STAGE_SCALE,
              top: layer.top * STAGE_SCALE,
              width: layer.width * STAGE_SCALE,
              imageRendering: 'pixelated',
            }}
          />
        ))}
      </span>
    </span>
  );
}

/** One outfit choice: the stand frame as the thumbnail (服はコーデ単位のシート). */
function OutfitOption(props: { outfit: AvatarAsset; selected: boolean; onSelect: () => void }) {
  const stand = frameFor(props.outfit, 'stand');
  return (
    <button
      type="button"
      data-testid={`outfit-option-${props.outfit.id}`}
      aria-pressed={props.selected}
      onClick={props.onSelect}
      style={optionButtonStyle(props.selected)}
    >
      {stand?.frame.url && (
        <img src={stand.frame.url} alt={props.outfit.name} style={thumbStyle(48)} />
      )}
      <div style={optionLabelStyle}>{props.outfit.name}</div>
    </button>
  );
}

/** One held-item choice; clicking again puts the item back. */
function ItemOption(props: { item: ItemAsset; held: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-testid={`item-option-${props.item.id}`}
      aria-pressed={props.held}
      onClick={props.onToggle}
      style={optionButtonStyle(props.held)}
    >
      {props.item.frame.url && (
        <img src={props.item.frame.url} alt={props.item.name} style={thumbStyle(28)} />
      )}
      <div style={optionLabelStyle}>{props.item.name}</div>
    </button>
  );
}

/**
 * The try-on stage (owner feedback 2026-08-09): pick an outfit from the
 * clothing row to swap the whole body sheet, click an item to have the
 * figure hold it (which swaps to the outfit's carry sheet — one decision,
 * the ①b(a)⑵ rule). Read-only like the rest of the studio: selections
 * live in page state, nothing persists.
 */
export function DressUpStage(props: {
  catalog: AssetCatalog;
  look: StageLook;
  pose: string;
  onSelectOutfit: (id: string) => void;
  onToggleItem: (id: string) => void;
}) {
  const { catalog, look, pose, onSelectOutfit, onToggleItem } = props;
  return (
    <section style={stageSectionStyle} data-testid="dressup-stage">
      <figure style={{ margin: 0, textAlign: 'center' }}>
        <StageFigure look={look} pose={pose} />
        <figcaption style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
          {look.body.name}
          {look.item ? ` ＋ ${look.item.name}` : ''}
        </figcaption>
      </figure>
      <div style={{ display: 'grid', gap: 12, flex: 1, minWidth: 280 }}>
        <div>
          <div style={{ marginBottom: 6 }}>服（コーデ単位のシート差し替え）</div>
          <div style={optionRowStyle}>
            {outfitOptions(catalog).map((outfit) => (
              <OutfitOption
                key={outfit.dir}
                outfit={outfit}
                selected={outfit.id === look.outfit.id}
                onSelect={() => onSelectOutfit(outfit.id)}
              />
            ))}
          </div>
        </div>
        <div>
          <div style={{ marginBottom: 6 }}>持ち物（クリックで持つ／もう一度で外す）</div>
          <div style={optionRowStyle}>
            {catalog.items.map((item) => (
              <ItemOption
                key={item.dir}
                item={item}
                held={item.id === look.item?.id}
                onToggle={() => onToggleItem(item.id)}
              />
            ))}
          </div>
          {look.note && (
            <div style={noteStyle} data-testid="stage-note">
              {look.note}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
