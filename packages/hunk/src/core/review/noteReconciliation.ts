/**
 * Decides where a saved note stands after the review it hangs in is reloaded.
 *
 * A note is attached to the text of its lines, not to a commit or a line number: it stays
 * active while that text is still at its line, follows the text when it moved and appears
 * exactly once on the same side, and is stale otherwise. A note whose file left the review
 * is orphaned and kept, so it comes back if the file does. Each verdict compares against the
 * text captured when the note was saved, so a note that went stale on one reload becomes
 * active again once its line's text returns.
 *
 * Only exact, unique matches move a note. A line the new review cannot show — outside every
 * hunk, with no loaded source behind it — cannot be checked, so its note counts as stale
 * unless the whole file is unchanged.
 */
import { resolveReviewNoteAnchor, reviewGapOwnerHunkIndex } from "./anchors";
import { normalizedReviewSourceLines } from "./geometry";
import { reviewExpansionSide } from "./expansion";
import type {
  ReviewNoteAnchorContent,
  ReviewNoteResolution,
  ReviewSourceStatus,
  ReviewStoredNote,
} from "./state";
import type {
  ReviewFileV1,
  ReviewLineAddressV1,
  ReviewLineRange,
  ReviewRangeAnchorV1,
  ReviewSide,
} from "./types";

const REVIEW_SIDES: readonly ReviewSide[] = ["old", "new"];

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
  file: ReviewFileV1,
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
function anchoredRange(anchor: ReviewRangeAnchorV1, side: ReviewSide): ReviewLineRange | undefined {
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

/**
 * Record what a note's anchor points at in `file`, for later reconciliation.
 *
 * A side whose lines the review cannot read is left out; reconciliation then falls back to
 * the file's content identity for that side.
 */
export function captureReviewNoteAnchorContent(
  file: ReviewFileV1,
  anchor: ReviewRangeAnchorV1,
  source: ReviewSourceStatus | undefined,
): ReviewNoteAnchorContent {
  const content: ReviewNoteAnchorContent = { fileContentIdentity: file.contentIdentity };
  for (const side of REVIEW_SIDES) {
    const range = anchoredRange(anchor, side);
    const texts = range ? textsAt(readableSideLines(file, side, source), range) : undefined;
    if (texts) {
      content[side] = texts;
    }
  }
  return content;
}

/** Shift a range by `delta` lines. */
function shiftRange([start, end]: ReviewLineRange, delta: number): ReviewLineRange {
  return [start + delta, end + delta];
}

/** Compare two optional ranges by value. */
function rangesEqual(left: ReviewLineRange | undefined, right: ReviewLineRange | undefined) {
  return left === right || (!!left && !!right && left[0] === right[0] && left[1] === right[1]);
}

/** Compare two anchors by every field a renderer or exporter reads. */
function anchorsEqual(left: ReviewRangeAnchorV1, right: ReviewRangeAnchorV1) {
  return (
    rangesEqual(left.oldRange, right.oldRange) &&
    rangesEqual(left.newRange, right.newRange) &&
    left.preferred?.side === right.preferred?.side &&
    left.preferred?.line === right.preferred?.line &&
    left.ownerHunkIndex === right.ownerHunkIndex &&
    left.intersectingHunkIndices.length === right.intersectingHunkIndices.length &&
    left.intersectingHunkIndices.every((index, at) => right.intersectingHunkIndices[at] === index)
  );
}

/**
 * How far each anchored side moved, or undefined when any side's text cannot be found.
 *
 * Unmoved text wins over a match elsewhere, so a note never leaves a line that still holds
 * its text.
 */
function anchorShifts(
  file: ReviewFileV1,
  anchor: ReviewRangeAnchorV1,
  content: ReviewNoteAnchorContent | undefined,
  source: ReviewSourceStatus | undefined,
): Partial<Record<ReviewSide, number>> | undefined {
  const shifts: Partial<Record<ReviewSide, number>> = {};
  for (const side of REVIEW_SIDES) {
    const range = anchoredRange(anchor, side);
    if (!range) {
      continue;
    }

    const expected = content?.[side];
    if (!expected) {
      if (content?.fileContentIdentity !== file.contentIdentity) {
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
  file: ReviewFileV1,
  anchor: ReviewRangeAnchorV1,
  shifts: Partial<Record<ReviewSide, number>>,
): ReviewRangeAnchorV1 {
  const oldRange = anchor.oldRange && shiftRange(anchor.oldRange, shifts.old ?? 0);
  const newRange = anchor.newRange && shiftRange(anchor.newRange, shifts.new ?? 0);
  const preferred: ReviewLineAddressV1 | undefined = anchor.preferred && {
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
 * Judge one saved note against the reloaded review, moving it when its text moved.
 *
 * `file` is the note's file in the new review, absent when it left. Returns the same entry
 * when nothing about it changed.
 */
export function reconcileReviewStoredNote(
  entry: ReviewStoredNote,
  file: ReviewFileV1 | undefined,
  source: ReviewSourceStatus | undefined,
): ReviewStoredNote {
  let resolution: ReviewNoteResolution;
  let anchor = entry.note.anchor;

  if (!file) {
    resolution = "orphaned";
  } else {
    const shifts = anchorShifts(file, anchor, entry.anchorContent, source);
    resolution = shifts ? "active" : "stale";
    // Only a note that moved is re-hung; every other note keeps its recorded owner hunk, the
    // ownership policy annotated navigation relies on (`anchors.ts`).
    if (shifts && Object.values(shifts).some((shift) => shift !== 0)) {
      anchor = moveAnchor(file, anchor, shifts);
    }
  }

  if (resolution === entry.resolution && anchorsEqual(anchor, entry.note.anchor)) {
    return entry;
  }
  return { ...entry, resolution, note: { ...entry.note, anchor } };
}
