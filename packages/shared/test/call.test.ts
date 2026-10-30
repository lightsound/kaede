import { isRecordingFileNameLike } from '@kaede/shared';
import { describe, expect, it } from 'vite-plus/test';

describe('isRecordingFileNameLike', () => {
  // The live-probed shape (2026-08-06): {meetingId}_{epochMillis}.mp4.
  const REAL = 'bbb18638-c246-472c-b79f-4840becd2eef_1785992667838.mp4';

  it('プロバイダ命名の {meetingId}_{epochMs}.mp4 だけを受理する', () => {
    expect(isRecordingFileNameLike(REAL)).toBe(true);
    expect(isRecordingFileNameLike('')).toBe(false);
    expect(isRecordingFileNameLike('bbb18638-c246-472c-b79f-4840becd2eef.mp4')).toBe(false);
    expect(isRecordingFileNameLike('bbb18638-c246-472c-b79f-4840becd2eef_1785992667838')).toBe(
      false,
    );
    expect(isRecordingFileNameLike(`${REAL}\n`)).toBe(false);
  });

  it('オブジェクトキーのプレフィックス脱出を表現できない', () => {
    // The download presigner builds `recordings/{fileName}` — a slash or
    // dot segment in an accepted name would escape the prefix, so the
    // shape rule is also the traversal guard.
    expect(isRecordingFileNameLike(`../${REAL}`)).toBe(false);
    expect(isRecordingFileNameLike(`recordings/${REAL}`)).toBe(false);
    expect(isRecordingFileNameLike(`..%2F${REAL}`)).toBe(false);
  });
});
