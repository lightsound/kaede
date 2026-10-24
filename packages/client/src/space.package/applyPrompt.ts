import { membershipPrompt } from '@kaede/shared';
import type { SpaceView } from '../net.package';

/**
 * The application affordance for this client, from the space view (see
 * membershipPrompt) — what AdmissionOverlay and ApplyBanner offer.
 * `anyMemberRow` mirrors the server's admin seed condition over the public
 * directory — every status counts. Before the first report there is no
 * admission either, so no surface renders the fallback prompt.
 */
export function promptFor(signedIn: boolean, space: SpaceView | undefined) {
  return membershipPrompt({
    signedIn,
    membership: space?.self,
    anyMemberRow: space !== undefined && space.members.length > 0,
  });
}
