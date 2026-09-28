import { expect, test } from "bun:test";
import { createTestReviewState } from "../../../../../test/helpers/review-store-helpers";
import { applyReviewIntent } from "./intents";
import { createReviewStore } from "./store";
import { selectReviewNavigationFiles, selectVisibleReviewFiles } from "./selectors";

test("file collapse is provider-neutral and preserves review order", () => {
  const store = createReviewStore(createTestReviewState().document);
  applyReviewIntent(store, { type: "files/set-collapsed", fileKey: "alpha", collapsed: true });
  expect(store.getSnapshot().collapsedFileKeys).toEqual(["alpha"]);
  expect(selectVisibleReviewFiles(store.getSnapshot()).map((file) => file.key)).toEqual([
    "alpha",
    "beta",
  ]);
  expect(selectReviewNavigationFiles(store.getSnapshot())[0]).toEqual({
    fileKey: "alpha",
    hunkCount: 0,
  });
});

test("expanding a file restores its hunk navigation", () => {
  const store = createReviewStore(createTestReviewState().document);
  applyReviewIntent(store, { type: "files/set-collapsed", fileKey: "alpha", collapsed: true });
  expect(selectReviewNavigationFiles(store.getSnapshot())).toEqual([
    { fileKey: "alpha", hunkCount: 0 },
    { fileKey: "beta", hunkCount: 2 },
  ]);
  applyReviewIntent(store, { type: "files/set-collapsed", fileKey: "alpha", collapsed: false });
  expect(selectReviewNavigationFiles(store.getSnapshot())[0]?.hunkCount).toBe(2);
});

test("file collapse survives equivalent reloads but not replaced content or removed files", () => {
  const store = createReviewStore(createTestReviewState().document);
  applyReviewIntent(store, { type: "files/set-collapsed", fileKey: "alpha", collapsed: true });
  const document = store.getSnapshot().document;
  store.dispatch({
    type: "document/reconcile",
    document: { ...document, files: [...document.files] },
  });
  expect(store.getSnapshot().collapsedFileKeys).toEqual(["alpha"]);
  store.dispatch({
    type: "document/reconcile",
    document: {
      ...document,
      files: document.files.map((file) => ({ ...file, contentIdentity: "changed" })),
    },
  });
  expect(store.getSnapshot().collapsedFileKeys).toEqual([]);
  applyReviewIntent(store, { type: "files/set-collapsed", fileKey: "alpha", collapsed: true });
  store.dispatch({ type: "document/reconcile", document: { ...document, files: [] } });
  expect(store.getSnapshot().collapsedFileKeys).toEqual([]);
});

test("setting file collapse is idempotent and refuses missing files", () => {
  const store = createReviewStore(createTestReviewState().document);
  applyReviewIntent(store, { type: "files/set-collapsed", fileKey: "alpha", collapsed: true });
  const state = store.getSnapshot();
  applyReviewIntent(store, { type: "files/set-collapsed", fileKey: "alpha", collapsed: true });
  expect(store.getSnapshot()).toBe(state);
  expect(() =>
    applyReviewIntent(store, { type: "files/set-collapsed", fileKey: "missing", collapsed: true }),
  ).toThrow();
});

test("hunk navigation steps from a collapsed middle file in stream order", () => {
  const original = createTestReviewState().document;
  const document = {
    ...original,
    files: [original.files[0]!, { ...original.files[0]!, key: "middle" }, original.files[1]!],
  };
  const store = createReviewStore(document);
  applyReviewIntent(store, { type: "files/set-collapsed", fileKey: "middle", collapsed: true });
  applyReviewIntent(store, { type: "selection/select-file", fileKey: "middle" });
  applyReviewIntent(store, { type: "selection/move", scope: "hunk", delta: 1 });
  expect(store.getSnapshot().selection).toEqual({ fileKey: "beta", hunkIndex: 0 });
  applyReviewIntent(store, { type: "selection/select-file", fileKey: "middle" });
  applyReviewIntent(store, { type: "selection/move", scope: "hunk", delta: -1 });
  expect(store.getSnapshot().selection).toEqual({ fileKey: "alpha", hunkIndex: 1 });
});
