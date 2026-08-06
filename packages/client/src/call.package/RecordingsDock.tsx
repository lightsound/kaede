// fallow-ignore-file coverage-gaps -- a React panel over the module's recording listing; needs a DOM and a live connection, and no DOM test environment is configured. The server-side rules (member gate, SigV4 signing, listing parse) are unit-tested in @kaede/shared
import { type CSSProperties, useState } from 'react';
import type { RecordingFile, RecordingLabelView } from '../net.package';
import {
  UI_BUTTON_BG,
  UI_ERROR_COLOR,
  UI_FONT,
  UI_GOLD_BORDER,
  UI_PANEL_BG,
  UI_TEXT_COLOR,
} from '../theme';
import { blurringClick } from '../ui.package';

// Top-left, mirroring the admin panel's top-right: the recordings are a
// space-level archive, not something you do from where you stand (the
// bottom-left column is the standing-context controls).
const dockStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '6px 8px',
  borderRadius: 8,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  font: UI_FONT,
  color: UI_TEXT_COLOR,
  maxWidth: 460,
  maxHeight: '60vh',
  overflowY: 'auto',
};

const buttonStyle: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 6,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
  flexShrink: 0,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  justifyContent: 'space-between',
};

/** What the panel calls on the net facade (the CallDockNet shape). */
export interface RecordingsDockNet {
  /** NetApi.listRecordings — the module's R2 listing (増分⑥). */
  listRecordings(): Promise<RecordingFile[]>;
  /** NetApi.recordingDownloadUrl — a short-lived presigned URL. */
  recordingDownloadUrl(fileName: string): Promise<string>;
}

/** What the panel knows about the listing right now. */
type Listing =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'loaded'; files: RecordingFile[] };

function sizeLabel(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Starts a browser download for one recording: ask the module for a
 * short-lived presigned URL (member-gated), then hand it to the browser —
 * the bytes stream straight from R2, never through the module or this
 * tab's memory (the URL carries a content-disposition override, so the
 * browser saves instead of playing).
 */
async function download(ctx: PanelContext, fileName: string): Promise<void> {
  const url = await ctx.net.recordingDownloadUrl(fileName);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** What every listing row and the panel body need from the mounted dock. */
interface PanelContext {
  net: RecordingsDockNet;
  labels: RecordingLabelView[];
  onDownloadFailure: () => void;
}

/** One recording's row: its labels (or the date-only fallback) and the DL button. */
function RecordingRow({ file, ctx }: { file: RecordingFile; ctx: PanelContext }) {
  const label = ctx.labels.find((candidate) => candidate.fileName === file.fileName);
  const title = label === undefined ? '録画' : `${label.groupName} — ${label.starterName}`;
  return (
    <div style={rowStyle}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {title}（{dateLabel(file.uploadedAt)}・{sizeLabel(file.size)}）
      </span>
      <button
        type="button"
        style={buttonStyle}
        onClick={blurringClick(
          () => void download(ctx, file.fileName).catch(ctx.onDownloadFailure),
        )}
      >
        ⬇ DL
      </button>
    </div>
  );
}

/** The open panel's body, one branch per listing state. */
function ListingBody({
  listing,
  ctx,
}: {
  listing: Exclude<Listing, { kind: 'closed' }>;
  ctx: PanelContext;
}) {
  if (listing.kind === 'loading') return <span>読み込み中…</span>;
  if (listing.kind === 'failed') {
    return <span style={{ color: UI_ERROR_COLOR }}>一覧を取得できませんでした</span>;
  }
  if (listing.files.length === 0) {
    return <span>録画はまだありません（停止後、アップロード完了までしばらくかかります）</span>;
  }
  return (
    <>
      {listing.files.map((file) => (
        <RecordingRow key={file.fileName} file={file} ctx={ctx} />
      ))}
    </>
  );
}

/**
 * The 録画一覧 dock (ROADMAP Phase 4 増分④→⑥): the finished recordings
 * in the R2 bucket, labeled by the call_recording rows and downloadable
 * via presigned URLs — both served by module procedures since 増分⑥
 * (承認済みメンバー限定, enforced server-side; App's mount gate is
 * cosmetic). The truth about what exists is the R2 listing, fetched when
 * the panel opens (and on 更新): a recording still uploading appears on
 * the next refresh — the label rows arrive live but carry no download
 * capability of their own.
 */
export function RecordingsDock({
  visible,
  net,
  labels,
}: {
  /** Connected AND an approved member (cosmetic gate — see above). */
  visible: boolean;
  net: RecordingsDockNet;
  /** The call_recording label rows (NetHooks.onRecordings), newest first. */
  labels: RecordingLabelView[];
}) {
  const [listing, setListing] = useState<Listing>({ kind: 'closed' });
  const [downloadFailed, setDownloadFailed] = useState(false);
  if (!visible) return null;

  const refresh = async () => {
    setListing({ kind: 'loading' });
    setDownloadFailed(false);
    try {
      setListing({ kind: 'loaded', files: await net.listRecordings() });
    } catch (err) {
      console.error('recording list failed', err);
      setListing({ kind: 'failed' });
    }
  };

  if (listing.kind === 'closed') {
    return (
      <div style={dockStyle}>
        <button type="button" style={buttonStyle} onClick={blurringClick(() => void refresh())}>
          🎞 録画一覧
        </button>
      </div>
    );
  }
  return (
    <div style={dockStyle}>
      <div style={rowStyle}>
        <strong>🎞 録画一覧</strong>
        <span style={{ display: 'flex', gap: 6 }}>
          <button type="button" style={buttonStyle} onClick={blurringClick(() => void refresh())}>
            更新
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={blurringClick(() => setListing({ kind: 'closed' }))}
          >
            閉じる
          </button>
        </span>
      </div>
      <ListingBody
        listing={listing}
        ctx={{ net, labels, onDownloadFailure: () => setDownloadFailed(true) }}
      />
      {downloadFailed && (
        <span style={{ color: UI_ERROR_COLOR }}>ダウンロード URL を取得できませんでした</span>
      )}
    </div>
  );
}
