/**
 * Converts the review's notes to and from the records a note store keeps between launches.
 *
 * A record carries the note as written, with its authorship and ids, plus what reconciliation
 * needs to place it again: the path it was written on and the text of its anchored lines. On
 * restore, a note is matched to the current review by that path, judged by the same line rule
 * as a reload (`noteReconciliation.ts`), and hung on the current hunks, so a note on changed
 * text comes back stale and a note on a file the review no longer has comes back orphaned.
 * Pure: storage belongs to the store, timing to the host.
 */
import { reconcileReviewStoredNote, rehangReviewNoteAnchor } from "./noteReconciliation";
import { selectStoredReviewNotes } from "./selectors";
import type { ReviewState, ReviewStoredNote } from "./state";
import type { ReviewNoteV1 } from "./types";

/** One note as a store keeps it between launches. */
export interface ReviewNoteRecord {
  note: ReviewNoteV1;
  /** Path of the note's file when it was written; restore matches files by it. */
  filePath: string;
  /** Content identity of that file when the note was written. */
  contentIdentity: string;
  /** Text of the anchored lines when the note was written, per side. */
  anchorText?: { old?: readonly string[]; new?: readonly string[] };
}

/**
 * Every stored note as a record, live notes before reviewer notes.
 *
 * `include` limits the set to the notes one store owns. A note whose file was unknown when it
 * entered the store has no recorded path and is left out, since nothing could place it again.
 */
export function selectReviewNoteRecords(
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
  include: (noteId: string) => boolean = () => true,
): ReviewNoteRecord[] {
  return selectStoredReviewNotes(state).flatMap(({ note, anchorContent }) => {
    if (!anchorContent || !include(note.id)) return [];
    const anchorText = {
      ...(anchorContent.old ? { old: anchorContent.old } : {}),
      ...(anchorContent.new ? { new: anchorContent.new } : {}),
    };
    return [
      {
        note,
        filePath: anchorContent.filePath,
        contentIdentity: anchorContent.fileContentIdentity,
        ...(anchorContent.old || anchorContent.new ? { anchorText } : {}),
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
    const saved: ReviewStoredNote = {
      // A file's key is not stable across launches of every input kind; its path is.
      note: { ...record.note, ...(file ? { fileKey: file.key } : {}) },
      resolution: "active",
      anchorContent: {
        fileContentIdentity: record.contentIdentity,
        filePath: record.filePath,
        ...(record.anchorText?.old ? { old: record.anchorText.old } : {}),
        ...(record.anchorText?.new ? { new: record.anchorText.new } : {}),
      },
    };
    const reconciled = reconcileReviewStoredNote(
      saved,
      file,
      file ? state.sourceStatusByFileKey[file.key] : undefined,
    );
    restored.push(
      file && reconciled.resolution !== "orphaned"
        ? {
            ...reconciled,
            note: {
              ...reconciled.note,
              anchor: rehangReviewNoteAnchor(file, reconciled.note.anchor),
            },
          }
        : reconciled,
    );
  }
  return restored;
}
