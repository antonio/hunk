/**
 * Decides who a note write is attributed to and which notes a writer may change.
 *
 * The channel a write arrives on decides whether it writes a reviewer note or an agent
 * note; nothing in the request body can choose it. Each edge that receives writes — the
 * terminal composer, the review surface, the agent session commands — states its
 * authorship as a caller-supplied fact, the same way it supplies a note id and a
 * timestamp, and core applies the rules below to every write.
 *
 * The rule keeps provenance honest by default. It is not a security boundary: every
 * channel runs as the same OS user, so a process determined to impersonate a reviewer
 * can reach a reviewer channel.
 */
import type { ReviewNoteV1 } from "./types";

/**
 * Where a note write entered Hunk.
 *
 * `terminal` is the reviewer at the TUI composer, `review-client` a client of the review
 * surface acting for a person, and `session-cli` an agent using `hunk session` commands.
 */
export type ReviewNoteChannel = "terminal" | "review-client" | "session-cli";

/** Who one write is attributed to; supplied by the edge that received it, never by the request. */
export interface ReviewNoteAuthorship {
  /** `user` writes reviewer notes, `agent` writes agent notes. */
  source: "user" | "agent";
  /** Shown as the note's author; reviewer notes without one are shown as `user`. */
  label?: string;
  channel: ReviewNoteChannel;
}

/** The authorship of every note the terminal composer saves: the reviewer, at the terminal. */
export const TERMINAL_REVIEWER_AUTHORSHIP: ReviewNoteAuthorship = {
  source: "user",
  channel: "terminal",
};

/**
 * The authorship of every note a review client writes: the person using the client.
 *
 * Carries no label yet; the client's display name becomes one once the review surface
 * attributes writes to the actor that sent them.
 */
export const REVIEW_CLIENT_AUTHORSHIP: ReviewNoteAuthorship = {
  source: "user",
  channel: "review-client",
};

/**
 * The raw producer label a note written on one channel records.
 *
 * Agent session commands have always recorded `mcp`, and snapshot consumers read it, so
 * the label stays per channel rather than following the normalized source.
 */
const ORIGINAL_SOURCE_BY_CHANNEL: Record<ReviewNoteChannel, string> = {
  terminal: "user",
  "review-client": "user",
  "session-cli": "mcp",
};

/** The provenance fields a newly written note carries for one authorship. */
export function reviewNoteProvenance(
  authorship: ReviewNoteAuthorship,
): Pick<ReviewNoteV1, "source" | "originalSource" | "author" | "editable"> {
  const label = authorship.label ?? (authorship.source === "user" ? "user" : undefined);
  return {
    source: authorship.source,
    originalSource: ORIGINAL_SOURCE_BY_CHANNEL[authorship.channel],
    ...(label !== undefined ? { author: label } : {}),
    // `editable` keeps its published meaning: the reviewer can edit this note in the TUI.
    editable: authorship.source === "user",
  };
}

/**
 * Whether a writer with this authorship may change one stored note.
 *
 * Reviewer channels edit editable reviewer notes; agent channels edit agent notes. Neither
 * can rewrite the other's words.
 */
export function reviewNoteWritableBy(note: ReviewNoteV1, authorship: ReviewNoteAuthorship) {
  return authorship.source === "user"
    ? note.source === "user" && note.editable
    : note.source === "agent";
}
