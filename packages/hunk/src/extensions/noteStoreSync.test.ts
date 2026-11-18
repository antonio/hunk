import { describe, expect, test } from "bun:test";
import { createTestReviewDocument } from "../../../../test/helpers/review-store-helpers";
import { applyReviewIntent } from "../core/review/intents";
import { selectReviewNoteRecords } from "../core/review/noteRecords";
import { createReviewStore } from "../core/review/store";
import type {
  ExtensionNoteStore,
  ExtensionReviewNoteStoreTarget,
  ExtensionStoredReviewNoteRecord,
} from "../extension-api/types";
import { createNoteStoreSync, parseStoredReviewNoteRecords } from "./noteStoreSync";

// Expected values come from the plan's note-store contract and its error-handling checks
// (task note "Embed Hunk as a panel inside Pi", step 5): saved notes come back with their
// authorship, saves carry the complete set one at a time, and a store whose load rejects,
// never settles, or answers garbage is reported while the review continues, without its
// saved notes being overwritten.

const TARGET: ExtensionReviewNoteStoreTarget = { key: "target:1", operation: "vcs", spec: [] };

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A store double that records every save and answers load as the test says. */
function createTestNoteStore(load: ExtensionNoteStore["load"]) {
  const saves: Array<readonly ExtensionStoredReviewNoteRecord[]> = [];
  let saveImpl: (
    records: readonly ExtensionStoredReviewNoteRecord[],
  ) => Promise<void> = async () => {};
  const store: ExtensionNoteStore = {
    id: "test-store",
    load,
    save: (_target, records) => {
      saves.push(records);
      return saveImpl(records);
    },
  };
  return {
    store,
    saves,
    setSave: (impl: typeof saveImpl) => {
      saveImpl = impl;
    },
  };
}

/** Write one note into a review store as an agent or the reviewer. */
function writeTestNote(
  reviewStore: ReturnType<typeof createReviewStore>,
  noteId: string,
  source: "user" | "agent" = "agent",
) {
  applyReviewIntent(
    reviewStore,
    { type: "notes/create", fileKey: "alpha", target: { hunkIndex: 0 }, body: { summary: noteId } },
    {
      noteId,
      timestamp: "2026-11-16T00:00:00.000Z",
      authorship: { source, channel: source === "user" ? "terminal" : "session-cli" },
    },
  );
}

/** Saved records from an earlier launch: one reviewer note on alpha. */
function createTestSavedRecords() {
  const earlier = createReviewStore(createTestReviewDocument(["alpha"]));
  writeTestNote(earlier, "user:saved", "user");
  return selectReviewNoteRecords(earlier.getSnapshot()) as ExtensionStoredReviewNoteRecord[];
}

/** Start a sync on a fresh review, collecting its notices. */
function startTestSync(store: ExtensionNoteStore, loadTimeoutMs = 1_000) {
  const reviewStore = createReviewStore(createTestReviewDocument(["alpha"]));
  const notices: string[] = [];
  const sync = createNoteStoreSync({
    store,
    storeLabel: "test-store",
    target: TARGET,
    reviewStore,
    notify: (message) => notices.push(message),
    loadTimeoutMs,
  });
  return { reviewStore, notices, sync };
}

