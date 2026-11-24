/**
 * Projects one live review's semantic state onto the shapes agents and the session export read.
 *
 * `ReviewSessionHost` answers `hunk session` commands and publishes the daemon snapshot from
 * these projections, and the terminal review hook memoizes the same functions over its
 * render-time inputs, so a headless host and a mounted terminal report one answer for the
 * same review. Every function here is pure: it reads diff files, the projected document, and
 * a `ReviewState`, and owns no lifetime of its own.
 *
 * Runtime file ids are the session vocabulary (`fileId` in every agent reply); semantic file
 * keys are the store's. The file index below is the one crossing between the two.
 */
import { findDiffFileByPath, findHunkIndexForLine } from "../../core/liveComments";
import {
  createSidecarProjectionBudget,
  MAX_SNAPSHOT_NOTE_SUMMARY_BYTES,
} from "../../core/review/noteSize";
import { utf8ByteLength } from "../../core/review/validation";
import {
  buildReviewAnnotationIndex,
  reviewAnnotationAnchor,
  reviewNoteSource,
  type ReviewAnnotationTarget,
} from "../../core/review/annotations";
import { projectReviewNoteSummary } from "../../core/review/noteSummary";
import { reviewHunkRanges } from "../../core/review/geometry";
import type { ReviewAnnotationIndex } from "../../core/review/navigation";
import type { ReviewAction } from "../../core/review/actions";
import {
  selectNormalizedSelection,
  selectThreadedStoredReviewNotes,
} from "../../core/review/selectors";
import {
  isRenderableStoredReviewNote,
  reviewNoteAnchorLine,
  reviewNoteOwnerHunkIndex,
  type ReviewState,
  type ReviewStoredNote,
} from "../../core/review/state";
import type { ReviewDocument, ReviewNote } from "../../core/review/types";
import type { DiffFile } from "../../core/changeset/model";
import type { AgentAnnotation } from "../../extension-api/types";
import { noDiffFileMatchesMessage } from "../../session/agent/errors";
import type {
  HunkSessionState,
  NavigateToHunkToolInput,
  SelectedHunkSummary,
  SessionNoteSummary,
} from "../../session/types";

/** Lookups between runtime file ids and the semantic file keys of one projected document. */
export interface ReviewFileIndex {
  keyByFileId: ReadonlyMap<string, string>;
  fileByKey: ReadonlyMap<string, DiffFile>;
}

export interface ReviewNavigationTarget {
  file: DiffFile;
  hunkIndex: number;
}

/** Index one document's files by runtime id and by semantic key. */
export function indexReviewFiles(
  document: ReviewDocument,
  files: readonly DiffFile[],
): ReviewFileIndex {
  const byRuntimeId = new Map(files.map((file) => [file.id, file] as const));
  return {
    keyByFileId: new Map(document.files.map((file) => [file.runtimeId, file.key] as const)),
    fileByKey: new Map(
      document.files.flatMap((semantic) => {
        const file = byRuntimeId.get(semantic.runtimeId);
        return file ? [[semantic.key, file] as const] : [];
      }),
    ),
  };
}

/** Copy one note's anchor ranges in the annotation shape diff files carry. */
function noteRanges(note: ReviewNote) {
  return {
    oldRange: note.anchor.oldRange ? ([...note.anchor.oldRange] as [number, number]) : undefined,
    newRange: note.anchor.newRange ? ([...note.anchor.newRange] as [number, number]) : undefined,
  };
}

/**
 * Index which files and hunks the review's notes reach, for annotated navigation.
 *
 * Sidecar annotations and every renderable stored note count, merged onto their files the
 * way the review stream draws them, so a live comment that just arrived is navigable at once.
 * Stored notes declare their owner hunk and line, as drawing places them; sidecar
 * annotations resolve from geometry alone.
 */
