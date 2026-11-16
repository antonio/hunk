/**
 * Builds `ctx.review.notes`: the note writes extension commands and event handlers make on
 * the live review.
 *
 * An extension is a writer like the terminal composer or an agent's session command, so its
 * writes go through the same core planner with the same rules — placement, reply parents,
 * size, blank bodies, and who may edit which note. What is particular to this edge is that
 * extension code is untrusted input: every request is checked here before it becomes an
 * intent, and every refusal comes back as a result instead of an exception, so a mistaken
 * extension cannot take a command down with it. Each write states whether it acts for the
 * reviewer or as an agent; Hunk supplies the note id and time.
 *
 * Controls are minted per review generation; once that generation is gone they refuse every
 * write with `unavailable`.
 */
import { findDiffFileByPath } from "../core/liveComments";
import type { ReviewNoteAuthorship } from "../core/review/authorship";
import {
  ReviewIntentPlanningError,
  type ReviewIntent,
  type ReviewIntentFacts,
  type ReviewIntentOutcome,
} from "../core/review/intents";
import { selectStoredReviewNoteById } from "../core/review/selectors";
import type { ReviewState } from "../core/review/state";
import type { ReviewNoteBodyV1, ReviewNoteTargetV1 } from "../core/review/types";
import type {
  ExtensionReviewNoteAuthor,
  ExtensionReviewNoteControls,
  ExtensionReviewNoteWriteResult,
} from "../extension-api/types";
import { projectExtensionReviewNote } from "./reviewSnapshot";

/** The review a set of note controls writes to, as the review producer exposes it. */
export interface ExtensionNoteWriteReview {
  getPositionedReviewState(): { generation: string; state: ReviewState } | undefined;
  applyIntent(intent: ReviewIntent, facts?: ReviewIntentFacts): unknown;
}

/** What a set of note controls needs from its host. */
export interface ExtensionReviewNoteControlsOptions {
  /** False once the review generation these controls belong to is gone. */
  isLive: () => boolean;
  /** The current review, or undefined while none is mounted. */
  getReview: () => ExtensionNoteWriteReview | undefined;
  /** Mint one fresh unique id fragment; production uses `crypto.randomUUID`. */
  newId?: () => string;
  /** Current time as an ISO string. */
  now?: () => string;
}

/** One refusal, in the result shape extensions read. */
function refuse(code: string, message: string): ExtensionReviewNoteWriteResult {
  return Object.freeze({ ok: false, code, message });
}

const UNAVAILABLE = refuse(
  "unavailable",
  "These note controls belong to a review that is no longer current.",
);

/** Whether a value is a plain object an extension passed as a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the authorship one write states, or undefined when it states none Hunk accepts. */
function parseAuthor(value: unknown): ExtensionReviewNoteAuthor | undefined {
  return value === "user" || value === "agent" ? value : undefined;
}

