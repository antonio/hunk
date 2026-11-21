import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useState } from "react";
import { createTestReviewDocument } from "../../../../../test/helpers/review-store-helpers";
import type { AppBootstrap } from "../../core/bootstrap";
import type { CliInput } from "../../core/run/commandInputs";
import { createReviewStore } from "../../core/review/store";
import type { ExtensionNoteStore, ExtensionReviewNoteStoreTarget } from "../../extension-api/types";
import { createExtensionNotificationHub } from "../../extensions/notifications";
import { createEmptyExtensionLoadResult } from "../../extensions/types";
import {
  builtInNoteStoreDirectory,
  createFileNoteStore,
  savedReviewNotesPath,
} from "../../extensions/default/core/notes";
import { useNoteStoreSync } from "./useNoteStoreSync";

// Expected values come from the plan's note-store contract (task note "Embed Hunk as a panel
// inside Pi", step 5): one store is active, the last registered, replacing earlier ones; each
// review target is synced separately; pending saves are held for shutdown.

/** A store that records which targets it was asked to load. */
function createTestRecordingStore(id: string) {
  const loads: ExtensionReviewNoteStoreTarget[] = [];
  const store: ExtensionNoteStore = {
    id,
    load: async (target) => {
      loads.push(target);
      return [];
    },
    save: async () => {},
  };
  return { store, loads };
}

/** Launch facts for a working-tree review, staged or not, with saving on or off. */
function createTestLaunch(
  staged: boolean,
  saveNotes = false,
): Pick<AppBootstrap, "input" | "reloadContext"> {
  return {
    input: { kind: "vcs", staged, options: { saveNotes } } as CliInput,
    reloadContext: { cwd: "/repo", repoRoot: "/repo" },
  };
}

/** Mount the hook over one review, letting the test change the launch facts. */
async function renderTestSync(
  extensions: ReturnType<typeof createEmptyExtensionLoadResult>,
  initial: { staged: boolean; saveNotes: boolean },
) {
  const reviewStore = createReviewStore(createTestReviewDocument(["alpha"]));
  let setLaunch!: (launch: { staged: boolean; saveNotes: boolean }) => void;

  function Harness() {
    const [launch, update] = useState(initial);
    setLaunch = update;
    useNoteStoreSync({
      bootstrap: createTestLaunch(launch.staged, launch.saveNotes),
      extensions,
      reviewStore,
    });
    return <text>sync</text>;
  }

  const setup = await testRender(<Harness />, { width: 10, height: 1 });
  const settle = async () =>
    act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
    });
  await settle();
  return {
    setup,
    update: async (launch: { staged: boolean; saveNotes: boolean }) => {
      await act(async () => setLaunch(launch));
      await settle();
    },
  };
}

describe("useNoteStoreSync", () => {
  // Passes when only the last user-registered store loads, Hunk's own store is ignored, the
  // user is told which of several stores is used, a change of review target loads the new
  // target, and unmount leaves no flush registered once saves settle.
  test("syncs each review target with the last user-registered store", async () => {
    const notifications = createExtensionNotificationHub();
    const notices: string[] = [];
    notifications.subscribe((notification) => notices.push(notification.message));
    const extensions = createEmptyExtensionLoadResult("/repo", notifications);
    const builtIn = createTestRecordingStore("built-in");
    const first = createTestRecordingStore("first-store");
    const user = createTestRecordingStore("user-store");
    extensions.registry.noteStores.push(
      { extensionId: "hunk", origin: "bundled", store: builtIn.store },
      { extensionId: "mine", origin: "global", store: first.store },
      { extensionId: "theirs", origin: "global", store: user.store },
    );

    const { setup, update } = await renderTestSync(extensions, { staged: false, saveNotes: true });
    try {
      await update({ staged: true, saveNotes: true });

      expect(builtIn.loads).toEqual([]);
      expect(first.loads).toEqual([]);
      expect(user.loads.map((target) => target.spec[0])).toEqual(["unstaged", "staged"]);
      expect(new Set(user.loads.map((target) => target.key)).size).toBe(2);
      expect(notices).toEqual([
        "Using note store user-store (extension theirs); ignoring first-store (extension mine).",
      ]);
      expect(extensions.registry.noteStoreFlushes.size).toBe(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
    await Bun.sleep(0);
    expect(extensions.registry.noteStoreFlushes.size).toBe(0);
  });

  // Source: Antonio's decision — saving is off by default and the built-in store is used only
  // when the user turns it on. Passes when Hunk's own store is not consulted until saving is on.
  test("uses Hunk's own store only when saving is turned on", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const builtIn = createTestRecordingStore("built-in");
    extensions.registry.noteStores.push({
      extensionId: "hunk",
      origin: "bundled",
      store: builtIn.store,
    });

    const { setup, update } = await renderTestSync(extensions, { staged: false, saveNotes: false });
    try {
      expect(builtIn.loads).toEqual([]);
      expect(extensions.registry.noteStoreFlushes.size).toBe(0);
      await update({ staged: false, saveNotes: true });
      expect(builtIn.loads).toHaveLength(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  // Source: Antonio's step-8 rule — with saving on, opening a review retires saved reviews whose
  // subject is gone, and nothing is pruned when saving is off or another store is in use. Passes
  // when a saved review of a deleted patch file is removed only in the built-in, saving-on case.
  test("prunes reviews whose subject is gone when Hunk's own store is used", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "hunk-prune-hook-"));
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    const directory = builtInNoteStoreDirectory(process.env);
    const builtIn = createFileNoteStore(directory);
    const goneTarget = {
      key: "c0ffee",
      operation: "patch" as const,
      spec: [join(stateHome, "deleted.patch")],
    };
    const seedGoneReview = () =>
      builtIn.save(goneTarget, [
        {
          note: {
            id: "user:1",
            source: "user",
            fileKey: "f",
            anchor: { intersectingHunkIndices: [0] },
            summary: "x",
            editable: true,
          },
          filePath: "a.ts",
          contentIdentity: "c",
        },
      ]);
    const goneFile = savedReviewNotesPath(directory, goneTarget);
    const builtInEntry = { extensionId: "hunk", origin: "bundled" as const, store: builtIn };

    try {
      // Saving off: nothing is pruned.
      await seedGoneReview();
      const off = createEmptyExtensionLoadResult("/repo");
      off.registry.noteStores.push(builtInEntry);
      const offRun = await renderTestSync(off, { staged: false, saveNotes: false });
      await Bun.sleep(50);
      expect(existsSync(goneFile)).toBe(true);
      await act(async () => offRun.setup.renderer.destroy());

      // A user store is in use: Hunk's own files are left alone.
      const user = createEmptyExtensionLoadResult("/repo");
      user.registry.noteStores.push(builtInEntry, {
        extensionId: "mine",
        origin: "global",
        store: createTestRecordingStore("user-store").store,
      });
      const userRun = await renderTestSync(user, { staged: false, saveNotes: true });
      await Bun.sleep(50);
      expect(existsSync(goneFile)).toBe(true);
      await act(async () => userRun.setup.renderer.destroy());

      // Saving on with the built-in store: the gone review is removed.
      const on = createEmptyExtensionLoadResult("/repo");
      on.registry.noteStores.push(builtInEntry);
      const onRun = await renderTestSync(on, { staged: false, saveNotes: true });
      const deadline = Date.now() + 2_000;
      while (existsSync(goneFile) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(goneFile)).toBe(false);
      await act(async () => onRun.setup.renderer.destroy());
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      rmSync(stateHome, { recursive: true, force: true });
    }
  });
});
