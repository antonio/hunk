/** Builds the review controls lifecycle handlers get, expiring with their review generation. */

import type {
  ExtensionEventReviewControls,
  ExtensionReviewNoteControls,
  ExtensionReviewReloadResult,
} from "../../extension-api/types";

const EXPIRED_RELOAD_RESULT: ExtensionReviewReloadResult = Object.freeze({
  ok: false,
  reason: "unavailable",
  detail: "This review reload request is no longer current.",
});

/**
 * Guard one host-owned reload operation behind a review-generation capability lease, beside
 * the note controls minted for the same generation.
 */
export function createExtensionReviewReloadControls({
  isLive,
  requestReload,
  notes,
}: {
  isLive: () => boolean;
  requestReload: () => Promise<ExtensionReviewReloadResult>;
  notes: ExtensionReviewNoteControls;
}): ExtensionEventReviewControls {
  return Object.freeze({
    notes,
    requestReload() {
      if (!isLive()) return Promise.resolve(EXPIRED_RELOAD_RESULT);
      return requestReload();
    },
  });
}
