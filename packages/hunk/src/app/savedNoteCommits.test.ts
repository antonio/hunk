import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
  createTestGitRepository,
  createTestJjRepository,
  hasTestJj,
  type TestRepository,
} from "../../../../test/helpers/vcs-repositories";
import { createVcsCatalog } from "../core/vcs";
import type { VcsAdapter } from "../core/vcs/types";
import type { ExtensionReviewNoteStoreTarget } from "../extension-api/types";
import {
  createFileNoteStore,
  listSavedReviews,
  removeGoneSavedReviews,
} from "../extensions/default/core/notes";
import {
  COMMIT_SCAN_LIMIT,
  createVcsCommitCheck,
  openSessionCommitCheck,
} from "./savedNoteCommits";
import { getBundledVcsCatalog } from "./vcsCatalog";

// Expected values come from Antonio's pruning rule (task note "Embed Hunk as a panel inside Pi",
// 2026-11-19, and the 2026-11-24 decision to ask Hunk's VCS interface): a saved commit review is
// pruned once its commit is gone from the repository's history — no branch, tag, bookmark, or
// head reaches it — and kept while it is reachable or when the provider cannot tell. The same
// rule holds for Git and Jujutsu because the answer comes from each provider's history.

// jj is an external CLI: CI installs it, so these run there; a machine without it skips them.
const jjTest = hasTestJj ? test : test.skip;

/** Temporary directories this file created, removed after each test. */
const createdTestDirectories: string[] = [];

