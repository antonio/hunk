import { describe, expect, test } from "bun:test";
import { createTestReviewDocument } from "../../../../test/helpers/review-store-helpers";
import { applyReviewIntent } from "../core/review/intents";
import { MAX_REVIEW_NOTE_BYTES } from "../core/review/noteSize";
import { createReviewStore } from "../core/review/store";
import type { ExtensionReviewNoteCreateInput } from "../extension-api/types";
import { createExtensionReviewNoteControls } from "./reviewNotes";

// Expected values come from the plan's extension-write contract (task note "Embed Hunk as a
// panel inside Pi", step 4): `ctx.review.notes.create/update/remove`, authorship stated per
// call with no default, and refusals returned as `{ ok: false, code }` while the review stays
// unchanged. Test helper geometry: hunk `i` covers lines `10i+1`–`10i+3`, changing `10i+2`.

/** One live review store behind note controls, with deterministic ids and time. */
function createTestNoteControls(options: { live?: () => boolean } = {}) {
  const store = createReviewStore(createTestReviewDocument(["alpha", "beta"]));
  let sequence = 0;
  const notes = createExtensionReviewNoteControls({
    isLive: options.live ?? (() => true),
    getReview: () => ({
      getPositionedReviewState: () => ({
        generation: "generation:test",
        state: store.getSnapshot(),
      }),
      applyIntent: (intent, facts) => applyReviewIntent(store, intent, facts),
    }),
    newId: () => `${++sequence}`,
    now: () => "2026-11-16T00:00:00.000Z",
  });
  return { store, notes };
}

