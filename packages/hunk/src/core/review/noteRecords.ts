/**
 * Converts the review's notes to and from the records a note store keeps between launches.
 *
 * A record carries the note as written, with its authorship and ids, plus what restore needs
 * to place it again: the path it was written on and the text of its anchored lines, recorded
 * the first time the note is saved and kept unchanged after that. On restore, a note is matched
 * to the current review by that path and placed by its line text (`noteReconciliation.ts`), so
 * a note on changed text comes back stale and a note on a file the review no longer has comes
 * back orphaned. Pure: storage belongs to the store, timing to the host.
 */
import {
  captureReviewNoteLines,
  placeRestoredReviewNote,
  type ReviewNoteRecordedLines,
} from "./noteReconciliation";
import { selectReviewFileByKey, selectStoredReviewNotes } from "./selectors";
import type { ReviewState, ReviewStoredNote } from "./state";
import type { ReviewNote } from "./types";

/** One note as a store keeps it between launches. */
export interface ReviewNoteRecord {
  note: ReviewNote;
  /** Path of the note's file when it was first saved; restore matches files by it. */
  filePath: string;
  /** Content identity of that file when the note was first saved. */
  contentIdentity: string;
  /** Text of the anchored lines when the note was first saved, per side. */
  anchorText?: { old?: readonly string[]; new?: readonly string[] };
}

/**
 * Every stored note as a record, live notes before reviewer notes.
 *
 * `include` limits the set to the notes one store owns. `recorded` holds the records this
 * store already has for a note, loaded or saved earlier: such a note keeps its recorded path
 * and line text, so a line that changed since keeps counting against the text the note was
 * written on. Any other note records its lines from the current review now; a note whose file
 * the review does not hold has no path to record and is left out.
 */
export function selectReviewNoteRecords(
  state: Pick<ReviewState, "document" | "liveNotes" | "sourceStatusByFileKey" | "userNotes">,
  {
    include = () => true,
    recorded = new Map(),
  }: {
    include?: (noteId: string) => boolean;
    recorded?: ReadonlyMap<string, ReviewNoteRecord>;
  } = {},
): ReviewNoteRecord[] {
  return selectStoredReviewNotes(state).flatMap(({ note }) => {
    if (!include(note.id)) return [];
    const earlier = recorded.get(note.id);
    if (earlier) return [{ ...earlier, note }];

    const file = selectReviewFileByKey(state, note.fileKey);
    if (!file) return [];
    const {
      contentIdentity,
      old,
      new: added,
    } = captureReviewNoteLines(file, note.anchor, state.sourceStatusByFileKey[file.key]);
    const anchorText = { ...(old ? { old } : {}), ...(added ? { new: added } : {}) };
    return [
      {
        note,
        filePath: file.path,
        contentIdentity,
        ...(old || added ? { anchorText } : {}),
      },
    ];
  });
}

/**
 * Turn saved records into stored notes placed on the current review.
 *
 * Records whose id the review already holds are skipped, so restoring the same records twice
 * adds nothing the second time.
 */
export function restoreReviewNoteRecords(
  state: ReviewState,
  records: readonly ReviewNoteRecord[],
): ReviewStoredNote[] {
  const present = new Set(selectStoredReviewNotes(state).map(({ note }) => note.id));
  const restored: ReviewStoredNote[] = [];

  for (const record of records) {
    if (present.has(record.note.id)) continue;
    present.add(record.note.id);

    const file = state.document.files.find((candidate) => candidate.path === record.filePath);
    const lines: ReviewNoteRecordedLines = {
      contentIdentity: record.contentIdentity,
      ...(record.anchorText?.old ? { old: record.anchorText.old } : {}),
      ...(record.anchorText?.new ? { new: record.anchorText.new } : {}),
    };
    restored.push(
      placeRestoredReviewNote(
        {
          // A file's key is not stable across launches of every input kind; its path is.
          note: { ...record.note, ...(file ? { fileKey: file.key } : {}) },
          resolution: "active",
        },
        file,
        file ? state.sourceStatusByFileKey[file.key] : undefined,
        lines,
      ),
    );
  }
  return restored;
}
