/**
 * Projects stored notes into the one record every note list reports.
 *
 * `hunk session comment list` has two modes — live agent comments, and every note — that
 * once returned different shapes built in the terminal hook. Both now read records built
 * here, so a parser written for either mode reads the other, and a note reports the same
 * position, words, and reconciliation verdict whichever list it appears in.
 */
import type { ReviewNoteSource } from "../run/commandInputs";
import { selectThreadedStoredReviewNotes } from "./selectors";
import {
  reviewNoteAnchorLine,
  reviewNoteOwnerHunkIndex,
  type ReviewNoteResolution,
  type ReviewState,
} from "./state";
import type { ReviewNoteV1, ReviewSide } from "./types";

/**
 * One note as a list reports it.
 *
 * Carries the fields of both former list shapes: `commentId`, `side`, `line`, `summary`,
 * and `rationale` from the live-comment list; `noteId`, `source`, the ranges, `body`,
 * `title`, `updatedAt`, and `editable` from the note list. `commentId` and `noteId` hold
 * the same id. For an orphaned note, the position is where the note last was.
 */
export interface ReviewNoteSummaryV1 {
  commentId: string;
  noteId: string;
  parentId?: string;
  source: ReviewNoteSource;
  filePath: string;
  hunkIndex: number;
  side: ReviewSide;
  line: number;
  oldRange?: [number, number];
  newRange?: [number, number];
  summary: string;
  rationale?: string;
  /** Summary and rationale joined by a blank line. */
  body: string;
  title?: string;
  author?: string;
  createdAt: string;
  updatedAt?: string;
  /** Whether the reviewer can edit the note in the terminal. */
  editable: boolean;
  resolution: ReviewNoteResolution;
}

/** Stand-in creation time for a note whose producer recorded none. */
const UNKNOWN_CREATED_AT = "1970-01-01T00:00:00.000Z";

/** Report one note, under the path the caller resolved for its file. */
export function projectReviewNoteSummary(
  note: ReviewNoteV1,
  filePath: string,
  resolution: ReviewNoteResolution,
): ReviewNoteSummaryV1 {
  const { side, line } = reviewNoteAnchorLine(note);
  const { oldRange, newRange } = note.anchor;
  return {
    commentId: note.id,
    noteId: note.id,
    ...(note.parentId !== undefined ? { parentId: note.parentId } : {}),
    source: note.source,
    filePath,
    hunkIndex: reviewNoteOwnerHunkIndex(note),
    side,
    line,
    ...(oldRange ? { oldRange: [oldRange[0], oldRange[1]] } : {}),
    ...(newRange ? { newRange: [newRange[0], newRange[1]] } : {}),
    summary: note.summary,
    ...(note.rationale !== undefined ? { rationale: note.rationale } : {}),
    body: [note.summary, note.rationale].filter(Boolean).join("\n\n"),
    ...(note.title !== undefined ? { title: note.title } : {}),
    ...(note.author !== undefined ? { author: note.author } : {}),
    createdAt: note.createdAt ?? UNKNOWN_CREATED_AT,
    ...(note.updatedAt !== undefined ? { updatedAt: note.updatedAt } : {}),
    editable: note.editable,
    resolution,
  };
}

/** One stored note's list record, with the review file it belongs to. */
export interface ReviewNoteSummaryEntry {
  fileKey: string;
  summary: ReviewNoteSummaryV1;
}

/**
 * List every stored note: per review file in document order, replies under their parent,
 * then notes whose file left the review.
 *
 * A note on a file the review still contains is reported under that file's path; an
 * orphaned note under the path it was written on, which its file key pins. A note whose
 * path was never recorded is left out, because the list cannot say where it is.
 */
export function selectReviewNoteSummaries(state: ReviewState): ReviewNoteSummaryEntry[] {
  const fileIndexByKey = new Map(state.document.files.map((file, index) => [file.key, index]));
  const placed: Array<ReviewNoteSummaryEntry & { fileIndex: number }> = [];
  const orphaned: ReviewNoteSummaryEntry[] = [];

  for (const { entry } of selectThreadedStoredReviewNotes(state)) {
    const fileKey = entry.note.fileKey;
    const fileIndex = fileIndexByKey.get(fileKey);
    if (fileIndex !== undefined && entry.resolution !== "orphaned") {
      const filePath = state.document.files[fileIndex]!.path;
      placed.push({
        fileKey,
        fileIndex,
        summary: projectReviewNoteSummary(entry.note, filePath, entry.resolution),
      });
      continue;
    }
    const filePath = entry.anchorContent?.filePath;
    if (filePath !== undefined) {
      orphaned.push({
        fileKey,
        summary: projectReviewNoteSummary(entry.note, filePath, entry.resolution),
      });
    }
  }

  // A stable sort keeps thread order within each file.
  placed.sort((left, right) => left.fileIndex - right.fileIndex);
  return [...placed.map(({ fileKey, summary }) => ({ fileKey, summary })), ...orphaned];
}
