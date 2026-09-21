/** Serialize Viewed reads and writes while the bundle stays pinned to the displayed comparison. */
import type {
  ExtensionEventContext,
  ExtensionEventPayloads,
  ExtensionReviewSnapshot,
} from "hunkdiff/extension";
import type { BundleIdentity } from "./bundle";
import type { GitHubViewedClient } from "./github";

type Context = Pick<ExtensionEventContext, "review" | "notify" | "statusLine">;
type Change = ExtensionEventPayloads["file_viewed_changed"];
interface PendingChange extends Change {
  epoch: number;
  sequence: number;
  generation: string;
  context: Context;
}

/** Own network ordering and report local-only or unknown effects without claiming remote success. */
export function createViewedSync(bundle: BundleIdentity, client: GitHubViewedClient) {
  let epoch = 0,
    sequence = 0;
  let stopped = false;
  let needsReconciliation = false;
  let importing: Change | undefined;
  let controller = new AbortController();
  let pendingRefresh: { context: Context; epoch: number } | undefined;
  const pending = new Map<string, PendingChange>();
  const latest = new Map<string, number>();
  let running: Promise<void> | undefined;

  /** Only the exact comparison opened from this bundle grants synchronization authority. */
  function snapshot(context: Context): ExtensionReviewSnapshot | null {
    const value = context.review.snapshot();
    const review = value?.review;
    return review?.kind === "comparison" &&
      review.provider === "Git" &&
      review.base === bundle.mergeBase &&
      review.head === bundle.head
      ? value
      : null;
  }
  /** Keep an honest status visible until a later read or write actually confirms state. */
  function report(context: Context, text: string, warning = false) {
    context.statusLine.set({ id: "viewed-sync", spans: [{ text }], priority: 2 });
    if (warning) context.notify(text, "warning");
  }
  /** A later successful file must not erase an earlier unknown or failed effect. */
  function reportSettled(context: Context) {
    report(
      context,
      pending.size
        ? "GitHub Viewed changes pending…"
        : needsReconciliation
          ? "GitHub Viewed remains unsynced; refresh to reconcile."
          : "GitHub Viewed synced",
    );
  }
  /** Discard a superseded or content-retired request before it can touch GitHub. */
  function current(change: PendingChange) {
    const state = snapshot(change.context);
    const file = state?.files.find((item) => item.fileKey === change.fileKey);
    return !stopped &&
      change.epoch === epoch &&
      latest.get(change.fileKey) === change.sequence &&
      state?.generation === change.generation &&
      file?.contentIdentity === change.contentIdentity &&
      file.viewed === change.viewed
      ? file
      : undefined;
  }
  /** Drain one bounded operation at a time; new desired values coalesce by stable file key. */
  async function drain() {
    while (!stopped && (pendingRefresh || pending.size > 0)) {
      if (pendingRefresh) {
        const work = pendingRefresh;
        pendingRefresh = undefined;
        const start = snapshot(work.context);
        if (!start) {
          report(
            work.context,
            "Viewed sync unavailable: this viewer no longer shows the bundle comparison.",
            true,
          );
          continue;
        }
        const startSequence = sequence;
        report(work.context, "Reading GitHub Viewed state…");
        try {
          const remote = await client.read(controller.signal);
          if (
            stopped ||
            work.epoch !== epoch ||
            snapshot(work.context)?.generation !== start.generation
          )
            continue;
          // Validate the complete projection before importing any state; a partial map must never hide code.
          if (start.files.some((file) => !remote.files.has(file.path)))
            throw new Error("GitHub does not cover every displayed file; Viewed sync unavailable.");
          const liveByKey = new Map(
            snapshot(work.context)!.files.map((file) => [file.fileKey, file]),
          );
          try {
            for (const file of start.files) {
              const live = liveByKey.get(file.fileKey);
              if (
                !live ||
                live.contentIdentity !== file.contentIdentity ||
                (latest.get(file.fileKey) ?? 0) > startSequence
              )
                continue;
              const viewed = remote.files.get(file.path) === "VIEWED";
              importing = { fileKey: file.fileKey, contentIdentity: file.contentIdentity, viewed };
              if (!work.context.review.setFileViewed(file.fileKey, viewed))
                throw new Error(
                  "The displayed review changed during Viewed import; refresh to reconcile.",
                );
            }
          } finally {
            importing = undefined;
          }
          needsReconciliation = false;
          reportSettled(work.context);
        } catch (error) {
          if (!stopped && work.epoch === epoch) {
            needsReconciliation = true;
            report(
              work.context,
              error instanceof Error
                ? error.message
                : "GitHub Viewed sync unavailable; local toggles remain available.",
              true,
            );
          }
        }
        continue;
      }
      const change = pending.values().next().value!;
      pending.delete(change.fileKey);
      let startedMutation = false;
      try {
        if (!current(change)) continue;
        report(change.context, "Syncing GitHub Viewed…");
        const before = await client.read(controller.signal);
        const file = current(change);
        if (!file) continue;
        if (!before.files.has(file.path))
          throw new Error("The selected file is absent from GitHub; Viewed remains local.");
        startedMutation = true;
        await client.write(before.id, file.path, change.viewed, controller.signal);
        if (!current(change)) continue;
        const after = await client.read(controller.signal);
        if (!current(change)) continue;
        if (
          after.id !== before.id ||
          (after.files.get(file.path) === "VIEWED") !== change.viewed ||
          !after.files.has(file.path)
        )
          throw new Error("GitHub Viewed state did not match the requested value.");
        reportSettled(change.context);
      } catch (error) {
        if (!stopped && change.epoch === epoch) {
          needsReconciliation = true;
          report(
            change.context,
            startedMutation
              ? "GitHub Viewed mutation outcome unknown or raced a PR change. Local state is unsynced; refresh to reconcile."
              : error instanceof Error
                ? error.message
                : "GitHub Viewed sync unavailable; local state is unsynced.",
            true,
          );
        }
      }
    }
  }
  /** Share one completion promise with event handlers without overlapping remote mutations. */
  function schedule(): Promise<void> {
    if (!running)
      running = drain().finally(() => {
        running = undefined;
        if (!stopped && (pendingRefresh || pending.size > 0)) return schedule();
      });
    return running;
  }
  return {
    /** Refresh pulls state only; it never fetches a replacement diff or writes the bundle. */
    refresh(context: Context) {
      if (stopped) return Promise.resolve();
      epoch++;
      controller.abort();
      controller = new AbortController();
      pending.clear();
      latest.clear();
      pendingRefresh = { context, epoch };
      return schedule();
    },
    /** Queue the newest requested local value without echoing imported remote state. */
    changed(change: Change, context: Context) {
      if (
        stopped ||
        (importing?.fileKey === change.fileKey &&
          importing.contentIdentity === change.contentIdentity &&
          importing.viewed === change.viewed)
      )
        return Promise.resolve();
      const state = snapshot(context);
      if (!state) {
        report(
          context,
          "Viewed sync unavailable: this viewer no longer shows the bundle comparison.",
          true,
        );
        return Promise.resolve();
      }
      latest.set(change.fileKey, ++sequence);
      pending.set(change.fileKey, {
        ...change,
        epoch,
        sequence,
        generation: state.generation,
        context,
      });
      return schedule();
    },
    /** Retire work; abort does not establish that an already-sent mutation was undone. */
    close() {
      stopped = true;
      controller.abort();
      pending.clear();
      pendingRefresh = undefined;
    },
  };
}