/** Copy a note body an extension passed, or undefined when any field has the wrong type. */
function parseBody(value: unknown): ReviewNoteBodyV1 | undefined {
  if (!isRecord(value) || typeof value.summary !== "string") return undefined;
  const optionalString = (field: unknown) => field === undefined || typeof field === "string";
  if (
    !optionalString(value.rationale) ||
    !optionalString(value.markup) ||
    !optionalString(value.title) ||
    (value.tags !== undefined &&
      (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string"))) ||
    (value.confidence !== undefined &&
      value.confidence !== "low" &&
      value.confidence !== "medium" &&
      value.confidence !== "high")
  ) {
    return undefined;
  }
  return {
    summary: value.summary,
    ...(value.rationale !== undefined ? { rationale: value.rationale as string } : {}),
    ...(value.markup !== undefined ? { markup: value.markup as string } : {}),
    ...(value.title !== undefined ? { title: value.title as string } : {}),
    ...(value.tags !== undefined ? { tags: [...(value.tags as string[])] } : {}),
    ...(value.confidence !== undefined
      ? { confidence: value.confidence as ReviewNoteBodyV1["confidence"] }
      : {}),
  };
}

/** Whether a value is a non-negative integer, as a hunk index is. */
function isIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Lower one create request to the core intent, or a refusal naming what is wrong with it.
 *
 * The review is read for one thing only: which file key a path names. Everything else about
 * placement is the planner's.
 */
function lowerCreate(
  input: unknown,
  state: ReviewState,
): { intent: ReviewIntent; authorship: ReviewNoteAuthorship } | ExtensionReviewNoteWriteResult {
  if (!isRecord(input)) return refuse("invalid-request", "A note request must be an object.");
  const as = parseAuthor(input.as);
  if (!as) {
    return refuse("invalid-request", 'A note write must state as: "user" or as: "agent".');
  }
  if (input.label !== undefined && typeof input.label !== "string") {
    return refuse("invalid-request", "A note label must be a string.");
  }
  const body = parseBody(input.body);
  if (!body) {
    return refuse("invalid-request", "A note body needs a string summary and well-typed fields.");
  }
  const authorship: ReviewNoteAuthorship = {
    source: as,
    channel: "extension",
    ...(input.label !== undefined ? { label: input.label as string } : {}),
  };

  const hasRootField =
    input.filePath !== undefined ||
    input.hunkIndex !== undefined ||
    input.side !== undefined ||
    input.line !== undefined;
  if (input.parentId !== undefined) {
    if (typeof input.parentId !== "string" || hasRootField) {
      return refuse("invalid-request", "A reply names only parentId, as a string.");
    }
    return { intent: { type: "notes/create", parentId: input.parentId, body }, authorship };
  }

  if (typeof input.filePath !== "string") {
    return refuse("invalid-request", "A root note names filePath, or a reply names parentId.");
  }
  const file = findDiffFileByPath(state.document.files, input.filePath);
  if (!file) {
    return refuse("file-not-found", `No review file matches ${input.filePath}.`);
  }

  let target: ReviewNoteTargetV1 | { hunkIndex: number };
  if (input.hunkIndex !== undefined && input.side === undefined && input.line === undefined) {
    if (!isIndex(input.hunkIndex)) {
      return refuse("invalid-request", "hunkIndex must be a non-negative integer.");
    }
    target = { hunkIndex: input.hunkIndex };
  } else if (
    input.hunkIndex === undefined &&
    (input.side === "old" || input.side === "new") &&
    Number.isSafeInteger(input.line) &&
    (input.line as number) > 0
  ) {
    target = { side: input.side, line: input.line as number };
  } else {
    return refuse(
      "invalid-request",
      "A root note names either hunkIndex, or side and a positive line, but not both.",
    );
  }
  return { intent: { type: "notes/create", fileKey: file.key, target, body }, authorship };
}

/** Build one set of note controls bound to a review generation. */
export function createExtensionReviewNoteControls({
  isLive,
  getReview,
  newId = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
}: ExtensionReviewNoteControlsOptions): ExtensionReviewNoteControls {
  /** Run one write against the live review, turning planner refusals into results. */
  const write = (
    plan: (
      review: ExtensionNoteWriteReview,
      state: ReviewState,
    ) => { intent: ReviewIntent; facts: ReviewIntentFacts } | ExtensionReviewNoteWriteResult,
    report: (outcome: ReviewIntentOutcome, before: ReviewState) => ExtensionReviewNoteWriteResult,
  ): ExtensionReviewNoteWriteResult => {
    const review = isLive() ? getReview() : undefined;
    const positioned = review?.getPositionedReviewState();
    if (!review || !positioned) return UNAVAILABLE;

    const lowered = plan(review, positioned.state);
    if ("ok" in lowered) return lowered;
    try {
      const outcome = review.applyIntent(lowered.intent, lowered.facts) as ReviewIntentOutcome;
      return report(outcome, positioned.state);
    } catch (error) {
      if (error instanceof ReviewIntentPlanningError) return refuse(error.code, error.message);
      throw error;
    }
  };

  /** Report the note a create or update stored, as the public contract shows it. */
  const reportStored = (outcome: ReviewIntentOutcome): ExtensionReviewNoteWriteResult =>
    outcome.type === "notes/created" || outcome.type === "notes/updated"
      ? Object.freeze({ ok: true, note: projectExtensionReviewNote(outcome.note) })
      : refuse("invalid-request", "The write did not store a note.");

  const controls: ExtensionReviewNoteControls = {
    create(input) {
      return write((_review, state) => {
        const lowered = lowerCreate(input, state);
        if ("ok" in lowered) return lowered;
        // `user:` ids are what the session commands recognize as reviewer notes.
        const prefix = lowered.authorship.source === "user" ? "user" : "extension";
        return {
          intent: lowered.intent,
          facts: {
            noteId: `${prefix}:${newId()}`,
            timestamp: now(),
            authorship: lowered.authorship,
          },
        };
      }, reportStored);
    },

    update(noteId, body, options) {
      return write(() => {
        const as = parseAuthor(isRecord(options) ? options.as : undefined);
        if (!as) {
          return refuse("invalid-request", 'A note write must state as: "user" or as: "agent".');
        }
        const parsed = parseBody(body);
        if (typeof noteId !== "string" || !parsed) {
          return refuse("invalid-request", "update takes a note id and a body with a summary.");
        }
        return {
          intent: { type: "notes/update", noteId, body: parsed },
          facts: { timestamp: now(), authorship: { source: as, channel: "extension" } },
        };
      }, reportStored);
    },

    remove(noteId) {
      return write(
        (_review, state) => {
          if (typeof noteId !== "string") {
            return refuse("invalid-request", "remove takes a note id.");
          }
          const collection = state.userNotes.some(({ note }) => note.id === noteId)
            ? "notes/remove-user"
            : "notes/remove-live";
          return { intent: { type: collection, noteId }, facts: {} };
        },
        (_outcome, before) => {
          const removed = selectStoredReviewNoteById(before, noteId as string)!;
          return Object.freeze({ ok: true, note: projectExtensionReviewNote(removed) });
        },
      );
    },
  };
  return Object.freeze(controls);
}
