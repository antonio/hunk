/**
 * Agent session comments: the shapes `hunk session comment` sends, and their lowering into
 * the note writes core plans.
 *
 * Agents address a comment by file path and hunk or line, or as a reply; everything about
 * where it lands and whether it is accepted is decided by `planReviewIntent`, the same
 * planner the composer's notes go through.
 */
import type { AgentAnnotation } from "../extension-api/types";
import type { DiffFile } from "./changeset/model";
import type { ReviewNoteAuthorship } from "./review/authorship";
import { reviewHunkIndexForLine } from "./review/geometry";
import { reviewNoteBody, type ReviewIntent } from "./review/intents";
import type { ReviewNote } from "./review/types";

export type DiffSide = "old" | "new";

/**
 * The one diff line a user note hangs on: which side of the hunk, and the line
 * number on that side. Surfaces resolve a click or cursor position into this
 * before asking for a note, so the note's anchor never depends on rendered rows.
 */
export interface UserNoteLineTarget {
  side: DiffSide;
  line: number;
}

export interface CommentBodyInput {
  summary: string;
  rationale?: string;
  /** Optional STML markup rendered as the note body (see packages/hunk/src/ui/lib/stml). */
  markup?: string;
  author?: string;
}

export type CommentTargetInput = CommentBodyInput &
  (
    | {
        filePath: string;
        hunkIndex: number;
        side?: DiffSide;
        line?: number;
        replyTo?: never;
      }
    | {
        filePath: string;
        hunkIndex?: never;
        side: DiffSide;
        line: number;
        replyTo?: never;
      }
    | {
        filePath?: never;
        hunkIndex?: never;
        side?: never;
        line?: never;
        /** Existing semantic note whose file and anchor this reply inherits. */
        replyTo: string;
      }
  );

export interface LiveComment extends AgentAnnotation {
  id: string;
  parentId?: string;
  source: "mcp";
  author?: string;
  createdAt: string;
  filePath: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
}

/** Find the diff file matching one current or previous path. */
export function findDiffFileByPath(files: DiffFile[], filePath: string) {
  return files.find((file) => file.path === filePath || file.previousPath === filePath);
}

/** Find the first hunk covering one requested side/line location. */
export function findHunkIndexForLine(file: DiffFile, side: DiffSide, line: number) {
  return reviewHunkIndexForLine(file.metadata.hunks, side, line);
}

/** Who every session comment write is from: an agent, labelled by `--author` when given. */
function sessionCommentAuthorship(label: string | undefined): ReviewNoteAuthorship {
  return { source: "agent", channel: "session-cli", ...(label !== undefined ? { label } : {}) };
}

/** One agent session comment, lowered to the note write core plans and who it is from. */
export interface SessionCommentWrite {
  intent: Extract<ReviewIntent, { type: "notes/create" }>;
  authorship: ReviewNoteAuthorship;
}

/**
 * Lower one agent session comment into the note write core plans.
 *
 * The session commands accept a comment as a file path plus a hunk index or one line, or as
 * a reply to an existing note. This checks that shape, resolves the path through the caller
 * (which owns the wording for a path the review does not contain), and states the session
 * channel's conventions: agent authorship labelled by `--author`, the `mcp` tag, and high
 * confidence. Placement, reply, size, and blank-body rules belong to the planner.
 */
export function lowerSessionComment(
  input: CommentTargetInput,
  resolveFileKey: (filePath: string) => string,
): SessionCommentWrite {
  const body = {
    summary: input.summary,
    ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    ...(input.markup !== undefined ? { markup: input.markup } : {}),
    tags: ["mcp"],
    confidence: "high" as const,
  };
  const authorship = sessionCommentAuthorship(input.author);

  if (input.replyTo !== undefined) {
    if (
      input.filePath !== undefined ||
      input.hunkIndex !== undefined ||
      input.side !== undefined ||
      input.line !== undefined
    ) {
      throw new Error("A reply comment must not include an explicit file or target.");
    }
    return { intent: { type: "notes/create", parentId: input.replyTo, body }, authorship };
  }

  const filePath = input.filePath;
  if (!filePath) {
    throw new Error("A root comment requires a file path.");
  }
  const fileKey = resolveFileKey(filePath);
  if (input.hunkIndex !== undefined) {
    return {
      intent: { type: "notes/create", fileKey, target: { hunkIndex: input.hunkIndex }, body },
      authorship,
    };
  }
  if (input.side === undefined || input.line === undefined) {
    throw new Error(`Specify either hunkIndex or both side and line for ${filePath}.`);
  }
  return {
    intent: {
      type: "notes/create",
      fileKey,
      target: { side: input.side, line: input.line },
      body,
    },
    authorship,
  };
}

/** The words `hunk session comment edit` replaces; each one it omits keeps its value. */
export interface SessionCommentEditInput {
  summary?: string;
  rationale?: string;
}

/** One agent comment edit, lowered to the note update core plans and who it is from. */
export interface SessionCommentEditWrite {
  intent: Extract<ReviewIntent, { type: "notes/update" }>;
  authorship: ReviewNoteAuthorship;
}

/**
 * Lower one `hunk session comment edit` into the note update core plans.
 *
 * The update replaces a note's whole body, so the words the command leaves out are carried
 * over from `note`. Whether the agent may edit the note at all is the planner's authorship
 * rule, not decided here.
 */
export function lowerSessionCommentEdit(
  note: ReviewNote,
  input: SessionCommentEditInput,
): SessionCommentEditWrite {
  return {
    intent: {
      type: "notes/update",
      noteId: note.id,
      body: {
        ...reviewNoteBody(note),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      },
    },
    authorship: sessionCommentAuthorship(undefined),
  };
}
