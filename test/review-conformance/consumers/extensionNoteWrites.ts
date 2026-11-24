/**
 * Extension note writes as a note-write conformance consumer.
 *
 * Drives `ctx.review.notes.create` exactly as the host builds it — the same controls an
 * extension command receives — against a store holding the fixture's review, and reads the
 * written note back from the result the extension sees.
 */
import { applyReviewIntent } from "../../../packages/hunk/src/core/review/intents";
import type { ReviewState } from "../../../packages/hunk/src/core/review/state";
import type { ReviewStore } from "../../../packages/hunk/src/core/review/store";
import type { ReviewAction } from "../../../packages/hunk/src/core/review/actions";
import { reduceReviewState } from "../../../packages/hunk/src/core/review/reducer";
import type { ExtensionReviewNoteCreateInput } from "../../../packages/hunk/src/extension-api/types";
import { createExtensionReviewNoteControls } from "../../../packages/hunk/src/extensions/reviewNotes";
import type { ReviewNoteWriteConsumer, ReviewNoteWriteFixture } from "../types";

/** A synchronous store over one fixture state, as the producer's store behaves. */
function createTestFixtureStore(initial: ReviewState): ReviewStore {
  let snapshot = initial;
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    dispatch(action: ReviewAction) {
      snapshot = reduceReviewState(snapshot, action);
      return snapshot;
    },
  };
}

/** State a fixture's write as the request an extension sends. */
function toCreateInput(fixture: ReviewNoteWriteFixture, state: ReviewState) {
  const { placement, writer: authorship, summary } = fixture;
  if (authorship === "reviewer") {
    throw new Error("Extensions state their authorship on every write.");
  }
  const who = {
    as: authorship.source,
    ...(authorship.label !== undefined ? { label: authorship.label } : {}),
    body: { summary },
  };
  if ("parentId" in placement) return { ...who, parentId: placement.parentId };
  const filePath = state.document.files[placement.file]!.path;
  return "hunkIndex" in placement
    ? { ...who, filePath, hunkIndex: placement.hunkIndex }
    : { ...who, filePath, ...placement.line };
}

export const extensionNoteWriteConsumer: ReviewNoteWriteConsumer = {
  name: "extension note writes",
  phase: "note writes",
  channels: ["extension"],
  project(fixture) {
    const state = fixture.build();
    const store = createTestFixtureStore(state);
    const notes = createExtensionReviewNoteControls({
      isLive: () => true,
      getReview: () => ({
        getPositionedReviewState: () => ({ generation: "conformance", state: store.getSnapshot() }),
        applyIntent: (intent, facts) => applyReviewIntent(store, intent, facts),
      }),
      newId: () => "conformance",
      now: () => "2026-01-01T00:00:00.000Z",
    });

    const result = notes.create(toCreateInput(fixture, state) as ExtensionReviewNoteCreateInput);
    if (!result.ok) throw new Error(`The extension write was refused: ${result.code}`);
    const { note } = result;
    const { anchor } = note;
    return {
      source: note.source,
      ...(note.originalSource !== undefined ? { originalSource: note.originalSource } : {}),
      ...(note.author !== undefined ? { author: note.author } : {}),
      editable: note.editable,
      file: state.document.files.findIndex((file) => file.key === note.fileKey),
      ...(note.parentId !== undefined ? { parentId: note.parentId } : {}),
      resolution: note.resolution,
      ...(anchor.oldRange ? { oldRange: [anchor.oldRange[0], anchor.oldRange[1]] } : {}),
      ...(anchor.newRange ? { newRange: [anchor.newRange[0], anchor.newRange[1]] } : {}),
      ...(anchor.preferred ? { preferred: { ...anchor.preferred } } : {}),
      intersectingHunkIndices: [...anchor.intersectingHunkIndices],
      ...(anchor.ownerHunkIndex !== undefined ? { ownerHunkIndex: anchor.ownerHunkIndex } : {}),
    };
  },
};
