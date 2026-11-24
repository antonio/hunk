/**
 * Connects the mounted review to the session's active note store.
 *
 * The review's notes are synced with one store per review target: when the review opens, and
 * again whenever a reload or remount changes which review is shown or replaces the review
 * store, the previous sync stops listening and a new one restores that target's saved notes.
 * The active store is the last one a user extension registered. Without one, Hunk's built-in
 * store is used only when the user turned saving on (`save_notes` or `--save-notes`): saving
 * notes on the user's machine is opt-in, while installing a store extension is itself the
 * opt-in. Each sync's pending saves are registered on the extension registry, which waits for
 * them, within the shutdown bound, before the session exits.
 */
import { useEffect, useMemo } from "react";
import { reviewNoteStoreTarget } from "../../extensions/noteStoreTarget";
import type { AppBootstrap } from "../../core/bootstrap";
import type { ReviewStore } from "../../core/review/store";
import { createNoteStoreSync } from "../../extensions/noteStoreSync";
import type { ExtensionLoadResult, RegisteredNoteStore } from "../../extensions/types";

/** Whether a user extension, rather than Hunk itself, registered this store. */
function isUserNoteStore(registered: RegisteredNoteStore) {
  return registered.origin !== "bundled";
}

/**
 * The store a session syncs with: the last user-registered store, else Hunk's own when saving
 * is turned on, else none.
 */
function selectActiveNoteStore(
  stores: readonly RegisteredNoteStore[],
  saveNotes: boolean,
): RegisteredNoteStore | undefined {
  return (
    stores.filter(isUserNoteStore).at(-1) ??
    (saveNotes ? stores.filter((registered) => !isUserNoteStore(registered)).at(-1) : undefined)
  );
}

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

  const saveNotes = bootstrap.input.options.saveNotes === true;

  // Say once per registry which store is in use when several extensions registered one.
  useEffect(() => {
    const stores = (extensions?.registry.noteStores ?? []).filter(isUserNoteStore);
    const active = stores.at(-1);
    if (!extensions || !active || stores.length < 2) return;
    extensions.context.notify(
      `Using note store ${noteStoreLabel(active)}; ignoring ${stores.slice(0, -1).map(noteStoreLabel).join(", ")}.`,
      "info",
    );
  }, [extensions]);

  useEffect(() => {
    const active = extensions && selectActiveNoteStore(extensions.registry.noteStores, saveNotes);
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
  }, [extensions, reviewStore, saveNotes, targetKey]);
}
