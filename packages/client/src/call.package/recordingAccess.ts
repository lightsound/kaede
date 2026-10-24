// Who the recording surfaces are for (増分④ 設計①: 録画はメンバー限定。
// サインイン済みでも未承認ならゲスト扱い), from the auth session and the
// space view. Pure, so unit-tested; App renders the docks by these.
import type { SpaceView } from '../net.package';

/**
 * Whether this client is a signed-in APPROVED member — what the recording
 * surfaces gate on. Cosmetic gates only; the recording procedures re-check
 * approval server-side.
 */
export function approvedMember(signedIn: boolean, space: SpaceView | undefined): boolean {
  return signedIn && space?.self?.status === 'approved';
}

/** The 録画一覧's mount gate: connected AND an approved member. */
export function recordingsDockVisible(
  connected: boolean,
  signedIn: boolean,
  space: SpaceView | undefined,
): boolean {
  return connected && approvedMember(signedIn, space);
}
