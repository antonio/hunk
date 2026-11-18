/**
 * Keeps one review's notes in an extension note store: restores them when the review opens and
 * saves the complete set whenever it changes.
 *
 * The host starts one sync per review target and replaces it when the target changes. Loading
 * never blocks the review: notes restored from the store appear when `load` answers. A store
 * that rejects, answers garbage, or does not answer within the load bound is reported, and the
 * sync then saves nothing for this target, because a save replaces the whole saved set and
 * would overwrite notes the store still holds. Saves run one at a time; changes that arrive
 * during a save are folded into one follow-up save of the latest set. A failed save is reported
 * and the next change tries again.
 *
 * A sync saves only the notes it owns: those its store returned, and those written after it
 * started. Notes already in the review when it started belong to an earlier target, which a
 * soft reload to a different review carries along in memory.
 */
import {
  restoreReviewNoteRecords,
  selectReviewNoteRecords,
  type ReviewNoteRecord,
} from "../core/review/noteRecords";
import { reviewNoteWithinSizeLimit } from "../core/review/noteSize";
import { selectStoredReviewNotes } from "../core/review/selectors";
import type { ReviewStore } from "../core/review/store";
import type { ReviewNoteV1 } from "../core/review/types";
import type {
  ExtensionNoteStore,
  ExtensionNotifyType,
  ExtensionReviewNoteStoreTarget,
  ExtensionStoredReviewNoteRecord,
} from "../extension-api/types";

/** How long a review waits for a store's saved notes before giving up on them this session. */
export const NOTE_STORE_LOAD_TIMEOUT_MS = 5_000;

/** What a sync needs from its host. */
export interface NoteStoreSyncOptions {
  store: ExtensionNoteStore;
  /** Names the store in messages, e.g. `my-store (extension my-ext)`. */
  storeLabel: string;
  target: ExtensionReviewNoteStoreTarget;
  reviewStore: ReviewStore;
  notify: (message: string, type: ExtensionNotifyType) => void;
  loadTimeoutMs?: number;
}

/** One running sync between a review and a note store. */
export interface NoteStoreSync {
  /** Settles once the store's notes were restored, or loading failed or timed out. */
  readonly loaded: Promise<void>;
  /** Resolve once no save is running or waiting. */
  flush(): Promise<void>;
  /** Stop restoring and stop saving new changes; a save already running completes. */
  dispose(): void;
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is absent or a string. */
function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

/** Whether a value is an array of strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Whether a value is a non-negative integer. */
function isIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Whether a value is an inclusive positive line range. */
function isLineRange(value: unknown) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((line) => Number.isSafeInteger(line) && line > 0) &&
    value[0] <= value[1]
  );
}

/** Copy one note a store returned, or undefined when it is not a note Hunk wrote. */
function parseStoredNote(value: unknown): ReviewNoteV1 | undefined {
  if (!isRecord(value) || !isRecord(value.anchor)) return undefined;
  const { anchor } = value;
  const preferred = anchor.preferred;
  if (
    typeof value.id !== "string" ||
    value.id === "" ||
    (value.source !== "user" && value.source !== "agent") ||
    typeof value.fileKey !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.editable !== "boolean" ||
    ![
      value.parentId,
      value.originalSource,
      value.rationale,
      value.markup,
      value.title,
      value.author,
      value.createdAt,
      value.updatedAt,
    ].every(isOptionalString) ||
    (value.tags !== undefined && !isStringArray(value.tags)) ||
    (value.confidence !== undefined &&
      value.confidence !== "low" &&
      value.confidence !== "medium" &&
      value.confidence !== "high") ||
    !Array.isArray(anchor.intersectingHunkIndices) ||
    !anchor.intersectingHunkIndices.every(isIndex) ||
    (anchor.ownerHunkIndex !== undefined && !isIndex(anchor.ownerHunkIndex)) ||
    (anchor.oldRange !== undefined && !isLineRange(anchor.oldRange)) ||
    (anchor.newRange !== undefined && !isLineRange(anchor.newRange)) ||
    (preferred !== undefined &&
      (!isRecord(preferred) ||
        (preferred.side !== "old" && preferred.side !== "new") ||
        !Number.isSafeInteger(preferred.line) ||
        (preferred.line as number) <= 0))
  ) {
    return undefined;
  }
  // A structured clone keeps the store's later mutations away from review state.
  const note = structuredClone(value) as unknown as ReviewNoteV1;
  return reviewNoteWithinSizeLimit(note) ? note : undefined;
}

