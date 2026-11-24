/**
 * Projects one note into the record every note list reports.
 *
 * `hunk session comment list` has two modes — live agent comments, and every note — that
 * once returned different shapes. Both now carry records built here
 * (`app/review/reviewSessionProjections.ts` decides which notes each list holds), so a parser
 * written for either mode reads the other, and a note reports the same position, words, and
 * reconciliation verdict whichever list it appears in.
 */
import type { ReviewNoteSource } from "../run/commandInputs";
import { reviewNoteAnchorLine, reviewNoteOwnerHunkIndex, type ReviewNoteResolution } from "./state";
import type { ReviewNote, ReviewSide } from "./types";

/**
 * One note as the session snapshot carries it: each fact once.
 *
 * Carries the fields both list shapes need — the position (`hunkIndex`, `side`, `line`,
 * ranges), the words (`summary`, `rationale`, `title`), and provenance (`source`, `author`,
 * `editable`, timestamps). `resolution` is absent while the note is active, and the list
 * record's derived fields are added by `reviewNoteListRecord`, so the snapshot stays within
 * the byte bounds sized for the earlier shapes.
 */
export interface ReviewNoteSummary {
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
  title?: string;
  author?: string;
  createdAt: string;
  updatedAt?: string;
  /** Whether the reviewer can edit the note in the terminal. */
  editable: boolean;
  /** Absent while the note is active. */
  resolution?: Exclude<ReviewNoteResolution, "active">;
}

/**
 * One note as every `comment list` mode reports it.
 *
 * Carries the fields of both former list shapes: `commentId`, `side`, `line`, `summary`,
 * and `rationale` from the live-comment list; `noteId`, `source`, the ranges, `body`,
 * `title`, `updatedAt`, and `editable` from the note list. `commentId` and `noteId` hold
 * the same id, and `resolution` is always present.
 */
export interface ReviewNoteListRecord extends Omit<ReviewNoteSummary, "resolution"> {
  commentId: string;
  /** Summary and rationale joined by a blank line. */
  body: string;
  resolution: ReviewNoteResolution;
}

/** Stand-in creation time for a note whose producer recorded none. */
const UNKNOWN_CREATED_AT = "1970-01-01T00:00:00.000Z";

/** Report one note, under the path the caller resolved for its file. */
export function projectReviewNoteSummary(
  note: ReviewNote,
  filePath: string,
  resolution: ReviewNoteResolution,
): ReviewNoteSummary {
  const { side, line } = reviewNoteAnchorLine(note);
  const { oldRange, newRange } = note.anchor;
  return {
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
    ...(note.title !== undefined ? { title: note.title } : {}),
    ...(note.author !== undefined ? { author: note.author } : {}),
    createdAt: note.createdAt ?? UNKNOWN_CREATED_AT,
    ...(note.updatedAt !== undefined ? { updatedAt: note.updatedAt } : {}),
    editable: note.editable,
    ...(resolution !== "active" ? { resolution } : {}),
  };
}

/** Expand one snapshot note into the record every `comment list` mode reports. */
export function reviewNoteListRecord(summary: ReviewNoteSummary): ReviewNoteListRecord {
  const { resolution, ...fields } = summary;
  return {
    commentId: summary.noteId,
    ...fields,
    body: [summary.summary, summary.rationale].filter(Boolean).join("\n\n"),
    resolution: resolution ?? "active",
  };
}
