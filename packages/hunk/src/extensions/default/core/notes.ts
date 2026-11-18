/**
 * Hunk's built-in note store: one JSON file per review under the user's state directory.
 *
 * Registered by a bundled extension, so it is active only when no user extension registers a
 * store of its own, and the host uses it only when the user turned saving on (`save_notes` or
 * `--save-notes`). Every review's notes live in one place — `$XDG_STATE_HOME/hunk/notes`, or
 * `~/.local/state/hunk/notes` — never in a repository's git directory, so a review never writes
 * into a checkout other people share, and the cleanup commands reach every saved review.
 *
 * Each file is replaced whole: written to a temporary file in the same directory, then renamed
 * over the old one, so a crash or a failed write leaves the previous complete set. A file holds
 * only the target and the records, nothing time-dependent, so saving the same set twice writes
 * the same bytes; the file's modification time says when its notes last changed. Files are
 * readable by the user only.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionFactory,
  ExtensionNoteStore,
  ExtensionReviewNoteStoreTarget,
  ExtensionStoredReviewNoteRecord,
} from "../../../extension-api/types";

/** Id of the built-in store, as messages name it. */
export const BUILT_IN_NOTE_STORE_ID = "built-in";

/** Format version of one saved review file. */
const NOTE_FILE_VERSION = 1;

/** One saved review file's contents. */
export interface SavedReviewNotesFile {
  version: typeof NOTE_FILE_VERSION;
  target: ExtensionReviewNoteStoreTarget;
  records: readonly ExtensionStoredReviewNoteRecord[];
}

/** Where the built-in store keeps saved reviews for one environment. */
export function builtInNoteStoreDirectory(
  env: Record<string, string | undefined>,
  home = homedir(),
) {
  const stateHome = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  return join(stateHome, "hunk", "notes");
}

/** The file one review's notes are saved in. Target keys are hex digests, safe as names. */
export function savedReviewNotesPath(directory: string, target: { key: string }) {
  return join(directory, `${target.key}.json`);
}

/** Whether an error says the file does not exist. */
function isMissing(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/** Create the file-backed store that keeps saved reviews in `directory`. */
export function createFileNoteStore(directory: string): ExtensionNoteStore {
  return {
    id: BUILT_IN_NOTE_STORE_ID,
    async load(target) {
      let text: string;
      try {
        text = await readFile(savedReviewNotesPath(directory, target), "utf8");
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const saved = JSON.parse(text) as Partial<SavedReviewNotesFile>;
      if (saved.version !== NOTE_FILE_VERSION || !Array.isArray(saved.records)) {
        throw new Error(`${savedReviewNotesPath(directory, target)} is not a saved review file.`);
      }
      return saved.records;
    },
    async save(target, records) {
      const path = savedReviewNotesPath(directory, target);
      // A review with no notes left keeps no file, so listings show only reviews with notes.
      if (records.length === 0) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file: SavedReviewNotesFile = { version: NOTE_FILE_VERSION, target, records };
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  };
}

/** Build the bundled extension that registers the built-in store for this environment. */
export function createBuiltInNoteStoreExtension({
  env,
}: {
  env: Record<string, string | undefined>;
}): ExtensionFactory {
  return (hunk) => {
    hunk.registerNoteStore(createFileNoteStore(builtInNoteStoreDirectory(env)));
  };
}
