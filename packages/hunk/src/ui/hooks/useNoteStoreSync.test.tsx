import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createTestReviewDocument } from "../../../../../test/helpers/review-store-helpers";
import type { AppBootstrap } from "../../core/bootstrap";
import type { CliInput } from "../../core/run/commandInputs";
import { createReviewStore } from "../../core/review/store";
import type { ExtensionNoteStore, ExtensionReviewNoteStoreTarget } from "../../extension-api/types";
import { createExtensionNotificationHub } from "../../extensions/notifications";
import { createEmptyExtensionLoadResult } from "../../extensions/types";
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

/** Launch facts for a working-tree review, staged or not. */
function createTestLaunch(staged: boolean): Pick<AppBootstrap, "input" | "reloadContext"> {
  return {
    input: { kind: "vcs", staged, options: {} } as CliInput,
    reloadContext: { cwd: "/repo", repoRoot: "/repo" },
  };
}

describe("useNoteStoreSync", () => {
  // Passes when only the last registered store loads, the user is told which store is used,
  // a change of review target loads the new target, and unmount leaves no flush registered
  // once saves settle.
  test("syncs each review target with the last registered store", async () => {
    const notifications = createExtensionNotificationHub();
    const notices: string[] = [];
    notifications.subscribe((notification) => notices.push(notification.message));
    const extensions = createEmptyExtensionLoadResult("/repo", notifications);
    const bundled = createTestRecordingStore("bundled-store");
    const user = createTestRecordingStore("user-store");
    extensions.registry.noteStores.push(
      { extensionId: "default", origin: "bundled", store: bundled.store },
      { extensionId: "mine", origin: "global", store: user.store },
    );
    const reviewStore = createReviewStore(createTestReviewDocument(["alpha"]));
    let setStaged!: (staged: boolean) => void;

    function Harness() {
      const [staged, update] = useState(false);
      setStaged = update;
      useNoteStoreSync({ bootstrap: createTestLaunch(staged), extensions, reviewStore });
      return <text>sync</text>;
    }

    const setup = await testRender(<Harness />, { width: 10, height: 1 });
    try {
      await act(async () => {
        await setup.renderOnce();
        await Bun.sleep(0);
      });
      await act(async () => setStaged(true));
      await act(async () => {
        await setup.renderOnce();
        await Bun.sleep(0);
      });

      expect(bundled.loads).toEqual([]);
      expect(user.loads.map((target) => target.spec[0])).toEqual(["unstaged", "staged"]);
      expect(new Set(user.loads.map((target) => target.key)).size).toBe(2);
      expect(notices).toEqual([
        "Using note store user-store (extension mine); ignoring bundled-store (extension default).",
      ]);
      expect(extensions.registry.noteStoreFlushes.size).toBe(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
    await Bun.sleep(0);
    expect(extensions.registry.noteStoreFlushes.size).toBe(0);
  });
});
