/**
 * Bundled "Remove stale notes" command: deletes every stale note of the current review.
 *
 * A note is stale when the lines it was written about changed since: a reload that changed its
 * file, or a restore from the note store that could not find its line text unchanged. The
 * command removes them all, the reviewer's and agents' alike, after the user confirms the count.
 *
 * It works only through the public extension API — the review snapshot to find stale notes and
 * `ctx.review.notes.remove` to delete them — so removal follows the same rules as every other
 * note write: a note that still has a reply is refused. Replies are therefore removed before the
 * notes they reply to, and a stale note kept by a reply that is not removed is reported.
 */
import type {
  ExtensionFactory,
  ExtensionReviewNoteControls,
  ExtensionReviewSnapshotNote,
} from "../../../extension-api/types";

/** Command id within the Hunk vendor namespace: `hunk.notes.removeStale`. */
export const REMOVE_STALE_NOTES_COMMAND_ID = "notes.removeStale";

/**
 * Order the review's stale notes for removal: deepest replies first, each before its parent.
 *
 * Removing a note that still has a reply is refused, so a thread is removed from its leaves up.
 * Notes at the same depth keep snapshot order.
 */
export function staleNoteRemovalOrder(notes: readonly ExtensionReviewSnapshotNote[]): string[] {
  const parentById = new Map(notes.map((note) => [note.id, note.parentId] as const));
  const depthOf = (id: string) => {
    let depth = 0;
    const seen = new Set<string>();
    for (let parent = parentById.get(id); parent && !seen.has(parent); ) {
      seen.add(parent);
      depth += 1;
      parent = parentById.get(parent);
    }
    return depth;
  };

  return notes
    .filter((note) => note.resolution === "stale")
    .map((note, index) => ({ id: note.id, depth: depthOf(note.id), index }))
    .sort((left, right) => right.depth - left.depth || left.index - right.index)
    .map(({ id }) => id);
}

/** What one removal run did: the notes it removed and the ones the review refused to remove. */
export interface StaleNoteRemoval {
  removed: string[];
  kept: Array<{ id: string; code: string }>;
}

/** Remove notes in the given order, recording each refusal instead of stopping at it. */
export function removeNotesInOrder(
  notes: ExtensionReviewNoteControls,
  order: readonly string[],
): StaleNoteRemoval {
  const result: StaleNoteRemoval = { removed: [], kept: [] };
  for (const id of order) {
    const outcome = notes.remove(id);
    if (outcome.ok) {
      result.removed.push(id);
    } else {
      result.kept.push({ id, code: outcome.code });
    }
  }
  return result;
}

/** Name a count of notes, singular or plural. */
function notesLabel(count: number) {
  return `${count} stale ${count === 1 ? "note" : "notes"}`;
}

/** Say what a removal run did, in one notice. */
export function describeStaleNoteRemoval({ removed, kept }: StaleNoteRemoval) {
  const removedText = `Removed ${notesLabel(removed.length)}.`;
  if (kept.length === 0) return removedText;
  const blocked = kept.filter(({ code }) => code === "note-has-replies").length;
  const reason =
    blocked === kept.length
      ? `${kept.length === 1 ? "it still has" : "they still have"} replies`
      : "the review refused them";
  return `${removedText} Kept ${notesLabel(kept.length)}: ${reason}.`;
}

/** Build the bundled extension that registers the "Remove stale notes" command. */
export function createRemoveStaleNotesExtension(): ExtensionFactory {
  return (hunk) => {
    hunk.registerCommand(
      { id: REMOVE_STALE_NOTES_COMMAND_ID, title: "Remove stale notes" },
      async (ctx) => {
        const before = ctx.review.snapshot();
        if (!before) {
          ctx.notify("The review is reloading; try again once it opens.", "warning");
          return;
        }

        const planned = staleNoteRemovalOrder(before.notes);
        if (planned.length === 0) {
          ctx.notify("No stale notes in this review.");
          return;
        }

        const confirmed = await ctx.dialogs.confirm({
          title: `Remove ${notesLabel(planned.length)}?`,
          body: "Stale notes were written on lines that have changed since. This removes the reviewer's and agents' notes alike, with their stale replies.",
          confirmLabel: "remove",
        });
        if (!confirmed) return;

        // The review may have changed while the dialog was open: remove only notes the user
        // confirmed that are still stale, in the order the current threads need.
        const current = ctx.review.snapshot();
        if (!current) {
          ctx.notify("The review reloaded; no notes were removed.", "warning");
          return;
        }
        const confirmedIds = new Set(planned);
        const order = staleNoteRemovalOrder(current.notes).filter((id) => confirmedIds.has(id));
        const result = removeNotesInOrder(ctx.review.notes, order);
        ctx.notify(describeStaleNoteRemoval(result), result.kept.length > 0 ? "warning" : "info");
      },
    );
  };
}
