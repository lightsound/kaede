// fallow-ignore-file coverage-gaps -- React log-line components for the chat panel; needs a DOM, and no DOM test environment is configured. The entry views they render are assembled by the net stack's chat feed (unit-tested in net.package), and this file only lays them out
import { type CSSProperties } from 'react';
import { type ChatEntryView } from '../net.package';
import { UI_DM_COLOR, UI_GOLD, UI_GOLD_BORDER_SOFT, UI_TEXT_COLOR } from '../theme';

/** The sender name lead-in; the local player's own lines get the gold accent. */
function senderStyle(own: boolean): CSSProperties {
  return { color: own ? UI_GOLD : UI_TEXT_COLOR, fontWeight: 'bold' };
}

const dmMarkStyle: CSSProperties = {
  color: UI_DM_COLOR,
  fontWeight: 'bold',
};

const scopeMarkStyle: CSSProperties = {
  opacity: 0.7,
};

const announcementLineStyle: CSSProperties = {
  padding: '2px 4px',
  borderRadius: 4,
  border: UI_GOLD_BORDER_SOFT,
  color: UI_GOLD,
};

/**
 * One log line. A DM line is marked apart from room chatter — the [DM] tag
 * and the → 宛先 in the DM accent color — because the log holds both and a
 * private line must never read as something the room saw. Only the sender
 * and the recipient ever hold the row (row-level security), so no
 * receiver-side filtering happens here.
 *
 * A public line carries its scope marker (ROADMAP Phase 3 増分④) for the
 * same reason: one log now merges 全体, this map's and the current group's
 * conversations, and a line whose audience is invisible reads as if it went
 * to everyone. An admin announcement is the marker plus the gold frame —
 * it is the one line that must not scroll past unnoticed.
 */
export function LogLine({ entry }: { entry: ChatEntryView }) {
  return (
    <div style={entry.kind === 'chat' && entry.announcement ? announcementLineStyle : undefined}>
      <LineMark entry={entry} />
      <span style={senderStyle(entry.own)}>{entry.senderName}</span>
      <DmRecipient entry={entry} /> {entry.text}
    </div>
  );
}

/**
 * What a line leads with: [DM] for a private one, otherwise its scope
 * marker. Split from LogLine (with DmRecipient below) to keep these
 * uncovered arrows under the CRAP budget fallow enforces — the
 * backfillAccountName precedent, applied to JSX.
 */
function LineMark({ entry }: { entry: ChatEntryView }) {
  if (entry.kind === 'dm') return <span style={dmMarkStyle}>[DM] </span>;
  if (entry.scopeTag === undefined) return null;
  return <span style={scopeMarkStyle}>[{entry.scopeTag}] </span>;
}

/** The 宛先 a DM line ends its header with; nothing on a public line. */
function DmRecipient({ entry }: { entry: ChatEntryView }) {
  if (entry.kind !== 'dm') return null;
  return <span style={dmMarkStyle}> → {entry.recipientName}</span>;
}