/**
 * Read what a store's `load` returned, keeping every record Hunk can place and counting the
 * rest. Store code is extension code, so nothing it returns is trusted.
 */
export function parseStoredReviewNoteRecords(value: unknown): {
  records: ReviewNoteRecord[];
  rejected: number;
} {
  if (!Array.isArray(value)) return { records: [], rejected: 1 };
  const records: ReviewNoteRecord[] = [];
  let rejected = 0;
  for (const item of value) {
    const note = isRecord(item) ? parseStoredNote(item.note) : undefined;
    const anchorText = isRecord(item) ? item.anchorText : undefined;
    if (
      !note ||
      !isRecord(item) ||
      typeof item.filePath !== "string" ||
      typeof item.contentIdentity !== "string" ||
      (anchorText !== undefined &&
        (!isRecord(anchorText) ||
          (anchorText.old !== undefined && !isStringArray(anchorText.old)) ||
          (anchorText.new !== undefined && !isStringArray(anchorText.new))))
    ) {
      rejected += 1;
      continue;
    }
    records.push({
      note,
      filePath: item.filePath,
      contentIdentity: item.contentIdentity,
      ...(anchorText ? { anchorText: structuredClone(anchorText) } : {}),
    });
  }
  return { records, rejected };
}

/** The reason one failure gives, for a message. */
function describeFailure(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Start syncing one review's notes with one store. */
export function createNoteStoreSync({
  store,
  storeLabel,
  target,
  reviewStore,
  notify,
  loadTimeoutMs = NOTE_STORE_LOAD_TIMEOUT_MS,
}: NoteStoreSyncOptions): NoteStoreSync {
  const preexisting = new Set(
    selectStoredReviewNotes(reviewStore.getSnapshot()).map(({ note }) => note.id),
  );
  const loadedIds = new Set<string>();
  const owns = (noteId: string) => loadedIds.has(noteId) || !preexisting.has(noteId);

  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let saving: Promise<void> | undefined;
  let savePending = false;
  let saveFailing = false;

  /** Save the owned set, then once more if changes arrived meanwhile. */
  const runSaves = async () => {
    do {
      savePending = false;
      const records: ExtensionStoredReviewNoteRecord[] = selectReviewNoteRecords(
        reviewStore.getSnapshot(),
        owns,
      ).map((record) => structuredClone(record));
      try {
        await store.save(target, records);
        saveFailing = false;
      } catch (error) {
        // One warning per run of failures; the next change tries again.
        if (!saveFailing) {
          notify(
            `Note store ${storeLabel} could not save notes: ${describeFailure(error)}`,
            "warning",
          );
        }
        saveFailing = true;
      }
    } while (savePending);
    saving = undefined;
  };

  /** Ask for a save of the latest notes, folding into one already queued. */
  const requestSave = () => {
    savePending = true;
    saving ??= runSaves();
  };

  const loaded = (async () => {
    const timedOut = Symbol("timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let answer: unknown;
    try {
      answer = await Promise.race([
        Promise.resolve().then(() => store.load(target)),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(timedOut), loadTimeoutMs);
        }),
      ]);
    } catch (error) {
      notify(
        `Note store ${storeLabel} could not load saved notes (${describeFailure(error)}); notes in this review will not be saved this session.`,
        "warning",
      );
      return;
    } finally {
      clearTimeout(timer);
    }
    if (disposed) return;
    if (answer === timedOut) {
      notify(
        `Note store ${storeLabel} did not return saved notes within ${loadTimeoutMs / 1_000}s; notes in this review will not be saved this session.`,
        "warning",
      );
      return;
    }

    const { records, rejected } = parseStoredReviewNoteRecords(answer);
    if (rejected > 0) {
      notify(
        `Note store ${storeLabel} returned ${rejected} saved ${rejected === 1 ? "note" : "notes"} Hunk could not read; ${rejected === 1 ? "it was" : "they were"} skipped.`,
        "warning",
      );
    }
    for (const record of records) loadedIds.add(record.note.id);
    const restored = restoreReviewNoteRecords(reviewStore.getSnapshot(), records);
    if (restored.length > 0) reviewStore.dispatch({ type: "notes/restore", notes: restored });

    let seen = reviewStore.getSnapshot();
    unsubscribe = reviewStore.subscribe(() => {
      const next = reviewStore.getSnapshot();
      if (next.liveNotes === seen.liveNotes && next.userNotes === seen.userNotes) return;
      seen = next;
      requestSave();
    });
  })();

  return {
    loaded,
    async flush() {
      while (saving) await saving;
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
    },
  };
}
