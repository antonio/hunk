import { describe, expect, test } from "bun:test";
import {
  createTestReviewDocument,
  createTestReviewFile,
} from "../../../../../../test/helpers/review-store-helpers";
import { applyReviewIntent } from "../../../core/review/intents";
import { createReviewStore } from "../../../core/review/store";
import type {
  ExtensionCommandContext,
  ExtensionCommandHandler,
  ExtensionConfirmOptions,
  ExtensionReviewNoteControls,
  ExtensionReviewSnapshot,
  ExtensionReviewSnapshotNote,
  HunkExtensionAPI,
} from "../../../extension-api/types";
import { createExtensionReviewNoteControls } from "../../reviewNotes";
import { buildExtensionReviewSnapshot } from "../../reviewSnapshot";
import {
  createRemoveStaleNotesExtension,
  describeStaleNoteRemoval,
  REMOVE_STALE_NOTES_COMMAND_ID,
  staleNoteRemovalOrder,
} from "./staleNotes";

// Expected values come from the step 8a request (task note "Embed Hunk as a panel inside Pi",
// 2026-11-24): "Remove stale notes" removes every note of the current review whose resolution is
// `stale`, the reviewer's and agents' alike, replies before parents, after a confirmation.

/** A snapshot note with only the fields removal planning reads. */
function testSnapshotNote(
  id: string,
  resolution: ExtensionReviewSnapshotNote["resolution"],
  parentId?: string,
): ExtensionReviewSnapshotNote {
  return { id, resolution, ...(parentId ? { parentId } : {}) } as ExtensionReviewSnapshotNote;
}

/** Capture the command handler the bundled extension registers. */
function registeredTestHandler(): ExtensionCommandHandler {
  let handler: ExtensionCommandHandler | undefined;
  const hunk = {
    registerCommand: (command: { id: string }, registered: ExtensionCommandHandler) => {
      expect(command.id).toBe(REMOVE_STALE_NOTES_COMMAND_ID);
      handler = registered;
    },
  } as unknown as HunkExtensionAPI;
  createRemoveStaleNotesExtension()(hunk);
  return handler!;
}

/** A review store behind real note controls and snapshots, as a command handler sees them. */
function createTestReview() {
  const store = createReviewStore(createTestReviewDocument(["alpha", "beta"]));
  let sequence = 0;
  const notes = createExtensionReviewNoteControls({
    isLive: () => true,
    getReview: () => ({
      getPositionedReviewState: () => ({ generation: "g", state: store.getSnapshot() }),
      applyIntent: (intent, facts) => applyReviewIntent(store, intent, facts),
    }),
    newId: () => `${++sequence}`,
    now: () => "2026-11-24T00:00:00.000Z",
  });
  const snapshot = () => buildExtensionReviewSnapshot("g", store.getSnapshot());
  return { store, notes, snapshot };
}

/** Run the command once against a review, answering its confirm dialog with `answer`. */
async function runTestCommand(
  review: {
    notes: ExtensionReviewNoteControls;
    snapshot: () => ExtensionReviewSnapshot | null;
  },
  answer: boolean | ((options: ExtensionConfirmOptions) => Promise<boolean>),
) {
  const notices: Array<[string, string | undefined]> = [];
  const confirms: ExtensionConfirmOptions[] = [];
  const ctx = {
    review: { notes: review.notes, snapshot: review.snapshot },
    dialogs: {
      confirm: (options: ExtensionConfirmOptions) => {
        confirms.push(options);
        return typeof answer === "function" ? answer(options) : Promise.resolve(answer);
      },
    },
    notify: (message: string, type?: string) => notices.push([message, type]),
  } as unknown as ExtensionCommandContext;
  await registeredTestHandler()(ctx);
  return { notices, confirms };
}

describe("staleNoteRemovalOrder", () => {
  // Passes when only stale notes are planned and every reply comes before the note it replies
  // to, however deep the thread, with same-depth notes in snapshot order.
  test("plans stale notes from the deepest reply up", () => {
    expect(
      staleNoteRemovalOrder([
        testSnapshotNote("root", "stale"),
        testSnapshotNote("active", "active"),
        testSnapshotNote("reply", "stale", "root"),
        testSnapshotNote("other", "stale"),
        testSnapshotNote("nested", "stale", "reply"),
        testSnapshotNote("orphan", "orphaned"),
      ]),
    ).toEqual(["nested", "reply", "root", "other"]);
  });
});