describe("note store sync", () => {
  // Passes when the saved reviewer note comes back editable under its id, nothing is saved
  // until the notes change, and then the store receives the complete set.
  test("restores saved notes and saves the complete set on change", async () => {
    const saved = createTestSavedRecords();
    const { store, saves } = createTestNoteStore(async (target) => {
      expect(target).toBe(TARGET);
      return saved;
    });
    const { reviewStore, sync } = startTestSync(store);
    await sync.loaded;

    expect(reviewStore.getSnapshot().userNotes.map(({ note }) => [note.id, note.editable])).toEqual(
      [["user:saved", true]],
    );
    expect(saves).toEqual([]);

    writeTestNote(reviewStore, "mcp:new");
    await sync.flush();
    expect(saves.map((records) => records.map(({ note }) => note.id))).toEqual([
      ["mcp:new", "user:saved"],
    ]);
  });

  // Passes when changes made while a save runs are folded into one follow-up save of the
  // latest set, and flush waits for both.
  test("runs one save at a time and folds changes into the next", async () => {
    const { store, saves, setSave } = createTestNoteStore(async () => []);
    const { reviewStore, sync } = startTestSync(store);
    await sync.loaded;
    const first = deferred<void>();
    setSave(() => first.promise);

    writeTestNote(reviewStore, "mcp:1");
    writeTestNote(reviewStore, "mcp:2");
    writeTestNote(reviewStore, "mcp:3");
    expect(saves).toHaveLength(1);
    setSave(async () => {});
    first.resolve();
    await sync.flush();

    expect(saves.map((records) => records.map(({ note }) => note.id))).toEqual([
      ["mcp:1"],
      ["mcp:1", "mcp:2", "mcp:3"],
    ]);
  });

  // Passes when a load that rejects or never answers is reported and the sync saves nothing,
  // so the store's saved notes survive; a late answer is ignored.
  test("saves nothing after a failed or silent load", async () => {
    const failing = createTestNoteStore(async () => {
      throw new Error("disk unavailable");
    });
    const failed = startTestSync(failing.store);
    await failed.sync.loaded;
    writeTestNote(failed.reviewStore, "mcp:1");
    await failed.sync.flush();

    const late = deferred<readonly ExtensionStoredReviewNoteRecord[]>();
    const silent = createTestNoteStore(() => late.promise);
    const timedOut = startTestSync(silent.store, 20);
    await timedOut.sync.loaded;
    late.resolve(createTestSavedRecords());
    await late.promise;
    writeTestNote(timedOut.reviewStore, "mcp:1");
    await timedOut.sync.flush();

    expect(failed.notices).toEqual([
      "Note store test-store could not load saved notes (disk unavailable); notes in this review will not be saved this session.",
    ]);
    expect(failing.saves).toEqual([]);
    expect(timedOut.notices).toEqual([
      "Note store test-store did not return saved notes within 0.02s; notes in this review will not be saved this session.",
    ]);
    expect(silent.saves).toEqual([]);
    expect(timedOut.reviewStore.getSnapshot().userNotes).toEqual([]);
  });

  // Passes when a failing save is reported once and the next change saves again.
  test("reports a failed save and retries on the next change", async () => {
    const { store, saves, setSave } = createTestNoteStore(async () => []);
    const { reviewStore, notices, sync } = startTestSync(store);
    await sync.loaded;
    setSave(async () => {
      throw new Error("quota exceeded");
    });

    writeTestNote(reviewStore, "mcp:1");
    await sync.flush();
    writeTestNote(reviewStore, "mcp:2");
    await sync.flush();
    setSave(async () => {});
    writeTestNote(reviewStore, "mcp:3");
    await sync.flush();

    expect(saves).toHaveLength(3);
    expect(notices).toEqual(["Note store test-store could not save notes: quota exceeded"]);
  });

  // Passes when records Hunk cannot read are skipped with one notice, the rest restored.
  test("skips saved records it cannot read", async () => {
    const [valid] = createTestSavedRecords();
    const { store } = createTestNoteStore(
      async () =>
        [
          valid,
          { note: { ...valid!.note, source: "robot" }, filePath: "alpha.ts", contentIdentity: "x" },
          { filePath: "alpha.ts" },
        ] as unknown as ExtensionStoredReviewNoteRecord[],
    );
    const { reviewStore, notices, sync } = startTestSync(store);
    await sync.loaded;

    expect(reviewStore.getSnapshot().userNotes.map(({ note }) => note.id)).toEqual(["user:saved"]);
    expect(notices).toEqual([
      "Note store test-store returned 2 saved notes Hunk could not read; they were skipped.",
    ]);
    expect(parseStoredReviewNoteRecords("not a list")).toEqual({ records: [], rejected: 1 });
  });

  // Passes when notes already in the review before the sync started (an earlier target's)
  // are left out of its saves, while notes it loaded or saw written are saved.
  test("saves only the notes it owns", async () => {
    const saved = createTestSavedRecords();
    const { store, saves } = createTestNoteStore(async () => saved);
    const reviewStore = createReviewStore(createTestReviewDocument(["alpha"]));
    writeTestNote(reviewStore, "mcp:other-review");
    const sync = createNoteStoreSync({
      store,
      storeLabel: "test-store",
      target: TARGET,
      reviewStore,
      notify: () => {},
    });
    await sync.loaded;

    writeTestNote(reviewStore, "mcp:this-review");
    await sync.flush();
    sync.dispose();
    writeTestNote(reviewStore, "mcp:after-dispose");
    await sync.flush();

    expect(saves.map((records) => records.map(({ note }) => note.id))).toEqual([
      ["mcp:this-review", "user:saved"],
    ]);
  });
});
