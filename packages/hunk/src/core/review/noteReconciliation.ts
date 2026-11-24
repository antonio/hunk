/**
 * Places notes a store saved in an earlier launch on the review they are restored into.
 *
 * A saved note is attached to the text of its lines, not to a commit or a line number: it is
 * active when that text is still at its line, follows the text when it moved and appears
 * exactly once on the same side, and is stale otherwise. A note whose file is not in the
 * review is orphaned. Only exact, unique matches move a note. A line the review cannot show —
 * outside every hunk, with no loaded source behind it — cannot be checked, so its note counts
 * as stale unless the whole file is unchanged.
 *
 * This runs once per restored note, at restore. While Hunk runs, reloads judge stored notes by
 * the review's own rule (`reconcileReviewNoteResolution` in `state.ts`).
 */
import { resolveReviewNoteAnchor, reviewGapOwnerHunkIndex } from "./anchors";
import { normalizedReviewSourceLines } from "./geometry";
import { reviewExpansionSide } from "./expansion";
import type { ReviewSourceStatus, ReviewStoredNote } from "./state";
import type {
  ReviewFile,
  ReviewLineAddress,
  ReviewLineRange,
  ReviewRangeAnchor,
  ReviewSide,
} from "./types";

const REVIEW_SIDES: readonly ReviewSide[] = ["old", "new"];

/**
 * What a store recorded about a note's anchored lines when it first saved the note.
 *
 * A side is absent when the review could not read its lines then; placement falls back to the
 * file's content identity for that side.
 */
export interface ReviewNoteRecordedLines {
  /** Content identity of the note's file when its lines were recorded. */
  contentIdentity: string;
  /** Text of each anchored old-side line, in line order. */
  old?: readonly string[];
  /** Text of each anchored new-side line, in line order. */
  new?: readonly string[];
}

/** Drop the line terminator a parsed diff line may still carry. */
function lineContent(text: string) {
  return text.replace(/\r?\n$/, "");
}

/**
 * Map every line number the review can read on one side to its text.
 *
 * Patch lines come from the hunks; loaded full source, when it backs this side, supplies
 * every other line too.
 */
function readableSideLines(
  file: ReviewFile,
  side: ReviewSide,
  source: ReviewSourceStatus | undefined,
): Map<number, string> {
  const lines = new Map<number, string>();
  const sideLines = side === "old" ? file.deletionLines : file.additionLines;

  for (const hunk of file.hunks) {
    let line = side === "old" ? hunk.deletionStart : hunk.additionStart;
    for (const block of hunk.hunkContent) {
      const count =
        block.type === "context" ? block.lines : side === "old" ? block.deletions : block.additions;
      const index = side === "old" ? block.deletionLineIndex : block.additionLineIndex;
      for (let offset = 0; offset < count; offset += 1) {
        const text = sideLines[index + offset];
        if (text !== undefined) {
          lines.set(line + offset, lineContent(text));
        }
      }
      line += count;
    }
  }

  if (source?.kind === "loaded" && reviewExpansionSide(file.changeKind) === side) {
    normalizedReviewSourceLines(source.text).forEach((text, index) => lines.set(index + 1, text));
  }

  return lines;
}

/** The inclusive line range a note covers on one side, if it covers that side at all. */
function anchoredRange(anchor: ReviewRangeAnchor, side: ReviewSide): ReviewLineRange | undefined {
  const range = side === "old" ? anchor.oldRange : anchor.newRange;
  if (range) {
    return range;
  }
  const preferred = anchor.preferred;
  return preferred?.side === side ? [preferred.line, preferred.line] : undefined;
}

/** Read the text of every line in `range`, or undefined when any of them is unreadable. */
function textsAt(lines: Map<number, string>, [start, end]: ReviewLineRange) {
  const texts: string[] = [];
  for (let line = start; line <= end; line += 1) {
    const text = lines.get(line);
    if (text === undefined) {
      return undefined;
    }
    texts.push(text);
  }
  return texts;
}

/** Find the one first line where `texts` occurs as consecutive lines, or undefined. */
function uniqueOccurrence(lines: Map<number, string>, texts: readonly string[]) {
  let found: number | undefined;
  for (const [start, text] of lines) {
    if (text !== texts[0] || !texts.every((value, offset) => lines.get(start + offset) === value)) {
      continue;
    }
    if (found !== undefined) {
      return undefined;
    }
    found = start;
  }
  return found;
}

