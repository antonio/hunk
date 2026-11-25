import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionReviewNoteStoreTarget,
  ExtensionStoredReviewNoteRecord,
} from "../../../extension-api/types";
import {
  builtInNoteStoreDirectory,
  createFileNoteStore,
  listSavedReviews,
  removeGoneSavedReviews,
  savedReviewNotesPath,
} from "./notes";

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

describe("pruning saved reviews whose subject is gone", () => {
  // Expected values come from Antonio's step-8 rule (task note, 2026-11-19): a saved review is
  // pruned when what it reviewed no longer exists — its worktree or clone, its files, or its
  // commit — and kept otherwise. Whether a commit still exists is the host's answer through the
  // repository's VCS provider (`app/savedNoteCommits.test.ts` checks it against real Git and jj
  // repositories); here it is a function the test supplies.

  /** An existing directory standing in for a repository's checkout. */
  function createTestCheckout() {
    return mkdtempSync(join(tmpdir(), "hunk-prune-repo-"));
  }

  /** Save one record for a target, returning its key. */
  async function saveFor(directory: string, target: ExtensionReviewNoteStoreTarget) {
    await createFileNoteStore(directory).save(target, [createTestRecord(target.key)]);
    return target.key;
  }

  // Passes when reviews of removed directories and deleted files are pruned in any repository,
  // and reviews whose directories and files exist are kept.
  test("prunes reviews whose worktree or files were removed", async () => {
    const directory = createTestNotesDirectory();
    const repo = createTestCheckout();
    const removedWorktree = mkdtempSync(join(tmpdir(), "hunk-prune-gone-"));
    rmSync(removedWorktree, { recursive: true });
    const patch = join(repo, "change.patch");
    writeFileSync(patch, "diff");
    const gonePatch = join(repo, "gone.patch");

    const kept = await saveFor(directory, {
      key: "aa01",
      operation: "vcs",
      spec: ["unstaged", ""],
      repoRoot: repo,
    });
    const keptPatch = await saveFor(directory, { key: "aa02", operation: "patch", spec: [patch] });
    await saveFor(directory, {
      key: "aa03",
      operation: "vcs",
      spec: ["unstaged", ""],
      repoRoot: removedWorktree,
    });
    await saveFor(directory, { key: "aa04", operation: "patch", spec: [gonePatch] });
    await saveFor(directory, { key: "aa05", operation: "diff", spec: [patch, gonePatch] });

    expect((await removeGoneSavedReviews(directory, {})).sort()).toEqual(["aa03", "aa04", "aa05"]);
    expect((await listSavedReviews(directory)).map(({ key }) => key).sort()).toEqual(
      [kept, keptPatch].sort(),
    );
  });

  /** A commit review of `revision`, as a resolved `hunk show` saves it. */
  function showTarget(
    key: string,
    repoRoot: string,
    revision: string,
  ): ExtensionReviewNoteStoreTarget {
    return {
      key,
      operation: "show",
      spec: [revision],
      repoRoot,
      review: { kind: "commit", provider: "Test", title: "commit", revision },
    };
  }

  // Passes when the injected check is asked about the commit a resolved `show` review names and
  // the newer end of a resolved comparison, and the review is pruned only when it answers true:
  // false and unknown keep it, a review named by the typed text `HEAD` is never asked about, and
  // the review about to be restored is kept whatever the answer.
  test("prunes commit reviews only when the commit check says the commit is gone", async () => {
    const directory = createTestNotesDirectory();
    const repo = createTestCheckout();
    const answers = new Map<string, boolean | undefined>([
      ["c0", true],
      ["c1", false],
      ["c2", undefined],
      ["c3", true],
      ["c4", true],
    ]);
    const asked: string[] = [];
    const isCommitGone = async (repoRoot: string, revision: string) => {
      asked.push(`${repoRoot === repo ? "repo" : repoRoot}:${revision}`);
      return answers.get(revision);
    };
    await saveFor(directory, showTarget("bb00", repo, "c0"));
    await saveFor(directory, showTarget("bb01", repo, "c1"));
    await saveFor(directory, showTarget("bb02", repo, "c2"));
    await saveFor(directory, {
      key: "bb03",
      operation: "vcs",
      spec: ["unstaged", "c1..c3"],
      repoRoot: repo,
      review: { kind: "comparison", provider: "Test", title: "1 commit", base: "c1", head: "c3" },
    });
    await saveFor(directory, { key: "bb04", operation: "show", spec: ["HEAD"], repoRoot: repo });
    await saveFor(directory, showTarget("bb05", repo, "c4"));

    expect(await removeGoneSavedReviews(directory, {})).toEqual([]);
    expect(await removeGoneSavedReviews(directory, { isCommitGone, keepKey: "bb05" })).toEqual([
      "bb00",
      "bb03",
    ]);
    expect(asked.sort()).toEqual(["repo:c0", "repo:c1", "repo:c2", "repo:c3"]);
    expect((await listSavedReviews(directory)).map(({ key }) => key).sort()).toEqual([
      "bb01",
      "bb02",
      "bb04",
      "bb05",
    ]);
  });
});
