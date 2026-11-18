import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionReviewNoteStoreTarget,
  ExtensionStoredReviewNoteRecord,
} from "../../../extension-api/types";
import { builtInNoteStoreDirectory, createFileNoteStore, savedReviewNotesPath } from "./notes";

// Expected values come from the plan's built-in store checks (task note "Embed Hunk as a
// panel inside Pi", step 6): one file per review in the user's state directory, files readable
// by the user only, saving the same set twice writes the same file, and a save interrupted by a
// write error or a crash between write and rename leaves the previous complete set, with the
// next save completing the latest one.

const TARGET: ExtensionReviewNoteStoreTarget = {
  key: "0123abcd",
  operation: "vcs",
  spec: ["unstaged", ""],
};

/** One saved record with the given summary. */
function createTestRecord(summary: string): ExtensionStoredReviewNoteRecord {
  return {
    note: {
      id: `user:${summary}`,
      source: "user",
      fileKey: "file:alpha",
      anchor: { intersectingHunkIndices: [0], ownerHunkIndex: 0 },
      summary,
      editable: true,
    },
    filePath: "alpha.ts",
    contentIdentity: "content:alpha",
  };
}

/** A fresh state directory for one test. */
function createTestNotesDirectory() {
  return join(mkdtempSync(join(tmpdir(), "hunk-notes-")), "hunk", "notes");
}

const POSIX = process.platform !== "win32";

describe("built-in note store", () => {
  // Passes when the store lives under XDG_STATE_HOME when set and ~/.local/state otherwise.
  test("keeps saved reviews in the user's state directory", () => {
    expect(builtInNoteStoreDirectory({ XDG_STATE_HOME: join("x", "state") }, "home")).toBe(
      join("x", "state", "hunk", "notes"),
    );
    expect(builtInNoteStoreDirectory({}, "home")).toBe(
      join("home", ".local", "state", "hunk", "notes"),
    );
  });

  // Passes when a saved set loads back unchanged, saving it again writes identical bytes, the
  // file is private to the user, and an empty set removes the file.
  test("saves one private file per review and loads it back", async () => {
    const directory = createTestNotesDirectory();
    const store = createFileNoteStore(directory);
    const records = [createTestRecord("one"), createTestRecord("two")];
    const path = savedReviewNotesPath(directory, TARGET);

    expect(await store.load(TARGET)).toEqual([]);
    await store.save(TARGET, records);
    const first = readFileSync(path, "utf8");
    await store.save(TARGET, records);

    expect(readFileSync(path, "utf8")).toBe(first);
    expect(await store.load(TARGET)).toEqual(records);
    if (POSIX) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }

    await store.save(TARGET, []);
    expect(existsSync(path)).toBe(false);
    expect(await store.load(TARGET)).toEqual([]);
  });

  // Passes when a save that fails to write leaves the previous complete set, and a crash
  // between write and rename (a leftover temporary file) changes nothing; the next save then
  // stores the latest set.
  test("leaves the previous set intact when a save is interrupted", async () => {
    const directory = createTestNotesDirectory();
    const store = createFileNoteStore(directory);
    const before = [createTestRecord("before")];
    const after = [createTestRecord("before"), createTestRecord("after")];
    await store.save(TARGET, before);
    writeFileSync(`${savedReviewNotesPath(directory, TARGET)}.crashed.tmp`, '{"version":1,"rec');

    if (POSIX) {
      chmodSync(directory, 0o500);
      await expect(store.save(TARGET, after)).rejects.toThrow();
      chmodSync(directory, 0o700);
    }
    expect(await store.load(TARGET)).toEqual(before);

    await store.save(TARGET, after);
    expect(await store.load(TARGET)).toEqual(after);
  });

  // Passes when a file that is not a saved review is refused rather than read as empty, so
  // the sync reports it and does not overwrite it.
  test("refuses a file it did not write", async () => {
    const directory = createTestNotesDirectory();
    mkdirSync(directory, { recursive: true });
    writeFileSync(savedReviewNotesPath(directory, TARGET), '{"something": "else"}');

    await expect(createFileNoteStore(directory).load(TARGET)).rejects.toThrow(
      "is not a saved review file",
    );
  });
});