/** Record the text of the lines a note's anchor covers in `file`, per readable side. */
export function captureReviewNoteLines(
  file: ReviewFile,
  anchor: ReviewRangeAnchor,
  source: ReviewSourceStatus | undefined,
): ReviewNoteRecordedLines {
  const recorded: ReviewNoteRecordedLines = { contentIdentity: file.contentIdentity };
  for (const side of REVIEW_SIDES) {
    const range = anchoredRange(anchor, side);
    const texts = range ? textsAt(readableSideLines(file, side, source), range) : undefined;
    if (texts) {
      recorded[side] = texts;
    }
  }
  return recorded;
}

/** Shift a range by `delta` lines. */
function shiftRange([start, end]: ReviewLineRange, delta: number): ReviewLineRange {
  return [start + delta, end + delta];
}

/**
 * How far each anchored side moved, or undefined when any side's text cannot be found.
 *
 * Unmoved text wins over a match elsewhere, so a note never leaves a line that still holds
 * its text.
 */
function anchorShifts(
  file: ReviewFile,
  anchor: ReviewRangeAnchor,
  recorded: ReviewNoteRecordedLines,
  source: ReviewSourceStatus | undefined,
): Partial<Record<ReviewSide, number>> | undefined {
  const shifts: Partial<Record<ReviewSide, number>> = {};
  for (const side of REVIEW_SIDES) {
    const range = anchoredRange(anchor, side);
    if (!range) {
      continue;
    }

    const expected = recorded[side];
    if (!expected) {
      if (recorded.contentIdentity !== file.contentIdentity) {
        return undefined;
      }
      shifts[side] = 0;
      continue;
    }

    const lines = readableSideLines(file, side, source);
    const current = textsAt(lines, range);
    if (current && current.every((text, index) => text === expected[index])) {
      shifts[side] = 0;
      continue;
    }

    const start = uniqueOccurrence(lines, expected);
    if (start === undefined) {
      return undefined;
    }
    shifts[side] = start - range[0];
  }
  return shifts;
}

/** Re-hang an anchor on `file`'s hunks after moving each side by its shift. */
function moveAnchor(
  file: ReviewFile,
  anchor: ReviewRangeAnchor,
  shifts: Partial<Record<ReviewSide, number>>,
): ReviewRangeAnchor {
  const oldRange = anchor.oldRange && shiftRange(anchor.oldRange, shifts.old ?? 0);
  const newRange = anchor.newRange && shiftRange(anchor.newRange, shifts.new ?? 0);
  const preferred: ReviewLineAddress | undefined = anchor.preferred && {
    side: anchor.preferred.side,
    line: anchor.preferred.line + (shifts[anchor.preferred.side] ?? 0),
  };
  const fallbackOwnerHunkIndex = preferred
    ? reviewGapOwnerHunkIndex(file.hunks, preferred.side, preferred.line)
    : undefined;
  return resolveReviewNoteAnchor(file.hunks, {
    ...(oldRange ? { oldRange } : {}),
    ...(newRange ? { newRange } : {}),
    ...(preferred ? { preferred } : {}),
    ...(fallbackOwnerHunkIndex !== undefined ? { fallbackOwnerHunkIndex } : {}),
  });
}

/**
 * Place one restored note on the review by its recorded line text.
 *
 * `file` is the note's file in this review, absent when the review does not have it. The
 * anchor is always hung on the current hunks: a note restored in a new launch may meet a
 * different hunk layout than the one it was saved against.
 */
export function placeRestoredReviewNote(
  entry: ReviewStoredNote,
  file: ReviewFile | undefined,
  source: ReviewSourceStatus | undefined,
  recorded: ReviewNoteRecordedLines,
): ReviewStoredNote {
  if (!file) {
    return { ...entry, resolution: "orphaned" };
  }
  const shifts = anchorShifts(file, entry.note.anchor, recorded, source);
  return {
    ...entry,
    resolution: shifts ? "active" : "stale",
    note: { ...entry.note, anchor: moveAnchor(file, entry.note.anchor, shifts ?? {}) },
  };
}
