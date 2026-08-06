// fallow-ignore-file coverage-gaps -- thin aws4fetch wrappers over the R2 S3 API; they need the live bucket, not a unit test. The pure halves (listing XML parse, object-key rule) live in rules.ts and are unit-tested

// The R2 half of the recording flow (ROADMAP Phase 4 増分④): listing the
// finished recordings and presigning one for download. Deliberately the
// S3 API (aws4fetch) rather than an R2 Worker binding, because the S3
// credentials are already load-bearing on BOTH sides of this feature —
// the recording start hands them to the provider (storage_config), and
// presigned URLs can only be minted from them (a binding cannot presign)
// — so a binding would add a second read path without removing the first,
// and `wrangler dev`'s simulated bindings could never see the real bucket
// the provider uploads to. One S3 seam keeps dev/prod a matter of vars
// (README「通話 API Worker」).
import { AwsClient } from 'aws4fetch';
import {
  parseBucketListing,
  RECORDINGS_PREFIX,
  type RecordingObject,
  recordingObjectKey,
} from './rules';

/** The Worker env slice every R2 call needs (see Env in index.ts). */
export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** How long a presigned download URL stays valid. Long enough to click and
 * for the browser to START the transfer (R2 checks expiry at request time,
 * not mid-stream); short enough that a leaked URL is a stale one. */
const DOWNLOAD_URL_TTL_SECONDS = 600;

function s3(cfg: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
}

function bucketUrl(cfg: R2Config): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;
}

/**
 * The finished recordings under the recordings prefix, newest first. One
 * unpaginated ListObjectsV2 page (1,000 keys) — an order of magnitude
 * over the label table's own retention (RECORDING_HISTORY_MAX), so
 * pagination would outlive the product shape that needs it.
 */
export async function listRecordings(cfg: R2Config): Promise<RecordingObject[]> {
  const response = await s3(cfg).fetch(
    `${bucketUrl(cfg)}?list-type=2&prefix=${RECORDINGS_PREFIX}/`,
  );
  if (!response.ok) {
    console.error('R2 list failure', response.status);
    throw new Error(`R2 list failed (${response.status})`);
  }
  const objects = parseBucketListing(await response.text());
  return objects.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/**
 * A presigned GET for one recording, so the browser downloads straight
 * from R2 (an <a href> needs no Authorization header, and the stream
 * never rides the Worker). `fileName` was vetted to the provider naming
 * by the route (isRecordingFileNameLike), which is also what makes a key
 * outside the recordings prefix unrepresentable.
 */
export async function presignedDownloadUrl(cfg: R2Config, fileName: string): Promise<string> {
  const url = new URL(`${bucketUrl(cfg)}/${recordingObjectKey(fileName)}`);
  url.searchParams.set('X-Amz-Expires', String(DOWNLOAD_URL_TTL_SECONDS));
  // Signed response override: the browser SAVES the file instead of
  // navigating into an inline player (the client hands this URL to a
  // plain anchor — a cross-origin `download` attribute would be ignored).
  url.searchParams.set('response-content-disposition', `attachment; filename="${fileName}"`);
  const signed = await s3(cfg).sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true },
  });
  return signed.url;
}
