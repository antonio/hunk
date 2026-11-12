import { describe, expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";
import { changesetFromPatch } from "../changeset/fromPatch";
import { reviewLineAnchor } from "./anchors";
import { projectReviewDocument } from "./document";
import { reduceReviewState } from "./reducer";
import { createInitialReviewState, type ReviewState, type ReviewStoredNote } from "./state";
import type { ReviewDocumentV1, ReviewSide } from "./types";

// Expected values in this file come from the line-based reconciliation rule Antonio set
// for persistent notes (task note "Embed Hunk as a panel inside Pi", 2026-11-11): a note
// survives a reload while its line's text is unchanged, follows its line when the exact
// text moved and appears exactly once, is stale otherwise, and is orphaned when its file
// leaves the review (modem-dev/hunk#1150).

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
): ReviewDocumentV1 {
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
  document: ReviewDocumentV1,
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

/** Start a review on `document` with one live note added through the store's action. */
function reviewWithLiveNote(document: ReviewDocumentV1, note: ReviewStoredNote): ReviewState {
  return reduceReviewState(createInitialReviewState(document), {
    type: "notes/add-live",
    notes: [note],
  });
}

/** Reload the review onto `document` and return the one live note. */
function reconcileTo(state: ReviewState, document: ReviewDocumentV1) {
  const next = reduceReviewState(state, { type: "document/reconcile", document });
  return { state: next, note: next.liveNotes[0]! };
}

describe("note reconciliation after a reload", () => {
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
    const state = reviewWithLiveNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
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

    const { note } = reconcileTo(state, secondReview);

    expect(note.resolution).toBe("active");
    expect(note.note.anchor.preferred).toEqual({ side: "new", line: 7 });
    expect(note.note.anchor.newRange).toEqual([7, 7]);
  });

  // Two lines inserted above move the unchanged anchored line from 7 to 9, and its text occurs
  // once: passes when the note follows it to line 9, stays active, and hangs from a hunk that
  // contains line 9.
  test("follows a moved line whose exact text appears once", () => {
    const state = reviewWithLiveNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
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

    const { note } = reconcileTo(state, secondReview);

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
    const state = reviewWithLiveNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
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

    const { note } = reconcileTo(state, secondReview);

    expect(note.resolution).toBe("stale");
    expect(note.note.anchor.preferred).toEqual({ side: "new", line: 7 });
  });

  // The anchored line's own text changed: passes when the note is stale at its last line.
  test("marks a note stale when its line's text changes", () => {
    const state = reviewWithLiveNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
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

    const { note } = reconcileTo(state, secondReview);

    expect(note.resolution).toBe("stale");
    expect(note.note.anchor.preferred).toEqual({ side: "new", line: 7 });
  });

  // A stale note is judged against the text it was written on, not the text of the last
  // reload: passes when changing the line marks it stale and changing it back makes it active.
  test("returns a stale note to active when its line's text comes back", () => {
    const state = reviewWithLiveNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
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

    const stale = reconcileTo(state, edited);
    const restored = reconcileTo(stale.state, firstReview);

    expect(stale.note.resolution).toBe("stale");
    expect(restored.note.resolution).toBe("active");
  });

  // The file leaves the review, then returns unchanged: passes when the note is orphaned in
  // between, kept rather than dropped, and active again once the file is back.
  test("orphans a note whose file left the review and restores it when the file returns", () => {
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
    const state = reviewWithLiveNote(both, liveNoteOn(both, "greet.js", "new", 7));

    const gone = reconcileTo(state, reviewDocumentFor([otherFile]));
    const back = reconcileTo(gone.state, both);

    expect(gone.state.liveNotes).toHaveLength(1);
    expect(gone.note.resolution).toBe("orphaned");
    expect(back.note.resolution).toBe("active");
    expect(back.note.note.anchor.preferred).toEqual({ side: "new", line: 7 });
  });

  // A reviewer note saved through the composer is judged by the same rule as a live comment:
  // passes when the saved note follows its moved line.
  test("reconciles reviewer notes saved from a draft", () => {
    const live = liveNoteOn(firstReview, "greet.js", "new", 7);
    const userNote: ReviewStoredNote = {
      ...live,
      note: { ...live.note, id: "user:1", source: "user", editable: true },
    };
    const state = [
      {
        type: "draft/start" as const,
        draft: {
          id: "draft:1",
          fileKey: live.note.fileKey,
          hunkIndex: live.note.anchor.ownerHunkIndex!,
          side: "new" as const,
          line: 7,
          body: "note",
        },
      },
      { type: "draft/save" as const, note: userNote },
    ].reduce(reduceReviewState, createInitialReviewState(firstReview));
    const moved = [
      "import { b } from 'b';",
      ...withLine(
        withLine(BASE, 4, "  const trimmed = name?.trim();"),
        7,
        "  const greeting = `Hi ${upper}`;",
      ),
    ];

    const next = reduceReviewState(state, {
      type: "document/reconcile",
      document: reviewDocumentFor([{ path: "greet.js", before: BASE, after: moved }]),
    });

    expect(next.userNotes[0]!.resolution).toBe("active");
    expect(next.userNotes[0]!.note.anchor.preferred).toEqual({ side: "new", line: 8 });
  });

  // Source: the module's own rule for lines it cannot read, not Antonio's decision. After the
  // anchored change is committed, line 7 falls outside every hunk, so its text cannot be
  // checked: passes when the note is stale rather than assumed unchanged.
  test("marks a note stale when the reloaded review no longer shows its line", () => {
    const changed = withLine(
      withLine(BASE, 4, "  const trimmed = name?.trim();"),
      7,
      "  const greeting = `Hi ${upper}`;",
    );
    const state = reviewWithLiveNote(firstReview, liveNoteOn(firstReview, "greet.js", "new", 7));
    const afterCommit = reviewDocumentFor([
      { path: "greet.js", before: changed, after: withLine(changed, 1, "import { a } from 'a2';") },
    ]);

    const { note } = reconcileTo(state, afterCommit);

    expect(note.resolution).toBe("stale");
  });
});