export function buildReviewSessionAnnotationIndex(
  files: readonly DiffFile[],
  fileIndex: ReviewFileIndex,
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
): ReviewAnnotationIndex {
  const targets = new Map<AgentAnnotation, ReviewAnnotationTarget>();
  const storedByFileId = new Map<string, AgentAnnotation[]>();
  for (const { entry } of selectThreadedStoredReviewNotes(state)) {
    const file = fileIndex.fileByKey.get(entry.note.fileKey);
    if (!file || !isRenderableStoredReviewNote(entry)) {
      continue;
    }

    const annotation: AgentAnnotation = { ...noteRanges(entry.note), summary: entry.note.summary };
    targets.set(annotation, {
      hunkIndex: reviewNoteOwnerHunkIndex(entry.note),
      ...reviewNoteAnchorLine(entry.note),
    });
    const stored = storedByFileId.get(file.id) ?? [];
    stored.push(annotation);
    storedByFileId.set(file.id, stored);
  }

  const merged = files.map((file) => {
    const stored = storedByFileId.get(file.id);
    return stored
      ? {
          ...file,
          agent: {
            path: file.path,
            summary: file.agent?.summary,
            annotations: [...(file.agent?.annotations ?? []), ...stored],
          },
        }
      : file;
  });
  return buildReviewAnnotationIndex(merged, fileIndex.keyByFileId, (annotation) =>
    targets.get(annotation),
  );
}

/** Format one stored note as the record both snapshot note lists carry. */
function storedNoteSummary(file: DiffFile, entry: ReviewStoredNote): SessionNoteSummary {
  return projectReviewNoteSummary(entry.note, file.path, entry.resolution);
}

/** The two note lists one daemon snapshot carries, bounded together. */
export interface SessionNoteSummaries {
  liveComments: SessionNoteSummary[];
  reviewNotes: SessionNoteSummary[];
}

/**
 * List the live comments and inline notes a daemon snapshot publishes, within one byte budget.
 *
 * Live comments come in file order then arrival order; inline notes come per file as sidecar
 * annotations and then stored notes in thread order. The snapshot repeats each stored note's
 * text in both lists, so the daemon's per-session ceiling is shared by both lists and the
 * sidecar annotations (`MAX_SNAPSHOT_NOTE_SUMMARY_BYTES`). Stored notes claim the budget first,
 * in thread order, so the reviewer's own notes and agent comments outrank launch-input sidecar
 * annotations; the first note that does not fit closes the stored share (a later one never
 * appears without an earlier one, so a reply keeps its parent). The sidecar annotations then
 * take what is left, up to their own bound. The review itself is untouched: the terminal keeps
 * and draws every note, and only this projection stops.
 */
