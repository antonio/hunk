import { describe, expect, test } from "bun:test";
import {
  createTestReviewDocument,
  createTestReviewFile,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import { restoreReviewNoteRecords, selectReviewNoteRecords } from "./noteRecords";
import { reduceReviewState } from "./reducer";
import { createInitialReviewState, type ReviewState } from "./state";
import type { ReviewDocument } from "./types";

// Expected values come from the plan's note-store contract (task note "Embed Hunk as a panel
// inside Pi", step 5): saved notes come back with their authorship and ids, placed by their
// line text, and restoring the same records twice adds nothing. Test helper geometry:
// hunk 0 shows new lines 1-3 ("a0", "b0", "c0"); the notes below anchor new line 1 ("a0").

/** A review over alpha and beta with an agent note on alpha and a reviewer reply under it. */
function createTestNotedState(): ReviewState {
  const agent = createTestStoredNote({ id: "mcp:1", fileKey: "alpha", summary: "Agent words" });
  const reply = createTestStoredNote({
    id: "user:1",
    fileKey: "alpha",
    source: "user",
    parentId: "mcp:1",
    editable: true,
    summary: "Reviewer words",
  });
  return [
    { type: "notes/add-live" as const, notes: [agent] },
    { type: "notes/add-user" as const, note: reply },
  ].reduce(
    reduceReviewState,
    createInitialReviewState(createTestReviewDocument(["alpha", "beta"])),
  );
}

/** Restore records into a fresh review over `document` and return its stored notes. */
function restoreInto(document: ReviewDocument, state: ReviewState) {
  const fresh = createInitialReviewState(document);
  const restored = restoreReviewNoteRecords(fresh, selectReviewNoteRecords(state));
  return reduceReviewState(fresh, { type: "notes/restore", notes: restored });
}

describe("review note records", () => {
  // Passes when a record carries the note as written plus the path, content identity, and the
  // anchored line's text that the next launch needs.
  test("records each note with what placing it again needs", () => {
    expect(selectReviewNoteRecords(createTestNotedState())).toEqual([
      expect.objectContaining({
        note: expect.objectContaining({ id: "mcp:1", source: "agent" }),
        filePath: "alpha.ts",
        contentIdentity: "content:alpha",
        anchorText: { new: ["a0"] },
      }),
      expect.objectContaining({
        note: expect.objectContaining({ id: "user:1", source: "user", parentId: "mcp:1" }),
        filePath: "alpha.ts",
      }),
    ]);
    expect(
      selectReviewNoteRecords(createTestNotedState(), { include: (id) => id === "user:1" }),
    ).toHaveLength(1);
  });

  // Passes when a relaunch of the same review gets both notes back with their ids, authorship,
  // editability, thread, and anchors, active.
  test("restores notes with their authorship on the same review", () => {
    const saved = createTestNotedState();
    const restored = restoreInto(createTestReviewDocument(["alpha", "beta"]), saved);

    expect(restored.liveNotes.map((entry) => [entry.note, entry.resolution])).toEqual([
      [saved.liveNotes[0]!.note, "active"],
    ]);
    expect(restored.userNotes.map((entry) => [entry.note, entry.resolution])).toEqual([
      [saved.userNotes[0]!.note, "active"],
    ]);
  });

  // Passes when restoring the same records a second time adds nothing.
  test("adds nothing when the same records are restored twice", () => {
    const saved = createTestNotedState();
    const once = restoreInto(createTestReviewDocument(["alpha", "beta"]), saved);
    const records = selectReviewNoteRecords(saved);

    expect(restoreReviewNoteRecords(once, records)).toEqual([]);
    expect(
      reduceReviewState(once, {
        type: "notes/restore",
        notes: restoreReviewNoteRecords(createInitialReviewState(once.document), records),
      }),
    ).toBe(once);
  });

  // Passes when a note is matched to its file by path even though the file's key differs in
  // the new launch.
  test("matches notes to their file by path across launches", () => {
    const restored = restoreInto(
      { files: [createTestReviewFile({ key: "alpha:relaunched", path: "alpha.ts" })] },
      createTestNotedState(),
    );

    expect(restored.liveNotes[0]!.note.fileKey).toBe("alpha:relaunched");
    expect(restored.liveNotes[0]!.resolution).toBe("active");
  });

  // Passes when a note whose line text changed comes back stale, and a note whose file left
  // the review comes back orphaned and is saved again under the path it was written on.
  test("comes back stale or orphaned when its text or file is gone", () => {
    const changed = createTestReviewFile({ key: "alpha", contentIdentity: "content:alpha:v2" });
    changed.additionLines = ["A0 changed", ...changed.additionLines.slice(1)];

    const stale = restoreInto({ files: [changed] }, createTestNotedState());
    const orphaned = restoreInto(createTestReviewDocument(["beta"]), createTestNotedState());

    expect(stale.liveNotes[0]!.resolution).toBe("stale");
    expect(orphaned.liveNotes[0]!.resolution).toBe("orphaned");
    const records = selectReviewNoteRecords(createTestNotedState());
    const recorded = new Map(records.map((record) => [record.note.id, record]));
    expect(selectReviewNoteRecords(orphaned, { recorded })).toEqual(
      records.map((record) => ({
        ...record,
        note: expect.objectContaining({ id: record.note.id }),
      })),
    );
  });

  // Passes when a later save keeps the path and line text a note was first recorded with,
  // though the review's line has changed since, so the next restore still finds it stale.
  test("keeps the lines a note was first recorded with in later saves", () => {
    const saved = createTestNotedState();
    const first = selectReviewNoteRecords(saved);
    const recorded = new Map(first.map((record) => [record.note.id, record]));
    const changed = createTestReviewFile({ key: "alpha", contentIdentity: "content:alpha:v2" });
    changed.additionLines = ["A0 changed", ...changed.additionLines.slice(1)];
    const reloaded = reduceReviewState(saved, {
      type: "document/reconcile",
      document: { files: [changed, createTestReviewFile({ key: "beta" })] },
    });

    expect(selectReviewNoteRecords(reloaded).map((record) => record.anchorText)).toEqual([
      { new: ["A0 changed"] },
      { new: ["A0 changed"] },
    ]);
    expect(
      selectReviewNoteRecords(reloaded, { recorded }).map((record) => record.anchorText),
    ).toEqual([{ new: ["a0"] }, { new: ["a0"] }]);
  });
});
