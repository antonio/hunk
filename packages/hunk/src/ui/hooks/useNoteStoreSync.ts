/**
 * Connects the mounted review to the session's active note store.
 *
 * The review's notes are synced with one store per review target: when the review opens, and
 * again whenever a reload or remount changes which review is shown or replaces the review
 * store, the previous sync stops listening and a new one restores that target's saved notes.
 * The active store is the last one registered, so a user extension's store replaces a bundled
 * one. Each sync's pending saves are registered on the extension registry, which waits for
 * them, within the shutdown bound, before the session exits.
 */
import { useEffect, useMemo } from "react";
import { reviewNoteStoreTarget } from "../../extensions/noteStoreTarget";
import type { AppBootstrap } from "../../core/bootstrap";
import type { ReviewStore } from "../../core/review/store";
import { createNoteStoreSync } from "../../extensions/noteStoreSync";
import type { ExtensionLoadResult, RegisteredNoteStore } from "../../extensions/types";

/** Name one registered store in messages. */
function noteStoreLabel({ store, extensionId }: RegisteredNoteStore) {
  return `${store.id} (extension ${extensionId})`;
}

/** Sync the mounted review's notes with the active note store, if one is registered. */
export function useNoteStoreSync({
  bootstrap,
  extensions,
  reviewStore,
}: {
  bootstrap: Pick<AppBootstrap, "input" | "reloadContext" | "review">;
  extensions?: ExtensionLoadResult;
  reviewStore: ReviewStore;
}) {
  const target = useMemo(
    () => reviewNoteStoreTarget(bootstrap),
    [bootstrap.input, bootstrap.reloadContext, bootstrap.review],
  );
  const targetKey = target?.key;

  // Say once per registry which store is in use when several were registered.
  useEffect(() => {
    const stores = extensions?.registry.noteStores ?? [];
    const active = stores.at(-1);
    if (!extensions || !active || stores.length < 2) return;
    extensions.context.notify(
      `Using note store ${noteStoreLabel(active)}; ignoring ${stores.slice(0, -1).map(noteStoreLabel).join(", ")}.`,
      "info",
    );
  }, [extensions]);

  useEffect(() => {
    const active = extensions?.registry.noteStores.at(-1);
    if (!extensions || !active || !target) return;

    const storeLabel = noteStoreLabel(active);

    const sync = createNoteStoreSync({
      store: active.store,
      storeLabel,
      target,
      reviewStore,
      notify: (message, type) => extensions.context.notify(message, type),
    });
    const flushes = extensions.registry.noteStoreFlushes;
    const flush = () => sync.flush();
    flushes.add(flush);
    return () => {
      sync.dispose();
      // A save already running for this target still has to land before the session exits.
      void sync.flush().finally(() => flushes.delete(flush));
    };
    // The target object is rebuilt from its inputs; its key is what identifies the review.
  }, [extensions, reviewStore, targetKey]);
}