export function buildSessionNoteSummaries(
  files: readonly DiffFile[],
  fileIndex: ReviewFileIndex,
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
): SessionNoteSummaries {
  const liveIds = new Set(state.liveNotes.map((entry) => entry.note.id));
  const storedByFileId = new Map<string, ReviewNote[]>();
  const noteSummaryById = new Map<string, SessionNoteSummary>();
  const liveSummaryById = new Map<string, SessionNoteSummary>();
  let remainingBytes = MAX_SNAPSHOT_NOTE_SUMMARY_BYTES;
  let storedShareClosed = false;

  for (const { entry } of selectThreadedStoredReviewNotes(state)) {
    const file = fileIndex.fileByKey.get(entry.note.fileKey);
    if (!file || !isRenderableStoredReviewNote(entry) || storedShareClosed) {
      continue;
    }

    const noteSummary = storedNoteSummary(file, entry);
    const liveSummary = liveIds.has(entry.note.id) ? noteSummary : undefined;
    // One byte per summary covers the comma that frames it in its list.
    const size =
      utf8ByteLength(JSON.stringify(noteSummary)) +
      1 +
      (liveSummary ? utf8ByteLength(JSON.stringify(liveSummary)) + 1 : 0);
    if (size > remainingBytes) {
      storedShareClosed = true;
      continue;
    }

    remainingBytes -= size;
    noteSummaryById.set(entry.note.id, noteSummary);
    if (liveSummary) {
      liveSummaryById.set(entry.note.id, liveSummary);
    }
    const notes = storedByFileId.get(file.id) ?? [];
    notes.push(entry.note);
    storedByFileId.set(file.id, notes);
  }

  const liveNotesByFileId = new Map<string, ReviewNote[]>();
  for (const entry of state.liveNotes) {
    const file = fileIndex.fileByKey.get(entry.note.fileKey);
    if (!file || !liveSummaryById.has(entry.note.id)) {
      continue;
    }
    const notes = liveNotesByFileId.get(file.id) ?? [];
    notes.push(entry.note);
    liveNotesByFileId.set(file.id, notes);
  }

  const liveComments = files.flatMap((file) =>
    (liveNotesByFileId.get(file.id) ?? []).map((note) => liveSummaryById.get(note.id)!),
  );

  const reviewNotes: SessionNoteSummary[] = [];
  // Sidecar annotations are launch input and never fail a review; past the projected count or
  // byte bound, or the bytes stored notes left, the snapshot omits the rest so the daemon keeps
  // accepting it (the terminal still draws them all).
  const sidecarBudget = createSidecarProjectionBudget(remainingBytes);
  for (const file of files) {
    (file.agent?.annotations ?? []).forEach((annotation, index) => {
      const source = reviewNoteSource(annotation);
      const summary = projectReviewNoteSummary(
        {
          id: annotation.id ?? `${source}:${file.id}:${index}`,
          source,
          fileKey: fileIndex.keyByFileId.get(file.id) ?? file.id,
          anchor: reviewAnnotationAnchor(file.metadata.hunks, annotation),
          summary: annotation.summary,
          rationale: annotation.rationale,
          title: annotation.title,
          author: annotation.author,
          createdAt: annotation.createdAt,
          updatedAt: annotation.updatedAt,
          editable: false,
        },
        file.path,
        "active",
      );
      if (sidecarBudget.admitSize(utf8ByteLength(JSON.stringify(summary)))) {
        reviewNotes.push(summary);
      }
    });

    for (const note of storedByFileId.get(file.id) ?? []) {
      reviewNotes.push(noteSummaryById.get(note.id)!);
    }
  }

  return { liveComments, reviewNotes };
}

/** List the agent live comments a daemon snapshot publishes; see `buildSessionNoteSummaries`. */
export function buildLiveCommentSummaries(
  files: readonly DiffFile[],
  fileIndex: ReviewFileIndex,
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
): SessionNoteSummary[] {
  return buildSessionNoteSummaries(files, fileIndex, state).liveComments;
}

/** List every inline note a daemon snapshot publishes; see `buildSessionNoteSummaries`. */
export function buildReviewNoteSummaries(
  files: readonly DiffFile[],
  fileIndex: ReviewFileIndex,
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
): SessionNoteSummary[] {
  return buildSessionNoteSummaries(files, fileIndex, state).reviewNotes;
}

/**
 * Plan the follow-up when a document replacement invalidates the stored selection.
 *
 * A filter only changes the visible stream, so a selected file it hides stays selected. The
 * shared selector supplies a replacement only when the selected file vanished or its hunk index
 * became stale. This returns no reveal request: repair must not move a viewport.
 */
export function planReviewSelectionRepair(
  state: ReviewState,
): Extract<ReviewAction, { type: "selection/select" }> | undefined {
  const normalized = selectNormalizedSelection(state);
  const fileKey = normalized.fileKey;
  if (
    fileKey === null ||
    (fileKey === state.selection.fileKey && normalized.hunkIndex === state.selection.hunkIndex)
  ) {
    return undefined;
  }

  return { type: "selection/select", fileKey, hunkIndex: normalized.hunkIndex };
}

