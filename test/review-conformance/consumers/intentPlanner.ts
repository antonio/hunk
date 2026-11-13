/**
 * The shared intent planner as a navigation conformance consumer.
 *
 * Everything is read back through `planReviewIntent` — the same entry point the terminal's
 * keyboard, the session's comment navigation, and later the wire all go through — rather
 * than by calling the walk directly, so a planner that stopped consulting the shared
 * selectors would show up here.
 */
import { projectReviewDocument } from "../../../packages/hunk/src/core/review/document";
import {
  planReviewIntent,
  type ReviewIntentOutcome,
  type ReviewNoteCreatePlacement,
} from "../../../packages/hunk/src/core/review/intents";
import type { ReviewAnnotationIndex } from "../../../packages/hunk/src/core/review/navigation";
import {
  selectNormalizedSelection,
  selectRevealTarget,
} from "../../../packages/hunk/src/core/review/selectors";
import {
  createInitialReviewState,
  type ReviewState,
} from "../../../packages/hunk/src/core/review/state";
import type { ReviewDocumentV1 } from "../../../packages/hunk/src/core/review/types";
import type {
  ConformanceSelection,
  ConformanceSelectionInput,
  ReviewNavigationConsumer,
  ReviewNavigationFixture,
  ReviewNoteWriteConsumer,
  ReviewNoteWriteFixture,
  ReviewNoteWriteProjection,
} from "../types";

/** A key no projected document can produce, standing in for a file a reload dropped. */
export const VANISHED_FILE_KEY = "vanished:no-such-file";

/** Resolve a fixture's positional selection into the semantic one core reads. */
export function toSemanticSelection(input: ConformanceSelectionInput, document: ReviewDocumentV1) {
  if (input.file === null) {
    return { fileKey: null, hunkIndex: input.hunkIndex };
  }
  if (input.file === "vanished") {
    return { fileKey: VANISHED_FILE_KEY, hunkIndex: input.hunkIndex };
  }
  return {
    fileKey: document.files[input.file]?.key ?? VANISHED_FILE_KEY,
    hunkIndex: input.hunkIndex,
  };
}

/** Report a semantic position back as the file index the fixture states. */
export function toConformanceSelection(
  fileKey: string | null,
  hunkIndex: number,
  document: ReviewDocumentV1,
): ConformanceSelection {
  const index = document.files.findIndex((file) => file.key === fileKey);
  return { file: index < 0 ? null : index, hunkIndex };
}

/** Build the annotation index the fixture declares, keyed by semantic file key. */
export function toAnnotationIndex(
  fixture: ReviewNavigationFixture,
  document: ReviewDocumentV1,
): ReviewAnnotationIndex {
  const annotatedHunks = Object.entries(fixture.annotatedHunks ?? {});
  const annotatedHunkIndicesByFileKey = new Map(
    annotatedHunks.flatMap(([fileIndex, hunkIndices]) => {
      const file = document.files[Number(fileIndex)];
      return file ? [[file.key, new Set(hunkIndices)] as const] : [];
    }),
  );
  const annotatedFileIndices =
    fixture.annotatedFiles ?? annotatedHunks.map(([fileIndex]) => Number(fileIndex));
  return {
    annotatedHunkIndicesByFileKey,
    annotatedFileKeys: new Set(
      annotatedFileIndices.flatMap((fileIndex) => {
        const file = document.files[fileIndex];
        return file ? [file.key] : [];
      }),
    ),
  };
}

export const intentPlannerNavigationConsumer: ReviewNavigationConsumer = {
  name: "core intent planner",
  phase: "Phase 1 PR 3",
  project(fixture: ReviewNavigationFixture) {
    const document = projectReviewDocument(fixture.build());
    const annotations = toAnnotationIndex(fixture, document);
    const baseState: ReviewState = {
      ...createInitialReviewState(document),
      filter: fixture.filter ?? "",
    };
    const stateAt = (input: ConformanceSelectionInput) => ({
      ...baseState,
      selection: toSemanticSelection(input, document),
    });

    return {
      moves: fixture.moves.map((move) => {
        const plan = planReviewIntent(
          stateAt(move.from),
          { type: "selection/move", scope: move.scope, delta: move.delta },
          { annotations },
        );
        const action = plan.actions[0];
        if (!action || action.type !== "selection/select" || !action.reveal) {
          return { to: null };
        }
        return {
          to: toConformanceSelection(action.fileKey, action.hunkIndex, document),
          reveal: action.reveal,
        };
      }),
      normalizedSelections: fixture.selections.map((input) => {
        const normalized = selectNormalizedSelection(stateAt(input));
        return toConformanceSelection(normalized.fileKey, normalized.hunkIndex, document);
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

/** Identity and time every note-write consumer supplies, so projections compare cleanly. */
export const NOTE_WRITE_FACTS = {
  noteId: "conformance:note",
  timestamp: "2026-01-01T00:00:00.000Z",
} as const;

/** Project the note a write produced into the corpus's renderer-neutral shape. */
export function projectWrittenNote(
  state: ReviewState,
  outcome: ReviewIntentOutcome | undefined,
): ReviewNoteWriteProjection {
  if (outcome?.type !== "notes/created") {
    throw new Error(`The write produced ${outcome?.type ?? "nothing"}, not a note.`);
  }
  const { note, resolution } = outcome.note;
  const { anchor } = note;
  return {
    source: note.source,
    ...(note.originalSource !== undefined ? { originalSource: note.originalSource } : {}),
    ...(note.author !== undefined ? { author: note.author } : {}),
    editable: note.editable,
    file: state.document.files.findIndex((file) => file.key === note.fileKey),
    ...(note.parentId !== undefined ? { parentId: note.parentId } : {}),
    resolution,
    ...(anchor.oldRange ? { oldRange: [anchor.oldRange[0], anchor.oldRange[1]] } : {}),
    ...(anchor.newRange ? { newRange: [anchor.newRange[0], anchor.newRange[1]] } : {}),
    ...(anchor.preferred ? { preferred: anchor.preferred } : {}),
    intersectingHunkIndices: [...anchor.intersectingHunkIndices],
    ...(anchor.ownerHunkIndex !== undefined ? { ownerHunkIndex: anchor.ownerHunkIndex } : {}),
  };
}

/** State a fixture's placement as the draftless intent's placement. */
function toCreatePlacement(
  fixture: ReviewNoteWriteFixture,
  state: ReviewState,
): ReviewNoteCreatePlacement {
  const placement = fixture.placement;
  if ("parentId" in placement) {
    return { parentId: placement.parentId };
  }
  const fileKey = state.document.files[placement.file]!.key;
  return "hunkIndex" in placement
    ? { fileKey, target: { hunkIndex: placement.hunkIndex } }
    : { fileKey, target: placement.line };
}

export const intentPlannerNoteWriteConsumer: ReviewNoteWriteConsumer = {
  name: "core intent planner",
  phase: "note writes",
  project(fixture) {
    const state = fixture.build();
    const plan = planReviewIntent(
      state,
      {
        type: "notes/create",
        ...toCreatePlacement(fixture, state),
        body: { summary: fixture.summary },
      },
      { ...NOTE_WRITE_FACTS, authorship: fixture.authorship },
    );
    return projectWrittenNote(state, plan.outcome);
  },
};
