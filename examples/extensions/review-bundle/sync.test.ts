import { expect, test } from "bun:test";
import { createReviewStore } from "../../../packages/hunk/src/core/review/store";
import { applyReviewIntent } from "../../../packages/hunk/src/core/review/intents";
import { buildExtensionReviewSnapshot } from "../../../packages/hunk/src/extensions/reviewSnapshot";
import { createTestReviewDocument } from "../../../test/helpers/review-store-helpers";
import type { ExtensionEventContext } from "hunkdiff/extension";
import type { GitHubViewedClient, GitHubViewedSnapshot, ViewedState } from "./github";
import { createViewedSync } from "./sync";
const bundle = {
  repository: "acme/project",
  number: 7,
  url: "https://github.com/acme/project/pull/7",
  base: "1".repeat(40),
  mergeBase: "1".repeat(40),
  head: "2".repeat(40),
};

/** Drive synchronization through real intents and snapshots, faking only remote I/O and status paint. */
function createTestSync(client: GitHubViewedClient) {
  const store = createReviewStore(createTestReviewDocument(["alpha", "beta"]));
  let generation = "g1",
    active = true;
  const notices: string[] = [],
    status: string[] = [];
  const comparison = {
    kind: "comparison" as const,
    provider: "Git",
    title: "Pinned comparison",
    base: bundle.mergeBase,
    head: bundle.head,
  };
  const context: Pick<ExtensionEventContext, "review" | "notify" | "statusLine"> = {
    notify: (text) => {
      notices.push(text);
    },
    statusLine: {
      set: (item) => {
        status.push(item.spans.map((span) => span.text).join(""));
      },
      clear: () => {},
    },
    review: {
      snapshot: () =>
        active
          ? { ...buildExtensionReviewSnapshot(generation, store.getSnapshot()), review: comparison }
          : null,
      setFileViewed: (fileKey, viewed) => {
        if (!active) return false;
        applyReviewIntent(store, { type: "files/set-viewed", fileKey, viewed });
        return true;
      },
      requestReload: async () => ({
        ok: false,
        reason: "unavailable",
        detail: "Test does not reload",
      }),
    },
  };
  const sync = createViewedSync(bundle, client);
  let previous = store.getSnapshot();
  let pending: Promise<void> = Promise.resolve();
  store.subscribe(() => {
    const next = store.getSnapshot();
    const before = previous;
    previous = next;
    if (before.document !== next.document) return;
    for (const file of next.document.files) {
      const viewed = next.viewedFileKeys.includes(file.key);
      if (viewed !== before.viewedFileKeys.includes(file.key))
        pending = sync.changed(
          { fileKey: file.key, contentIdentity: file.contentIdentity, viewed },
          context,
        );
    }
  });
  return {
    store,
    context,
    sync,
    status,
    notices,
    comparison,
    refresh: () => sync.refresh(context),
    toggle: (fileKey: string, viewed: boolean) => {
      context.review.setFileViewed(fileKey, viewed);
      return pending;
    },
    retire: () => {
      active = false;
      generation = "retired";
    },
  };
}
/** Complete provider projection for the two test files. */
function remote(
  alpha: ViewedState = "UNVIEWED",
  beta: ViewedState = "DISMISSED",
): GitHubViewedSnapshot {
  return {
    id: "PR7",
    head: bundle.head,
    mergeBase: bundle.mergeBase,
    files: new Map([
      ["alpha.ts", alpha],
      ["beta.ts", beta],
    ]),
  };
}
/** Expose one awaitable boundary to control arrival order without timer guesses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("imports remote Viewed states without echoing them and refresh reopens dismissed content", async () => {
  let state = remote("VIEWED", "VIEWED");
  const writes: unknown[] = [];
  const harness = createTestSync({
    read: async () => state,
    write: async (...args) => {
      writes.push(args);
    },
  });
  await harness.refresh();
  expect(harness.store.getSnapshot().viewedFileKeys).toEqual(["alpha", "beta"]);
  state = remote("DISMISSED", "UNVIEWED");
  await harness.refresh();
  expect(harness.store.getSnapshot().viewedFileKeys).toEqual([]);
  expect(writes).toEqual([]);
  expect(harness.status.at(-1)).toBe("GitHub Viewed synced");
  harness.sync.close();
});

test("local toggle is immediate and writes the exact path before reporting confirmed state", async () => {
  let state = remote();
  const writes: unknown[] = [];
  const gate = deferred<GitHubViewedSnapshot>();
  let reads = 0;
  const harness = createTestSync({
    read: async () => (++reads === 1 ? gate.promise : state),
    write: async (id, path, viewed) => {
      writes.push([id, path, viewed]);
      state = remote(viewed ? "VIEWED" : "UNVIEWED");
    },
  });
  const pending = harness.toggle("alpha", true);
  expect(harness.store.getSnapshot().viewedFileKeys).toEqual(["alpha"]);
  expect(writes).toEqual([]);
  gate.resolve(state);
  await pending;
  expect(writes).toEqual([["PR7", "alpha.ts", true]]);
  expect(harness.status.at(-1)).toBe("GitHub Viewed synced");
  harness.sync.close();
});

test("late initial read cannot overwrite a user toggle", async () => {
  const gate = deferred<GitHubViewedSnapshot>();
  let reads = 0,
    state = remote();
  const writes: boolean[] = [];
  const harness = createTestSync({
    read: async () => (++reads === 1 ? gate.promise : state),
    write: async (_id, _path, viewed) => {
      writes.push(viewed);
      state = remote(viewed ? "VIEWED" : "UNVIEWED");
    },
  });
  const refresh = harness.refresh();
  const change = harness.toggle("alpha", true);
  gate.resolve(remote());
  await refresh;
  await change;
  expect(harness.store.getSnapshot().viewedFileKeys).toEqual(["alpha"]);
  expect(writes).toEqual([true]);
  harness.sync.close();
});

test("rapid opposite toggles serialize and converge without a late acknowledgment changing local state", async () => {
  const sent = deferred<void>(),
    release = deferred<void>();
  const writes: boolean[] = [];
  let state = remote();
  const harness = createTestSync({
    read: async () => state,
    write: async (_id, _path, viewed) => {
      writes.push(viewed);
      if (writes.length === 1) {
        sent.resolve();
        await release.promise;
      }
      state = remote(viewed ? "VIEWED" : "UNVIEWED");
    },
  });
  const first = harness.toggle("alpha", true);
  await sent.promise;
  const second = harness.toggle("alpha", false);
  release.resolve();
  await first;
  await second;
  expect(writes).toEqual([true, false]);
  expect(harness.store.getSnapshot().viewedFileKeys).toEqual([]);
  expect(state.files.get("alpha.ts")).toBe("UNVIEWED");
  harness.sync.close();
});

test("no auth and stale-bundle refusals leave local toggles useful without writes", async () => {
  for (const message of ["gh unavailable", "Stale review bundle"]) {
    const writes: unknown[] = [];
    const harness = createTestSync({
      read: async () => {
        throw new Error(message);
      },
      write: async (...args) => {
        writes.push(args);
      },
    });
    await harness.refresh();
    await harness.toggle("alpha", true);
    expect(harness.store.getSnapshot().viewedFileKeys).toEqual(["alpha"]);
    expect(writes).toEqual([]);
    expect(harness.notices).toEqual([message, message]);
    expect(harness.status.at(-1)).not.toContain("synced");
    harness.sync.close();
  }
});

test("lost mutation replies and post-write revision races report unknown outcomes, not synced", async () => {
  for (const loseReply of [true, false]) {
    let reads = 0;
    const harness = createTestSync({
      read: async () => {
        if (++reads > 1) throw new Error("PR changed");
        return remote();
      },
      write: async () => {
        if (loseReply) throw new Error("lost reply");
      },
    });
    await harness.toggle("alpha", true);
    expect(harness.notices.at(-1)).toContain("outcome unknown");
    expect(harness.status).not.toContain("GitHub Viewed synced");
    expect(harness.store.getSnapshot().viewedFileKeys).toEqual(["alpha"]);
    harness.sync.close();
  }
});

test("retired generations and shutdown prevent delayed reads from mutating local or remote state", async () => {
  for (const close of [true, false]) {
    const gate = deferred<GitHubViewedSnapshot>();
    const writes: unknown[] = [];
    const harness = createTestSync({
      read: async () => gate.promise,
      write: async (...args) => {
        writes.push(args);
      },
    });
    const change = harness.toggle("alpha", true);
    if (close) harness.sync.close();
    else harness.retire();
    gate.resolve(remote());
    await change;
    expect(writes).toEqual([]);
    expect(harness.store.getSnapshot().viewedFileKeys).toEqual(["alpha"]);
  }
});

test("a different host comparison refuses synchronization even if paths match", async () => {
  let reads = 0;
  const harness = createTestSync({
    read: async () => {
      reads++;
      return remote();
    },
    write: async () => {},
  });
  harness.comparison.head = "3".repeat(40);
  await harness.refresh();
  await harness.toggle("alpha", true);
  expect(reads).toBe(0);
  expect(harness.notices.at(-1)).toContain("no longer shows");
  harness.sync.close();
});

test("a refresh supersedes an earlier read and only imports the newest response", async () => {
  const first = deferred<GitHubViewedSnapshot>();
  let reads = 0;
  const harness = createTestSync({
    read: async () => (++reads === 1 ? first.promise : remote("DISMISSED", "VIEWED")),
    write: async () => {
      throw new Error("No mutation expected");
    },
  });
  const older = harness.refresh();
  const newer = harness.refresh();
  first.resolve(remote("VIEWED", "UNVIEWED"));
  await older;
  await newer;
  expect(harness.store.getSnapshot().viewedFileKeys).toEqual(["beta"]);
  harness.sync.close();
});

test("incomplete remote coverage imports nothing and reports the failure", async () => {
  const harness = createTestSync({
    read: async () => ({ ...remote(), files: new Map([["alpha.ts", "VIEWED"]]) }),
    write: async () => {},
  });
  await harness.refresh();
  expect(harness.store.getSnapshot().viewedFileKeys).toEqual([]);
  expect(harness.notices.at(-1)).toContain("every displayed file");
  harness.sync.close();
});

test("a superseded desired value is discarded before mutation", async () => {
  const first = deferred<GitHubViewedSnapshot>();
  let reads = 0;
  const writes: boolean[] = [];
  const harness = createTestSync({
    read: async () => (++reads === 1 ? first.promise : remote()),
    write: async (_id, _path, viewed) => {
      writes.push(viewed);
    },
  });
  const older = harness.toggle("alpha", true);
  const newer = harness.toggle("alpha", false);
  first.resolve(remote());
  await older;
  await newer;
  expect(writes).toEqual([false]);
  expect(harness.store.getSnapshot().viewedFileKeys).toEqual([]);
  harness.sync.close();
});

test("a content replacement while a guard read is pending prevents its mutation", async () => {
  const gate = deferred<GitHubViewedSnapshot>();
  const writes: unknown[] = [];
  const harness = createTestSync({
    read: async () => gate.promise,
    write: async (...args) => {
      writes.push(args);
    },
  });
  const change = harness.toggle("alpha", true);
  harness.store.dispatch({
    type: "document/reconcile",
    document: createTestReviewDocument([{ key: "alpha", contentIdentity: "replacement" }, "beta"]),
  });
  gate.resolve(remote());
  await change;
  expect(writes).toEqual([]);
  harness.sync.close();
});

test("a later successful file cannot hide an earlier unknown mutation outcome", async () => {
  let state = remote();
  const harness = createTestSync({
    read: async () => state,
    write: async (_id, path) => {
      if (path === "alpha.ts") throw new Error("lost reply");
      state = remote("UNVIEWED", "VIEWED");
    },
  });
  await harness.toggle("alpha", true);
  await harness.toggle("beta", true);
  expect(harness.status.at(-1)).not.toBe("GitHub Viewed synced");
  expect(harness.status.at(-1)).toContain("refresh");
  await harness.refresh();
  expect(harness.status.at(-1)).toBe("GitHub Viewed synced");
  expect(harness.store.getSnapshot().viewedFileKeys).toEqual(["beta"]);
  harness.sync.close();
});