/** Format the currently selected hunk for daemon snapshots and session command replies. */
export function buildSelectedHunkSummary(file: DiffFile, hunkIndex: number): SelectedHunkSummary {
  const hunk = file.metadata.hunks[hunkIndex];
  return hunk
    ? {
        index: hunkIndex,
        ...reviewHunkRanges(hunk),
      }
    : {
        index: hunkIndex,
      };
}

/**
 * Resolve one absolute session-daemon navigation request against the review stream.
 *
 * Absolute only — a path plus either a hunk index or a side and line. Relative requests
 * (`--next-comment` / `--prev-comment`) are the same walk the keyboard performs and are
 * planned through the shared `selection/move` intent instead of being resolved here.
 */
export function resolveReviewNavigationTarget({
  allFiles,
  input,
}: {
  allFiles: DiffFile[];
  input: NavigateToHunkToolInput;
}): ReviewNavigationTarget {
  if (!input.filePath) {
    throw new Error("navigate requires --file when not using --next-comment or --prev-comment.");
  }

  const file = findDiffFileByPath(allFiles, input.filePath);
  if (!file) {
    throw new Error(noDiffFileMatchesMessage(input.filePath));
  }

  let hunkIndex = input.hunkIndex;
  if (hunkIndex === undefined) {
    if (!input.side || input.line === undefined) {
      throw new Error("navigate_to_hunk requires either hunkIndex or both side and line.");
    }

    hunkIndex = findHunkIndexForLine(file, input.side, input.line);
  }

  if (hunkIndex < 0 || hunkIndex >= file.metadata.hunks.length) {
    throw new Error(`No diff hunk in ${input.filePath} matches the requested target.`);
  }

  return { file, hunkIndex };
}

/** Facts one session snapshot reports beside the review's own state. */
export interface SessionSnapshotStateInput {
  selectedFile: Pick<DiffFile, "id" | "path"> | undefined;
  selectedHunk: DiffFile["metadata"]["hunks"][number] | undefined;
  selectedHunkIndex: number;
  showAgentNotes: boolean;
  /** Width STML note markup renders at, when a renderer measured one. */
  noteMarkupWidth?: number;
  liveCommentCount: number;
  liveComments: SessionNoteSummary[];
  reviewNoteCount: number;
  reviewNotes: SessionNoteSummary[];
  /** The producer generation being served, when one is published. */
  publicationGeneration?: string;
  stateRevision: number;
  /** The shared-state revision at this position, when the producer serves shared state. */
  sharedStateRevision?: number;
}

/**
 * Build the live state one session snapshot publishes to the daemon.
 *
 * Callers count from the summary lists they pass: the daemon refuses a snapshot whose count
 * differs from its list.
 */
export function buildSessionSnapshotState(input: SessionSnapshotStateInput): HunkSessionState {
  const selectedRange = input.selectedHunk ? reviewHunkRanges(input.selectedHunk) : undefined;
  return {
    selectedFileId: input.selectedFile?.id,
    selectedFilePath: input.selectedFile?.path,
    selectedHunkIndex: input.selectedHunkIndex,
    selectedHunkOldRange: selectedRange?.oldRange,
    selectedHunkNewRange: selectedRange?.newRange,
    showAgentNotes: input.showAgentNotes,
    noteMarkupWidth: input.noteMarkupWidth,
    liveCommentCount: input.liveCommentCount,
    liveComments: input.liveComments,
    reviewNoteCount: input.reviewNoteCount,
    reviewNotes: input.reviewNotes,
    // Where this review currently is, so the daemon's mirror can order what it receives
    // instead of guessing whether a snapshot is newer than the last.
    ...(input.publicationGeneration
      ? {
          reviewPublication: {
            generation: input.publicationGeneration,
            stateRevision: input.stateRevision,
          },
          ...(input.sharedStateRevision !== undefined
            ? { reviewSharedStateRevision: input.sharedStateRevision }
            : {}),
        }
      : {}),
  };
}
