import type {
  ExtensionReviewNoteCreateInput,
  ExtensionReviewSelection,
  HunkExtensionAPI,
} from "hunkdiff/extension";

/**
 * Build the note request for the selected hunk, or null when nothing is selected.
 *
 * The note is written for the user (`as: "user"`), so it appears as their own note and they
 * can edit it with `E` like any note they typed.
 */
export function selectionNoteRequest(
  selection: ExtensionReviewSelection,
  summary: string,
): ExtensionReviewNoteCreateInput | null {
  if (!selection.file || selection.hunkIndex === null) return null;
  return {
    filePath: selection.file.path,
    hunkIndex: selection.hunkIndex,
    body: { summary },
    as: "user",
  };
}

/** Register a command that writes a reviewer note on the selected hunk. */
export default function registerSelectionNote(hunk: HunkExtensionAPI) {
  hunk.registerCommand({ id: "add", title: "Note this hunk…", key: "f8" }, async (ctx) => {
    const summary = await ctx.dialogs.input({
      title: "Note this hunk",
      placeholder: "What should the review remember here?",
    });
    if (summary === null || summary.trim() === "") return;

    const request = selectionNoteRequest(ctx.selection, summary.trim());
    if (!request) {
      ctx.notify("Select a hunk before adding a note", "warning");
      return;
    }

    // Every refusal comes back as a result, so the command reports it instead of failing.
    const result = ctx.review.notes.create(request);
    if (!result.ok) {
      ctx.notify(`Could not add the note: ${result.message}`, "warning");
      return;
    }
    ctx.notify(`Added note ${result.note.id}`);
  });
}
