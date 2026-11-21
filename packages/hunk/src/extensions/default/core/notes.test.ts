import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  // commit on any branch, tag, or HEAD — and kept otherwise.

  /** Run git in one directory and return trimmed stdout, failing the test on error. */
  function git(cwd: string, ...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }

  /** A repository with a main commit and a commit only on branch `topic`. */
  function createTestRepository() {
    const repo = mkdtempSync(join(tmpdir(), "hunk-prune-repo-"));
    git(repo, "init", "-qb", "main");
    git(repo, "config", "user.name", "Prune Test");
    git(repo, "config", "user.email", "prune@example.com");
    writeFileSync(join(repo, "file.txt"), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "main");
    git(repo, "switch", "-qc", "topic");
    writeFileSync(join(repo, "file.txt"), "two\n");
    git(repo, "commit", "-qam", "topic");
    const topicSha = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "-q", "main");
    return { repo, topicSha, mainSha: git(repo, "rev-parse", "HEAD") };
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
    const { repo } = createTestRepository();
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

  // Passes when a commit review of the repository being opened is kept while the commit is on
  // a branch or HEAD, and pruned once its branch is deleted; the same review checked from
  // another repository is left alone, as is the review about to be restored.
  test("prunes commit reviews whose commit left every branch", async () => {
    const directory = createTestNotesDirectory();
    const { repo, topicSha, mainSha } = createTestRepository();
    const show = (key: string, sha: string): ExtensionReviewNoteStoreTarget => ({
      key,
      operation: "show",
      spec: [sha],
      repoRoot: repo,
    });
    await saveFor(directory, show("bb01", topicSha));
    await saveFor(directory, show("bb02", mainSha));
    await saveFor(directory, {
      key: "bb03",
      operation: "vcs",
      spec: ["unstaged", `${mainSha}..${topicSha}`],
      repoRoot: repo,
    });

    expect(
      await removeGoneSavedReviews(directory, { checkCommitsIn: (root) => root === repo }),
    ).toEqual([]);

    git(repo, "branch", "-qD", "topic");
    expect(
      await removeGoneSavedReviews(directory, {
        checkCommitsIn: (root) => root === realpathSync(tmpdir()),
      }),
    ).toEqual([]);
    expect(
      await removeGoneSavedReviews(directory, {
        checkCommitsIn: (root) => root === repo,
        keepKey: "bb01",
      }),
    ).toEqual(["bb03"]);
    expect(
      await removeGoneSavedReviews(directory, { checkCommitsIn: (root) => root === repo }),
    ).toEqual(["bb01"]);

    git(repo, "switch", "-q", "--detach", topicSha);
    await saveFor(directory, show("bb04", topicSha));
    expect(
      await removeGoneSavedReviews(directory, { checkCommitsIn: (root) => root === repo }),
    ).toEqual([]);
    expect((await listSavedReviews(directory)).map(({ key }) => key).sort()).toEqual([
      "bb02",
      "bb04",
    ]);
  });
});