describe("describeStaleNoteRemoval", () => {
  // Passes when the notice counts removed notes and says why any were kept.
  test("reports removed and kept notes", () => {
    expect(describeStaleNoteRemoval({ removed: ["a"], kept: [] })).toBe("Removed 1 stale note.");
    expect(
      describeStaleNoteRemoval({
        removed: ["a", "b"],
        kept: [{ id: "c", code: "note-has-replies" }],
      }),
    ).toBe("Removed 2 stale notes. Kept 1 stale note: it still has replies.");
  });
});

describe("Remove stale notes", () => {
  /** A review with an agent comment and its reviewer reply on alpha, and an agent note on beta. */
  function createTestNotedReview() {
    const review = createTestReview();
    const agent = review.notes.create({
      filePath: "alpha.ts",
      hunkIndex: 0,
      body: { summary: "Agent on alpha" },
      as: "agent",
    });
    const reply = review.notes.create({
      parentId: agent.ok ? agent.note.id : "",
      body: { summary: "Reviewer reply" },
      as: "user",
    });
    const kept = review.notes.create({
      filePath: "beta.ts",
      hunkIndex: 0,
      body: { summary: "Agent on beta" },
      as: "agent",
    });
    if (!agent.ok || !reply.ok || !kept.ok) throw new Error("test notes were refused");
    return { review, ids: { agent: agent.note.id, reply: reply.note.id, kept: kept.note.id } };
  }

  /** Reload the review with alpha's content changed, which marks alpha's notes stale. */
  function reloadWithAlphaChanged(store: ReturnType<typeof createTestReview>["store"]) {
    const alpha = createTestReviewFile({ key: "alpha", contentIdentity: "content:alpha:v2" });
    alpha.additionLines = alpha.additionLines.map((text, index) =>
      index === 1 ? "B0 changed" : text,
    );
    store.dispatch({
      type: "document/reconcile",
      document: { files: [alpha, createTestReviewFile({ key: "beta" })] },
    });
  }

  // Passes when, after a reload made alpha's notes stale, confirming removes the stale agent
  // comment and the reviewer's stale reply under it, and the active note on beta stays.
  test("removes the notes a reload made stale and keeps active ones", async () => {
    const { review, ids } = createTestNotedReview();
    reloadWithAlphaChanged(review.store);
    expect(review.snapshot().notes.map((note) => [note.id, note.resolution])).toEqual([
      [ids.agent, "stale"],
      [ids.kept, "active"],
      [ids.reply, "stale"],
    ]);

    const { notices, confirms } = await runTestCommand(review, true);

    expect(confirms.map((options) => options.title)).toEqual(["Remove 2 stale notes?"]);
    expect(review.snapshot().notes.map((note) => note.id)).toEqual([ids.kept]);
    expect(notices).toEqual([["Removed 2 stale notes.", "info"]]);
  });

  // Passes when declining the confirmation leaves every note in place and says nothing more.
  test("removes nothing when the user cancels", async () => {
    const { review } = createTestNotedReview();
    reloadWithAlphaChanged(review.store);

    const { notices } = await runTestCommand(review, false);

    expect(review.snapshot().notes).toHaveLength(3);
    expect(notices).toEqual([]);
  });

  // Passes when a review without stale notes is told so without a dialog.
  test("asks nothing when no note is stale", async () => {
    const { review } = createTestNotedReview();

    const { notices, confirms } = await runTestCommand(review, true);

    expect(confirms).toEqual([]);
    expect(notices).toEqual([["No stale notes in this review.", undefined]]);
    expect(review.snapshot().notes).toHaveLength(3);
  });

  // Passes when a note added while the dialog was open is not removed: only notes the user
  // confirmed and still stale go, and the stale notes the new reply keeps are reported.
  test("removes only the confirmed notes when the review changed meanwhile", async () => {
    const { review, ids } = createTestNotedReview();
    reloadWithAlphaChanged(review.store);

    const { notices } = await runTestCommand(review, async () => {
      const late = review.notes.create({
        parentId: ids.reply,
        body: { summary: "Written while asked" },
        as: "agent",
      });
      if (!late.ok) throw new Error(late.message);
      return true;
    });

    const remaining = review.snapshot().notes;
    expect(remaining.map((note) => note.summary)).toEqual([
      "Agent on alpha",
      "Agent on beta",
      "Written while asked",
      "Reviewer reply",
    ]);
    expect(notices).toEqual([
      ["Removed 0 stale notes. Kept 2 stale notes: they still have replies.", "warning"],
    ]);
  });
});
