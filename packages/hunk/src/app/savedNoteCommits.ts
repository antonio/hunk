/**
 * Answers whether the commit a saved review was about still exists, through the VCS provider
 * Hunk selects for that review's repository.
 *
 * Saved-note pruning (`hunk notes prune`, and the background pass when a review opens with
 * saving on) asks this for commit and comparison reviews. A commit still exists while the
 * provider's history of every branch, tag, bookmark, and head (`history.open({ all: true })`)
 * contains it, so the answer means the same thing for Git, Jujutsu, and any provider with a
 * history capability. Hunk never spawns a VCS itself here: the provider owns traversal.
 *
 * One check reads each repository's history at most once, lazily and incrementally: a commit
 * already seen answers at once, and a commit not seen yet reads further pages of the same
 * cursor. A scan stops at `COMMIT_SCAN_LIMIT` commits. When the provider cannot answer — no
 * provider recognizes the directory, it detects a different repository root, it has no history
 * capability, a read fails, or the scan limit is reached first — the answer is `undefined`, and
 * callers keep the review.
 */
import type { ReloadContext } from "../core/bootstrap";
import { detectVcs } from "../core/vcs";
import type { VcsCatalog, VcsHistorySource } from "../core/vcs/types";
import type { CommitCheck } from "../extensions/default/core/notes";

/**
 * Most commits one check reads from one repository's history. A reviewed commit is usually
 * recent, so it is found long before this; only a commit that is really gone reads the whole
 * history, and a history longer than this leaves the answer unknown rather than costing an
 * unbounded background scan on every launch.
 */
export const COMMIT_SCAN_LIMIT = 10_000;

/** Commits read per page; the largest page the bundled providers return. */
const HISTORY_PAGE_SIZE = 256;

/** One repository's history scan, shared by every question about that repository. */
interface RepositoryScan {
  source: VcsHistorySource;
  seen: Set<string>;
  read: number;
  done: boolean;
  failed: boolean;
  /** Serializes reads: a provider cursor allows one read at a time. */
  queue: Promise<unknown>;
}

/**
 * Create a check that asks each repository's provider, chosen from `catalog` the way a review
 * of that directory chooses it. `onlyRepoRoot` limits it to one repository; every other
 * repository's answer is unknown.
 */
export function createVcsCommitCheck(
  catalog: VcsCatalog,
  { onlyRepoRoot }: { onlyRepoRoot?: string } = {},
): CommitCheck {
  const scans = new Map<string, Promise<RepositoryScan | undefined>>();

  /** Open the history of every branch, tag, and head in one repository, if its provider can. */
  const openScan = async (repoRoot: string): Promise<RepositoryScan | undefined> => {
    const detection = detectVcs(repoRoot, catalog);
    // A different root means the reviewed checkout is gone or nested elsewhere: not its history.
    if (!detection || detection.repoRoot !== repoRoot) return undefined;
    const adapter = catalog.adapters.find((candidate) => candidate.id === detection.id);
    if (!adapter?.history) return undefined;
    try {
      const source = await adapter.history.open({ all: true }, { cwd: repoRoot });
      return {
        source,
        seen: new Set(),
        read: 0,
        done: false,
        failed: false,
        queue: Promise.resolve(),
      };
    } catch {
      return undefined;
    }
  };

  /** Read pages until the commit is seen, the history ends, or the scan stops. */
  const answer = async (scan: RepositoryScan, revision: string) => {
    while (
      !scan.seen.has(revision) &&
      !scan.done &&
      !scan.failed &&
      scan.read < COMMIT_SCAN_LIMIT
    ) {
      try {
        const page = await scan.source.read({
          limit: Math.min(HISTORY_PAGE_SIZE, COMMIT_SCAN_LIMIT - scan.read),
        });
        for (const commit of page.commits) scan.seen.add(commit.revisionId);
        scan.read += page.commits.length;
        scan.done = page.done;
      } catch {
        scan.failed = true;
      }
    }
    if (scan.seen.has(revision)) return false;
    return scan.done ? true : undefined;
  };

  return {
    async isCommitGone(repoRoot, revision) {
      if (onlyRepoRoot !== undefined && repoRoot !== onlyRepoRoot) return undefined;
      let opened = scans.get(repoRoot);
      if (!opened) {
        opened = openScan(repoRoot);
        scans.set(repoRoot, opened);
      }
      const scan = await opened;
      if (!scan) return undefined;
      const result = scan.queue.then(() => answer(scan, revision));
      scan.queue = result.catch(() => undefined);
      return await result;
    },
    async close() {
      const opened = await Promise.all(scans.values());
      scans.clear();
      await Promise.all(opened.map((scan) => scan?.source.close().catch(() => undefined)));
    },
  };
}

/**
 * The check a review session runs when it opens: only the repository it opened, through the
 * catalog that loaded it, so a launch never scans other repositories' histories. Undefined when
 * the review has no repository.
 */
export function openSessionCommitCheck({
  repoRoot,
  vcsCatalog,
}: Pick<ReloadContext, "repoRoot" | "vcsCatalog">): CommitCheck | undefined {
  return repoRoot !== undefined && vcsCatalog
    ? createVcsCommitCheck(vcsCatalog, { onlyRepoRoot: repoRoot })
    : undefined;
}