afterEach(() => {
  for (const path of createdTestDirectories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

/** Remember a repository's temporary parent directory for removal after the test. */
function trackTestRepository<Repository extends TestRepository>(repo: Repository) {
  createdTestDirectories.push(dirname(repo.root));
  return repo;
}

/** A fresh built-in store directory. */
function createTestNotesDirectory() {
  const root = mkdtempSync(join(tmpdir(), "hunk-commit-check-"));
  createdTestDirectories.push(root);
  return join(root, "notes");
}

/** Save one note for a resolved `hunk show <revision>` review of `repoRoot`. */
async function saveTestCommitReview(
  directory: string,
  key: string,
  repoRoot: string,
  revision: string,
) {
  const target: ExtensionReviewNoteStoreTarget = {
    key,
    operation: "show",
    spec: [revision],
    repoRoot,
    review: { kind: "commit", provider: "Test", title: "commit", revision },
  };
  await createFileNoteStore(directory).save(target, [
    {
      note: {
        id: `user:${key}`,
        source: "user",
        fileKey: "file:a",
        anchor: { intersectingHunkIndices: [0] },
        summary: "note",
        editable: true,
      },
      filePath: "a.txt",
      contentIdentity: "content:a",
    },
  ]);
}

/** Prune once with a fresh check over the bundled providers, closing it afterwards. */
async function pruneTestReviews(directory: string) {
  const check = createVcsCommitCheck(getBundledVcsCatalog());
  try {
    return await removeGoneSavedReviews(directory, { isCommitGone: check.isCommitGone });
  } finally {
    await check.close();
  }
}

/** The keys of the reviews still saved. */
async function savedTestKeys(directory: string) {
  return (await listSavedReviews(directory)).map(({ key }) => key).sort();
}

/** A Git repository whose commit `topic` exists only on branch `topic`. */
function createTestGitTopic(): TestRepository & { topic: string } {
  const repo = trackTestRepository(createTestGitRepository());
  repo.write("a.txt", "one\n");
  repo.run("add", "a.txt");
  repo.run("commit", "-qm", "main");
  repo.run("switch", "-qc", "topic");
  repo.write("a.txt", "two\n");
  repo.run("commit", "-qam", "topic");
  const topic = repo.run("rev-parse", "HEAD");
  repo.run("switch", "-q", "main");
  return { ...repo, topic };
}

describe("saved commit reviews checked through the VCS provider", () => {
  // Passes when a Git commit review is kept while a branch or HEAD reaches the commit, pruned
  // after its only branch is deleted, and kept again for a commit HEAD reaches while detached.
  test("prunes a Git commit review once its commit leaves every branch", async () => {
    const directory = createTestNotesDirectory();
    const repo = createTestGitTopic();
    await saveTestCommitReview(directory, "g1", repo.root, repo.topic);

    expect(await pruneTestReviews(directory)).toEqual([]);

    repo.run("branch", "-qD", "topic");
    expect(await pruneTestReviews(directory)).toEqual(["g1"]);

    repo.run("switch", "-q", "--detach", repo.topic);
    await saveTestCommitReview(directory, "g2", repo.root, repo.topic);
    expect(await pruneTestReviews(directory)).toEqual([]);
    expect(await savedTestKeys(directory)).toEqual(["g2"]);
  });

  // Passes when a Jujutsu commit review is kept while the commit is visible and pruned once the
  // commit is abandoned, which hides it from every head.
  jjTest("prunes a Jujutsu commit review once its commit is abandoned", async () => {
    const directory = createTestNotesDirectory();
    const repo = trackTestRepository(createTestJjRepository());
    repo.write("a.txt", "one\n");
    repo.run("commit", "-m", "first");
    repo.write("a.txt", "two\n");
    repo.run("commit", "-m", "second");
    const second = repo.run("log", "--no-graph", "-r", "@-", "-T", "commit_id");
    await saveTestCommitReview(directory, "j1", repo.root, second);

    expect(await pruneTestReviews(directory)).toEqual([]);

    repo.run("abandon", second);
    expect(await pruneTestReviews(directory)).toEqual(["j1"]);
    expect(await savedTestKeys(directory)).toEqual([]);
  });

  // Passes when a commit is kept, not pruned, once the scan reaches COMMIT_SCAN_LIMIT commits
  // without seeing it and the history has not ended: the provider's answer is then unknown. The
  // provider is a stand-in whose history runs a page past the limit without the commit, so only
  // the bound stops the scan before it would call the commit gone.
  test("keeps a review when the history scan stops before the end", async () => {
    const directory = createTestNotesDirectory();
    const root = mkdtempSync(join(tmpdir(), "hunk-endless-history-"));
    createdTestDirectories.push(root);
    await saveTestCommitReview(directory, "e1", root, "f".repeat(40));
    let served = 0;
    const longHistory: VcsAdapter = {
      id: "long",
      name: "Long history",
      detect: (cwd) => (cwd === root ? { id: "long", repoRoot: root } : null),
      operations: {},
      history: {
        open: async () => ({
          read: async ({ limit }) => {
            const length = Math.min(limit, COMMIT_SCAN_LIMIT + 256 - served);
            const commits = Array.from({ length }, () => {
              served += 1;
              return {
                revisionId: served.toString(16).padStart(40, "0"),
                displayId: String(served),
                parentRevisionIds: [],
                subject: "commit",
                authorName: "Test",
                authoredAt: "2026-01-01T00:00:00Z",
                decorations: [],
              };
            });
            return { commits, done: served >= COMMIT_SCAN_LIMIT + 256 };
          },
          close: async () => {},
        }),
        planReview: async (commit) => ({ kind: "revision-show", revisionId: commit.revisionId }),
      },
    };
    const check = createVcsCommitCheck(createVcsCatalog([longHistory], "long"));

    expect(await removeGoneSavedReviews(directory, { isCommitGone: check.isCommitGone })).toEqual(
      [],
    );
    await check.close();
    expect(served).toBe(COMMIT_SCAN_LIMIT);
    expect(await savedTestKeys(directory)).toEqual(["e1"]);
  });

  // Passes when a saved review whose repository root is spelled differently from the provider's
  // detected root (here with a trailing separator; on Windows, Git's forward slashes) is still
  // checked and pruned once its commit is gone.
  test("checks a repository whose saved root is spelled differently", async () => {
    const directory = createTestNotesDirectory();
    const repo = createTestGitTopic();
    await saveTestCommitReview(directory, "g1", `${repo.root}${sep}`, repo.topic);
    repo.run("branch", "-qD", "topic");

    expect(await pruneTestReviews(directory)).toEqual(["g1"]);
  });

  // Passes when a provider without a history capability leaves the commit review in place.
  test("keeps a review when the provider has no history", async () => {
    const directory = createTestNotesDirectory();
    const repo = createTestGitTopic();
    await saveTestCommitReview(directory, "g1", repo.root, repo.topic);
    repo.run("branch", "-qD", "topic");
    const noHistory: VcsAdapter = {
      id: "plain",
      name: "Plain",
      detect: (cwd) => (cwd === repo.root ? { id: "plain", repoRoot: repo.root } : null),
      operations: {},
    };
    const check = createVcsCommitCheck(createVcsCatalog([noHistory], "plain"));

    expect(await removeGoneSavedReviews(directory, { isCommitGone: check.isCommitGone })).toEqual(
      [],
    );
    await check.close();
    expect(await savedTestKeys(directory)).toEqual(["g1"]);
  });

  // Passes when the check a session opens answers only for the repository it opened: a gone
  // commit of another repository stays saved until that repository's own session or
  // `hunk notes prune` checks it.
  test("a session checks only the repository it opened", async () => {
    const directory = createTestNotesDirectory();
    const repo = createTestGitTopic();
    const other = createTestGitTopic();
    await saveTestCommitReview(directory, "g1", repo.root, repo.topic);
    await saveTestCommitReview(directory, "o1", other.root, other.topic);
    repo.run("branch", "-qD", "topic");
    other.run("branch", "-qD", "topic");

    const check = openSessionCommitCheck({
      repoRoot: repo.root,
      vcsCatalog: getBundledVcsCatalog(),
    });
    expect(check).toBeDefined();
    expect(await removeGoneSavedReviews(directory, { isCommitGone: check!.isCommitGone })).toEqual([
      "g1",
    ]);
    await check!.close();
    expect(await savedTestKeys(directory)).toEqual(["o1"]);
    expect(openSessionCommitCheck({ vcsCatalog: getBundledVcsCatalog() })).toBeUndefined();
  });
});