describe("ctx.review.notes", () => {
  // Passes when `as: "user"` writes an editable reviewer note labelled `user`, on the hunk's
  // changed line, with a `user:` id the session commands treat as a reviewer note.
  test("creates a reviewer note the user can edit", () => {
    const { store, notes } = createTestNoteControls();

    const result = notes.create({
      filePath: "alpha.ts",
      hunkIndex: 1,
      body: { summary: "From an extension" },
      as: "user",
    });

    expect(result).toEqual({
      ok: true,
      note: expect.objectContaining({
        id: "user:1",
        source: "user",
        originalSource: "extension",
        author: "user",
        editable: true,
        summary: "From an extension",
        createdAt: "2026-11-16T00:00:00.000Z",
        resolution: "active",
        anchor: expect.objectContaining({ preferred: { side: "new", line: 12 } }),
      }),
    });
    expect(store.getSnapshot().userNotes.map(({ note }) => note.id)).toEqual(["user:1"]);
  });

  // Passes when `as: "agent"` writes an agent note under the given label at an exact line, and
  // a reply inherits its parent's file and anchor.
  test("creates labelled agent notes and replies", () => {
    const { store, notes } = createTestNoteControls();

    const root = notes.create({
      filePath: "beta.ts",
      side: "old",
      line: 2,
      body: { summary: "Agent root", tags: ["lint"], confidence: "low" },
      as: "agent",
      label: "Linter",
    });
    const reply = notes.create({ parentId: "extension:1", body: { summary: "Reply" }, as: "user" });

    expect(root).toEqual({
      ok: true,
      note: expect.objectContaining({
        id: "extension:1",
        source: "agent",
        author: "Linter",
        editable: false,
        tags: ["lint"],
        confidence: "low",
        anchor: expect.objectContaining({ oldRange: [2, 2] }),
      }),
    });
    expect(reply).toMatchObject({
      ok: true,
      note: { id: "user:2", parentId: "extension:1", anchor: root.ok ? root.note.anchor : null },
    });
    expect(store.getSnapshot().liveNotes.map(({ note }) => note.id)).toEqual(["extension:1"]);
  });

  // Passes when each malformed or impossible create is refused with its code and the store's
  // revision does not move.
  test("refuses creates it cannot honor without changing the review", () => {
    const { store, notes } = createTestNoteControls();
    const before = store.getSnapshot().stateRevision;
    const create = (input: unknown) => notes.create(input as ExtensionReviewNoteCreateInput);

    const codes = [
      create({ filePath: "alpha.ts", hunkIndex: 0, body: { summary: "x" } }),
      create({ filePath: "alpha.ts", hunkIndex: 0, body: { summary: "x" }, as: "robot" }),
      create({ filePath: "alpha.ts", hunkIndex: 0, body: { summary: 1 }, as: "user" }),
      create({
        filePath: "alpha.ts",
        hunkIndex: 0,
        side: "new",
        line: 2,
        body: { summary: "x" },
        as: "user",
      }),
      create({ parentId: "x", filePath: "alpha.ts", body: { summary: "x" }, as: "user" }),
      create({ filePath: "gone.ts", hunkIndex: 0, body: { summary: "x" }, as: "user" }),
      create({ filePath: "alpha.ts", hunkIndex: 5, body: { summary: "x" }, as: "user" }),
      create({ filePath: "alpha.ts", side: "new", line: 6, body: { summary: "x" }, as: "user" }),
      create({ filePath: "alpha.ts", hunkIndex: 0, body: { summary: "  " }, as: "user" }),
      create({
        filePath: "alpha.ts",
        hunkIndex: 0,
        body: { summary: "x".repeat(MAX_REVIEW_NOTE_BYTES) },
        as: "user",
      }),
      create({ parentId: "missing", body: { summary: "x" }, as: "agent" }),
    ].map((result) => (result.ok ? "ok" : result.code));

    expect(codes).toEqual([
      "invalid-request",
      "invalid-request",
      "invalid-request",
      "invalid-request",
      "invalid-request",
      "file-not-found",
      "hunk-not-found",
      "hunk-not-found",
      "blank-note",
      "note-too-large",
      "invalid-note-parent",
    ]);
    expect(store.getSnapshot().stateRevision).toBe(before);
  });

  // Passes when an update replaces a note's words in place for the side that owns it, and a
  // writer acting for the other side is refused with `note-not-editable`.
  test("edits notes only across the matching authorship", () => {
    const { notes } = createTestNoteControls();
    notes.create({
      filePath: "alpha.ts",
      hunkIndex: 0,
      body: { summary: "Mine", title: "T" },
      as: "user",
    });
    notes.create({ filePath: "beta.ts", hunkIndex: 0, body: { summary: "Bot" }, as: "agent" });

    const edited = notes.update("user:1", { summary: "Mine, revised" }, { as: "user" });
    expect(edited).toEqual({
      ok: true,
      note: expect.objectContaining({
        id: "user:1",
        summary: "Mine, revised",
        updatedAt: "2026-11-16T00:00:00.000Z",
      }),
    });
    expect(edited.ok && edited.note.title).toBeUndefined();
    expect(notes.update("user:1", { summary: "x" }, { as: "agent" })).toMatchObject({
      ok: false,
      code: "note-not-editable",
    });
    expect(notes.update("extension:2", { summary: "x" }, { as: "user" })).toMatchObject({
      ok: false,
      code: "note-not-editable",
    });
    expect(notes.update("extension:2", { summary: "Bot, revised" }, { as: "agent" })).toMatchObject(
      {
        ok: true,
        note: { summary: "Bot, revised" },
      },
    );
    expect(notes.update("user:1", { summary: "x" }, {} as { as: "user" })).toMatchObject({
      ok: false,
      code: "invalid-request",
    });
  });

  // Passes when remove deletes a note from whichever collection holds it and reports it, and
  // refuses a parent with replies or an unknown id.
  test("removes notes without replies", () => {
    const { store, notes } = createTestNoteControls();
    notes.create({ filePath: "alpha.ts", hunkIndex: 0, body: { summary: "Root" }, as: "agent" });
    notes.create({ parentId: "extension:1", body: { summary: "Reply" }, as: "user" });

    expect(notes.remove("extension:1")).toMatchObject({ ok: false, code: "note-has-replies" });
    expect(notes.remove("user:2")).toMatchObject({ ok: true, note: { id: "user:2" } });
    expect(notes.remove("extension:1")).toMatchObject({ ok: true, note: { id: "extension:1" } });
    expect(notes.remove("extension:1")).toMatchObject({ ok: false, code: "note-not-found" });
    expect(store.getSnapshot().liveNotes).toEqual([]);
    expect(store.getSnapshot().userNotes).toEqual([]);
  });

  // Passes when controls whose review generation is gone refuse every write as `unavailable`.
  test("expires with its review generation", () => {
    let live = true;
    const { store, notes } = createTestNoteControls({ live: () => live });
    live = false;

    expect(
      notes.create({ filePath: "alpha.ts", hunkIndex: 0, body: { summary: "x" }, as: "user" }),
    ).toMatchObject({ ok: false, code: "unavailable" });
    expect(notes.remove("user:1")).toMatchObject({ ok: false, code: "unavailable" });
    expect(store.getSnapshot().userNotes).toEqual([]);
  });
});
