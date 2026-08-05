// fallow-ignore-file coverage-gaps -- a React panel over the subscribed zone list; needs a DOM, and no DOM test environment is configured. The authority for every action here is server-side (zones.ts reducers over evaluateSettingChange / evaluateZoneSpec, unit-tested in @kaede/shared)
import {
  evaluateZoneSpec,
  ZONE_DEFAULT_H,
  ZONE_DEFAULT_W,
  ZONE_MAX_SIZE,
  ZONE_MIN_SIZE,
  type ZoneSpecRejectReason,
} from '@kaede/shared';
import { type CSSProperties, type FormEvent, useState } from 'react';
import type { ZoneAdminView } from '../net.package';
import {
  panelButtonStyle,
  panelErrorStyle,
  panelHeadingStyle,
  panelInputStyle,
  panelRowStyle,
} from './panelChrome';

/** The zone edits the panel dispatches (update_zone's payload, sans the id). */
export interface ZoneEdit {
  name: string;
  closed: boolean;
  w: number;
  h: number;
}

/** What the zone section does — one callback per zone reducer (see NetApi). */
export interface ZoneActions {
  onCreateZone(spec: { name: string; closed: boolean }): void;
  onUpdateZone(zoneId: bigint, edit: ZoneEdit): void;
  onMoveZone(zoneId: bigint): void;
  onDeleteZone(zoneId: bigint): void;
}

/** The size fields are narrow and fixed, unlike the name field. */
const sizeInputStyle: CSSProperties = {
  ...panelInputStyle,
  flex: '0 0 52px',
};

/** The user-facing wording of each zone-spec refusal (evaluateZoneSpec). */
const SPEC_ERRORS: Record<ZoneSpecRejectReason, string> = {
  empty: '名前を入力してください',
  'too-long': '名前が長すぎます',
  'forbidden-characters': '使えない文字が含まれています',
  'invalid-size': `サイズは ${ZONE_MIN_SIZE}〜${ZONE_MAX_SIZE} で指定してください`,
};

/**
 * The name input and the オープン/クローズド checkbox both zone forms share
 * (create and edit) — one component so the two cannot drift.
 */
function ZoneNameAndClosed({
  name,
  closed,
  nameLabel,
  placeholder,
  onName,
  onClosed,
}: {
  name: string;
  closed: boolean;
  nameLabel: string;
  placeholder?: string;
  onName: (name: string) => void;
  onClosed: (closed: boolean) => void;
}) {
  return (
    <>
      <input
        style={panelInputStyle}
        value={name}
        onChange={(e) => onName(e.target.value)}
        placeholder={placeholder}
        aria-label={nameLabel}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <input type="checkbox" checked={closed} onChange={(e) => onClosed(e.target.checked)} />
        クローズド
      </label>
    </>
  );
}

/**
 * The create form: a name, the オープン/クローズド choice, and one button —
 * placement is server-side ("centered on the sender"), so there is nothing
 * else to ask. Validation mirrors the server's evaluateZoneSpec for
 * instant feedback; the server re-checks regardless.
 */
function CreateZoneForm({ onCreateZone }: { onCreateZone: ZoneActions['onCreateZone'] }) {
  const [name, setName] = useState('');
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string>();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const spec = evaluateZoneSpec({ name, w: ZONE_DEFAULT_W, h: ZONE_DEFAULT_H });
    if (!spec.ok) {
      setError(SPEC_ERRORS[spec.reason]);
      return;
    }
    setError(undefined);
    setName('');
    onCreateZone({ name: spec.name, closed });
  };

  return (
    <form style={panelRowStyle} onSubmit={handleSubmit}>
      <ZoneNameAndClosed
        name={name}
        closed={closed}
        nameLabel="ゾーン名"
        placeholder="ゾーン名"
        onName={(next) => {
          setName(next);
          setError(undefined);
        }}
        onClosed={setClosed}
      />
      <button type="submit" style={panelButtonStyle}>
        いまの場所に設置
      </button>
      {error !== undefined && <span style={panelErrorStyle}>{error}</span>}
    </form>
  );
}

/**
 * One zone's editable row. Draft state seeds from the subscribed row and
 * the component is keyed on the row's VALUES (see ZonePanel), so an edit
 * arriving from elsewhere — another admin, a move — remounts the row with
 * fresh drafts instead of silently overwriting them; the cost is that a
 * concurrent edit resets an in-progress draft, acceptable for a rare
 * admin action.
 */
function ZoneRow({ zone, actions }: { zone: ZoneAdminView; actions: ZoneActions }) {
  const [name, setName] = useState(zone.name);
  const [w, setW] = useState(String(zone.w));
  const [h, setH] = useState(String(zone.h));
  const [closed, setClosed] = useState(zone.closed);
  const [error, setError] = useState<string>();

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    const spec = evaluateZoneSpec({ name, w: Number(w), h: Number(h) });
    if (!spec.ok) {
      setError(SPEC_ERRORS[spec.reason]);
      return;
    }
    setError(undefined);
    actions.onUpdateZone(zone.id, { name: spec.name, closed, w: spec.w, h: spec.h });
  };

  return (
    <form style={panelRowStyle} onSubmit={handleSave} aria-label={`ゾーン ${zone.name}`}>
      <span style={{ flexBasis: '100%', opacity: 0.7 }}>
        {zone.mapName}
        {zone.closed && '・クローズド'}
      </span>
      <ZoneNameAndClosed
        name={name}
        closed={closed}
        nameLabel="ゾーン名を変更"
        onName={(next) => {
          setName(next);
          setError(undefined);
        }}
        onClosed={setClosed}
      />
      <input
        style={sizeInputStyle}
        value={w}
        onChange={(e) => setW(e.target.value)}
        aria-label="幅"
        inputMode="numeric"
      />
      <input
        style={sizeInputStyle}
        value={h}
        onChange={(e) => setH(e.target.value)}
        aria-label="高さ"
        inputMode="numeric"
      />
      <button type="submit" style={panelButtonStyle}>
        保存
      </button>
      <button type="button" style={panelButtonStyle} onClick={() => actions.onMoveZone(zone.id)}>
        ここへ移動
      </button>
      <button type="button" style={panelButtonStyle} onClick={() => actions.onDeleteZone(zone.id)}>
        削除
      </button>
      {error !== undefined && <span style={panelErrorStyle}>{error}</span>}
    </form>
  );
}

/**
 * The admin panel's zone section (ROADMAP Phase 3 増分②): place a
 * meeting-room zone where the admin stands, edit its name / size /
 * オープン・クローズド, move it here, delete it. Rendering is gated with
 * the rest of the admin panel; every action is re-checked server-side.
 */
export function ZonePanel({
  zones,
  actions,
}: {
  /** The whole zone list, every map, creation order (see ZoneAdminView). */
  zones: ZoneAdminView[];
  actions: ZoneActions;
}) {
  return (
    <div>
      <div style={panelHeadingStyle}>ゾーン(会議室) ({zones.length})</div>
      <CreateZoneForm onCreateZone={actions.onCreateZone} />
      {zones.map((zone) => (
        <ZoneRow
          key={`${zone.key}:${zone.name}:${zone.w}:${zone.h}:${zone.closed}:${zone.mapId}`}
          zone={zone}
          actions={actions}
        />
      ))}
    </div>
  );
}
