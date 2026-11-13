/**
 * The terminal review controller as a navigation conformance consumer.
 *
 * The controller submits relative moves through `applyReviewIntent` and reconciles its
 * rendered selection after document/filter updates. This adapter drives those same two
 * planning paths without mounting OpenTUI, so the shared corpus catches a terminal
 * lifecycle regression as well as a core-planner regression.
 */
import type { ReviewAction } from "../../../packages/hunk/src/core/review/actions";
import { projectReviewDocument } from "../../../packages/hunk/src/core/review/document";
import { lowerSessionComment } from "../../../packages/hunk/src/core/liveComments";
import { TERMINAL_REVIEWER_AUTHORSHIP } from "../../../packages/hunk/src/core/review/authorship";
import { reviewHunkIndexForLine } from "../../../packages/hunk/src/core/review/geometry";
import {
  applyReviewIntent,
  planReviewIntentBatch,
  type ReviewIntentOutcome,
} from "../../../packages/hunk/src/core/review/intents";
import { reduceReviewState } from "../../../packages/hunk/src/core/review/reducer";
import { selectRevealTarget } from "../../../packages/hunk/src/core/review/selectors";
import {
  createInitialReviewState,
  type ReviewState,
} from "../../../packages/hunk/src/core/review/state";
import type { ReviewStore } from "../../../packages/hunk/src/core/review/store";
import { planTerminalSelectionReconciliation } from "../../../packages/hunk/src/ui/lib/reviewState";
import type { CommentTargetInput } from "../../../packages/hunk/src/core/liveComments";
import {
  NOTE_WRITE_FACTS,
  projectWrittenNote,
  toAnnotationIndex,
  toConformanceSelection,
  toSemanticSelection,
} from "./intentPlanner";
import type {
  ReviewNavigationConsumer,
  ReviewNavigationFixture,
  ReviewNoteWriteConsumer,
  ReviewNoteWriteFixture,
} from "../types";

/** Apply the terminal's render-lifecycle reconciliation without requesting a reveal. */
function reconcileTerminalSelection(state: ReviewState) {
  const action = planTerminalSelectionReconciliation(state);
  return action ? reduceReviewState(state, action) : state;
}

/** Build the minimal synchronous store the controller's `runIntent` helper receives. */
function createTestReviewStore(initial: ReviewState): ReviewStore {
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

/** Recover the semantic reveal request from the counters the store published. */
function revealFromTransition(before: ReviewState, after: ReviewState) {
  return {
    anchor:
      after.reveal.fileTopToken !== before.reveal.fileTopToken
        ? ("file-top" as const)
        : after.reveal.hunkToken !== before.reveal.hunkToken
          ? ("hunk" as const)
          : ("none" as const),
    scrollToNote: after.reveal.scrollToNote,
  };
}

export const terminalReviewNavigationConsumer: ReviewNavigationConsumer = {
  name: "terminal review",
  phase: "Phase 1 PR 3",
  project(fixture: ReviewNavigationFixture) {
    const document = projectReviewDocument(fixture.build());
    const annotations = toAnnotationIndex(fixture, document);
    const baseState: ReviewState = {
      ...createInitialReviewState(document),
      filter: fixture.filter ?? "",
    };
    const stateAt = (input: ReviewNavigationFixture["selections"][number]) =>
      reconcileTerminalSelection({
        ...baseState,
        selection: toSemanticSelection(input, document),
      });

    return {
      moves: fixture.moves.map((move) => {
        // This is the same semantic-intent call `useTerminalReview` makes for its
        // keyboard and session navigation handlers.
        const store = createTestReviewStore(stateAt(move.from));
        const before = store.getSnapshot();
        const outcome = applyReviewIntent(
          store,
          { type: "selection/move", scope: move.scope, delta: move.delta },
          { annotations },
        );
        if (!outcome) {
          return { to: null };
        }
        const after = store.getSnapshot();
        return {
          to: toConformanceSelection(after.selection.fileKey, after.selection.hunkIndex, document),
          reveal: revealFromTransition(before, after),
        };
      }),
      normalizedSelections: fixture.selections.map((input) => {
        const selection = stateAt(input).selection;
        return toConformanceSelection(selection.fileKey, selection.hunkIndex, document);
      }),
      revealTargets: document.files.map((file, fileIndex) =>
        file.hunks.map(
          (_hunk, hunkIndex) =>
            selectRevealTarget({
              ...baseState,
              selection: toSemanticSelection({ file: fileIndex, hunkIndex }, document),
            }) ?? null,
        ),
      ),
    };
  },
};

/**
 * Write a fixture's note the way an agent's `hunk session comment` does: lowered from the
 * command's input shape, then planned as a batch, as `useTerminalReview` plans it.
 */
function writeSessionComment(fixture: ReviewNoteWriteFixture, state: ReviewState) {
  const placement = fixture.placement;
  const author = fixture.authorship.label;
  const base = { summary: fixture.summary, ...(author !== undefined ? { author } : {}) };
  const input: CommentTargetInput =
    "parentId" in placement
      ? { ...base, replyTo: placement.parentId }
      : "hunkIndex" in placement
        ? {
            ...base,
            filePath: state.document.files[placement.file]!.path,
            hunkIndex: placement.hunkIndex,
          }
        : { ...base, filePath: state.document.files[placement.file]!.path, ...placement.line };
  const { intent, authorship } = lowerSessionComment(
    input,
    (filePath) => state.document.files.find((file) => file.path === filePath)!.key,
  );
  return planReviewIntentBatch(state, [{ intent, facts: { ...NOTE_WRITE_FACTS, authorship } }])
    .outcomes[0];
}

/**
 * Write a fixture's note the way the reviewer does at the terminal: open the composer at the
 * placement, type the body, and save it with the terminal's authorship.
 */
function writeComposerNote(
  fixture: ReviewNoteWriteFixture,
  state: ReviewState,
): ReviewIntentOutcome | undefined {
  const store = createTestReviewStore(state);
  const placement = fixture.placement;
  const draftFacts = { draftId: "conformance:draft" };
  if ("parentId" in placement) {
    applyReviewIntent(store, { type: "notes/start-reply", noteId: placement.parentId }, draftFacts);
  } else {
    const file = state.document.files[placement.file]!;
    applyReviewIntent(
      store,
      "hunkIndex" in placement
        ? { type: "notes/start-draft", fileKey: file.key, hunkIndex: placement.hunkIndex }
        : {
            type: "notes/start-draft",
            fileKey: file.key,
            // The terminal opens the composer from the hunk the reviewer is pointing into.
            hunkIndex: reviewHunkIndexForLine(file.hunks, placement.line.side, placement.line.line),
            target: placement.line,
          },
      draftFacts,
    );
  }
  applyReviewIntent(store, { type: "notes/update-draft", body: fixture.summary });
  return applyReviewIntent(
    store,
    { type: "notes/create-user", consumeDraft: true },
    { ...NOTE_WRITE_FACTS, authorship: TERMINAL_REVIEWER_AUTHORSHIP },
  );
}

export const terminalNoteWriteConsumer: ReviewNoteWriteConsumer = {
  name: "terminal note writers",
  phase: "note writes",
  project(fixture) {
    const state = fixture.build();
    switch (fixture.authorship.channel) {
      case "session-cli":
        return projectWrittenNote(state, writeSessionComment(fixture, state));
      case "terminal":
        return projectWrittenNote(state, writeComposerNote(fixture, state));
      case "review-client":
        throw new Error("The terminal does not write review-client notes.");
    }
  },
};
