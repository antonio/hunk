import { describe, expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";
import { changesetFromPatch } from "../changeset/fromPatch";
import { reviewLineAnchor } from "./anchors";
import { projectReviewDocument } from "./document";
import {
  captureReviewNoteLines,
  placeRestoredReviewNote,
  type ReviewNoteRecordedLines,
} from "./noteReconciliation";
import type { ReviewStoredNote } from "./state";
import type { ReviewDocument, ReviewSide } from "./types";

// Expected values in this file come from the line-based placement rule Antonio set for
// restored notes (task note "Embed Hunk as a panel inside Pi", 2026-11-11, narrowed to restore
// on 2026-11-24): a restored note is active while its line's text is unchanged, follows its line
// when the exact text moved and appears exactly once, is stale otherwise, and is orphaned when
// its file is not in the review.

const REPO = "/repo";

/** Join lines into file text with a trailing newline, as a checked-out file has. */
function fileText(lines: readonly string[]) {
  return `${lines.join("\n")}\n`;
}

/** Ten distinct lines so every anchored text is unique unless a test duplicates it. */
const BASE = [
  "import { a } from 'a';",
  "",
  "export function greet(name) {",
  "  const trimmed = name.trim();",
  "  const upper = trimmed.toUpperCase();",
  "  log(upper);",
  "  const greeting = `Hello ${upper}`;",
  "  return greeting;",
  "}",
  "export const version = 1;",
];

/** Replace the 1-based line `line` of `lines` with `text`. */
function withLine(lines: readonly string[], line: number, text: string) {
  return lines.map((value, index) => (index === line - 1 ? text : value));
}

/** Project a review document the way `hunk diff` would, from git-style patch text per file. */
function reviewDocumentFor(
  files: ReadonlyArray<{ path: string; before: readonly string[]; after: readonly string[] }>,
): ReviewDocument {
  const patchText = files
    .map(({ path, before, after }) =>
      createTwoFilesPatch(`a/${path}`, `b/${path}`, fileText(before), fileText(after), "", "", {
        context: 3,
      }).replace(/^=+\n/m, ""),
    )
    .map((patch, index) => `diff --git a/${files[index]!.path} b/${files[index]!.path}\n${patch}`)
    .join("");
  const changeset = changesetFromPatch(patchText, "test review", REPO, null);
  return projectReviewDocument(changeset.files, { sourceLabel: REPO });
}

/** Build an agent note on one line of the named file, the way a live comment arrives. */
function liveNoteOn(
  document: ReviewDocument,
  path: string,
  side: ReviewSide,
  line: number,
): ReviewStoredNote {
  const file = document.files.find((candidate) => candidate.path === path)!;
  const hunkIndex = file.hunks.findIndex((hunk) =>
    side === "new"
      ? line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount
      : line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount,
  );
  return {
    note: {
      id: `mcp:${path}:${line}`,
      source: "agent",
      fileKey: file.key,
      anchor: reviewLineAnchor(file.hunks, { hunkIndex, side, line }),
      summary: "note",
      editable: false,
    },
    resolution: "active",
  };
}

/** One note as a store saved it: the note and the text of its lines on `document`. */
interface SavedTestNote {
  entry: ReviewStoredNote;
  lines: ReviewNoteRecordedLines;
}

/** Save the note `entry` written on `document`, recording its lines as a store does. */
function saveTestNote(document: ReviewDocument, entry: ReviewStoredNote): SavedTestNote {
  const file = document.files.find((candidate) => candidate.key === entry.note.fileKey)!;
  return { entry, lines: captureReviewNoteLines(file, entry.note.anchor, undefined) };
}

/** Restore a saved note onto `document`, matching its file by path as a restore does. */
function restoreOnto(saved: SavedTestNote, document: ReviewDocument, path = "greet.js") {
  const file = document.files.find((candidate) => candidate.path === path);
  const entry = {
    ...saved.entry,
    note: { ...saved.entry.note, ...(file ? { fileKey: file.key } : {}) },
  };
  return { note: placeRestoredReviewNote(entry, file, undefined, saved.lines) };
}

describe("restored note placement", () => {
  const firstReview = reviewDocumentFor([
    {
      path: "greet.js",
      before: BASE,
      after: withLine(
        withLine(BASE, 4, "  const trimmed = name?.trim();"),
        7,
        "  const greeting = `Hi ${upper}`;",
      ),
    },
  ]);

  // A commit that changes another line leaves the anchored line's text in place: passes when
  // the note on new line 7 stays active at line 7.
  test("keeps a note active when its line is unchanged and other lines change", () => {
    const saved = saveTestNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
    const secondReview = reviewDocumentFor([
      {
        path: "greet.js",
        before: BASE,
        after: withLine(
          withLine(BASE, 4, "  const trimmed = String(name).trim();"),
          7,
          "  const greeting = `Hi ${upper}`;",
        ),
      },
    ]);

    const { note } = restoreOnto(saved, secondReview);

    expect(note.resolution).toBe("active");
    expect(note.note.anchor.preferred).toEqual({ side: "new", line: 7 });
    expect(note.note.anchor.newRange).toEqual([7, 7]);
  });

  // Two lines inserted above move the unchanged anchored line from 7 to 9, and its text occurs
  // once: passes when the note follows it to line 9, stays active, and hangs from a hunk that
  // contains line 9.
  test("follows a moved line whose exact text appears once", () => {
    const saved = saveTestNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
    const moved = [
      "import { b } from 'b';",
      "import { c } from 'c';",
      ...withLine(
        withLine(BASE, 4, "  const trimmed = name?.trim();"),
        7,
        "  const greeting = `Hi ${upper}`;",
      ),
    ];
    const secondReview = reviewDocumentFor([{ path: "greet.js", before: BASE, after: moved }]);

    const { note } = restoreOnto(saved, secondReview);

    expect(note.resolution).toBe("active");
    expect(note.note.anchor.preferred).toEqual({ side: "new", line: 9 });
    expect(note.note.anchor.newRange).toEqual([9, 9]);
    const owner = secondReview.files[0]!.hunks[note.note.anchor.ownerHunkIndex!]!;
    expect(9).toBeGreaterThanOrEqual(owner.additionStart);
    expect(9).toBeLessThan(owner.additionStart + owner.additionCount);
  });

  // The anchored line moved and its text now appears twice: passes when the note is stale
  // and stays at its last line instead of guessing between the two copies.
  test("marks a moved line stale when its text appears more than once", () => {
    const saved = saveTestNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
    const changed = withLine(
      withLine(BASE, 4, "  const trimmed = name?.trim();"),
      7,
      "  const greeting = `Hi ${upper}`;",
    );
    const duplicated = [
      "import { b } from 'b';",
      ...changed.slice(0, 6),
      "  const greeting = `Hi ${upper}`;",
      ...changed.slice(6),
    ];
    const secondReview = reviewDocumentFor([{ path: "greet.js", before: BASE, after: duplicated }]);

    const { note } = restoreOnto(saved, secondReview);

    expect(note.resolution).toBe("stale");
    expect(note.note.anchor.preferred).toEqual({ side: "new", line: 7 });
  });

  // The anchored line's own text changed: passes when the note is stale at its last line.
  test("marks a note stale when its line's text changes", () => {
    const saved = saveTestNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
    const secondReview = reviewDocumentFor([
      {
        path: "greet.js",
        before: BASE,
        after: withLine(
          withLine(BASE, 4, "  const trimmed = name?.trim();"),
          7,
          "  const greeting = `Hey ${upper}`;",
        ),
      },
    ]);

    const { note } = restoreOnto(saved, secondReview);

    expect(note.resolution).toBe("stale");
    expect(note.note.anchor.preferred).toEqual({ side: "new", line: 7 });
  });

  // Every restore is judged against the text the note was written on: passes when a review
  // that changed the line restores it stale and one with the line back restores it active.
  test("judges every restore against the text the note was written on", () => {
    const saved = saveTestNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
    const edited = reviewDocumentFor([
      {
        path: "greet.js",
        before: BASE,
        after: withLine(
          withLine(BASE, 4, "  const trimmed = name?.trim();"),
          7,
          "  const greeting = `Hey ${upper}`;",
        ),
      },
    ]);

    const stale = restoreOnto(saved, edited);
    const restored = restoreOnto(saved, firstReview);

    expect(stale.note.resolution).toBe("stale");
    expect(restored.note.resolution).toBe("active");
  });

  // The note's file is not in the review: passes when the note is restored orphaned, kept
  // rather than dropped, and restored active into a review that has the file unchanged.
  test("orphans a note whose file is not in the review", () => {
    const otherFile = {
      path: "other.js",
      before: ["export const x = 1;"],
      after: ["export const x = 2;"],
    };
    const both = reviewDocumentFor([
      {
        path: "greet.js",
        before: BASE,
        after: withLine(
          withLine(BASE, 4, "  const trimmed = name?.trim();"),
          7,
          "  const greeting = `Hi ${upper}`;",
        ),
      },
      otherFile,
    ]);
    const saved = saveTestNote(both, liveNoteOn(both, "greet.js", "new", 7));

    const gone = restoreOnto(saved, reviewDocumentFor([otherFile]));
    const back = restoreOnto(saved, both);

    expect(gone.note.resolution).toBe("orphaned");
    expect(gone.note.note.id).toBe(saved.entry.note.id);
    expect(back.note.resolution).toBe("active");
    expect(back.note.note.anchor.preferred).toEqual({ side: "new", line: 7 });
  });

  // Source: the module's own rule for lines it cannot read, not Antonio's decision. After the
  // anchored change is committed, line 7 falls outside every hunk, so its text cannot be
  // checked: passes when the note is stale rather than assumed unchanged.
  test("marks a note stale when the review no longer shows its line", () => {
    const changed = withLine(
      withLine(BASE, 4, "  const trimmed = name?.trim();"),
      7,
      "  const greeting = `Hi ${upper}`;",
    );
    const saved = saveTestNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
    const afterCommit = reviewDocumentFor([
      { path: "greet.js", before: changed, after: withLine(changed, 1, "import { a } from 'a2';") },
    ]);

    const { note } = restoreOnto(saved, afterCommit);

    expect(note.resolution).toBe("stale");
  });
});
