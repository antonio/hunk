import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareStartupPlan } from "../../packages/hunk/src/app/startup";
import {
  builtInNoteStoreDirectory,
  createFileNoteStore,
  savedReviewNotesPath,
} from "../../packages/hunk/src/extensions/default/core/notes";
import { reviewNoteStoreTarget } from "../../packages/hunk/src/extensions/noteStoreTarget";
import { createTestJjRepository, hasTestJj } from "../helpers/vcs-repositories";

// Expected behavior comes from the plan's step-7 acceptance criteria and Antonio's decision on
// `clear` (task note "Embed Hunk as a panel inside Pi"): `list` shows each saved review with its
// note count and last change; bare `clear` clears what plain `hunk diff` shows, `clear <review
// command>` what that command shows (`show HEAD` by its resolved commit), `--all` everything;
// `prune --older-than 30d` removes reviews unchanged for 30 days; nothing else is deleted.

const dirs: string[] = [];
const main = resolve(import.meta.dir, "../../packages/hunk/src/main.tsx");
const DAY_MS = 86_400_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository with two commits and an uncommitted change, plus isolated config and state. */
function createTestWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "hunk-notes-cli-"));
  dirs.push(root);
  const repo = join(root, "repo");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
  };
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, {
      cwd: repo,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
  mkdirSync(repo);
  for (const args of [
    ["init", "-qb", "main"],
    ["config", "user.name", "Notes Test"],
    ["config", "user.email", "notes@example.com"],
  ]) {
    expect(run(["git", ...args]).code).toBe(0);
  }
  for (const [index, content] of ["one\n", "two\n", "three\n"].entries()) {
    writeFileSync(join(repo, "file.txt"), content);
    expect(run(["git", "add", "."]).code).toBe(0);
    expect(run(["git", "commit", "-qm", `commit ${index + 1}`]).code).toBe(0);
  }
  writeFileSync(join(repo, "file.txt"), "working\n");
  const hunk = (...args: string[]) => run([process.execPath, "run", main, ...args]);
  return { repo, env, run, hunk, directory: builtInNoteStoreDirectory(env) };
}

/** Save one note for the review a Hunk command names, as the built-in store would. */
async function saveTestNoteFor(
  workspace: Pick<ReturnType<typeof createTestWorkspace>, "repo" | "env" | "directory">,
  args: string[],
) {
  // VCS loading reads the process directory, as the real command run in the repository does.
  const previousCwd = process.cwd();
  process.chdir(workspace.repo);
  let plan: Awaited<ReturnType<typeof prepareStartupPlan>>;
  try {
    plan = await prepareStartupPlan(["bun", "hunk", "notes", "clear", ...args], {
      cwd: workspace.repo,
      env: workspace.env,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
  } finally {
    process.chdir(previousCwd);
  }
  if (plan.kind !== "notes" || !plan.review) throw new Error("expected a notes plan with a review");
  const target = reviewNoteStoreTarget(plan.review)!;
  await createFileNoteStore(workspace.directory).save(target, [
    {
      note: {
        id: `user:${args.join("-") || "diff"}`,
        source: "user",
        fileKey: "file:x",
        anchor: { intersectingHunkIndices: [0] },
        summary: "saved",
        editable: true,
      },
      filePath: "file.txt",
      contentIdentity: "content:x",
    },
  ]);
  return target.key;
}

describe("hunk notes CLI contract", () => {
  // Passes when list names the commit review by the commit `git rev-parse HEAD` reports, and
  // clearing `show HEAD` removes that review's file and leaves the working-tree review alone.
  test("lists saved reviews and clears the one a review command names", async () => {
    const workspace = createTestWorkspace();
    const headSha = workspace.run(["git", "rev-parse", "HEAD"]).stdout.trim();
    const showKey = await saveTestNoteFor(workspace, ["show", "HEAD"]);
    const diffKey = await saveTestNoteFor(workspace, []);
    expect(showKey).not.toBe(diffKey);

    const listed = workspace.hunk("notes", "list");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(`show ${headSha.slice(0, 12)}`);
    expect(listed.stdout).toContain("working tree");
    const json = JSON.parse(workspace.hunk("notes", "list", "--json").stdout) as {
      reviews: Array<{ key: string; noteCount: number }>;
    };
    expect(json.reviews.map(({ key, noteCount }) => [key, noteCount]).sort()).toEqual(
      [
        [diffKey, 1],
        [showKey, 1],
      ].sort(),
    );

    const cleared = workspace.hunk("notes", "clear", "show", "HEAD");
    expect(cleared.code).toBe(0);
    expect(cleared.stdout).toContain(`Cleared the saved notes for`);
    expect(existsSync(savedReviewNotesPath(workspace.directory, { key: showKey }))).toBe(false);
    expect(existsSync(savedReviewNotesPath(workspace.directory, { key: diffKey }))).toBe(true);

    expect(workspace.hunk("notes", "clear").code).toBe(0);
    expect(existsSync(savedReviewNotesPath(workspace.directory, { key: diffKey }))).toBe(false);
  });

  // Passes when prune removes exactly the reviews (and leftover temporary files) last changed
  // more than 30 days ago, --key clears one review by a prefix of its key, and --all the rest.
  test("prunes by age and clears by key or all", async () => {
    const workspace = createTestWorkspace();
    const old = await saveTestNoteFor(workspace, ["show", "HEAD~2"]);
    const recent = await saveTestNoteFor(workspace, ["show", "HEAD~1"]);
    const fresh = await saveTestNoteFor(workspace, ["show", "HEAD"]);
    const stale = new Date(Date.now() - 40 * DAY_MS);
    utimesSync(savedReviewNotesPath(workspace.directory, { key: old }), stale, stale);
    const recentTime = new Date(Date.now() - 10 * DAY_MS);
    utimesSync(savedReviewNotesPath(workspace.directory, { key: recent }), recentTime, recentTime);
    const leftover = join(workspace.directory, `${fresh}.json.interrupted.tmp`);
    writeFileSync(leftover, "{");
    utimesSync(leftover, stale, stale);

    const pruned = workspace.hunk("notes", "prune", "--older-than", "30d");
    expect(pruned.stdout).toBe("Removed saved notes for 1 review.\n");
    expect(readdirSync(workspace.directory).sort()).toEqual(
      [`${fresh}.json`, `${recent}.json`].sort(),
    );

    expect(workspace.hunk("notes", "clear", "--key", recent.slice(0, 12)).code).toBe(0);
    expect(readdirSync(workspace.directory)).toEqual([`${fresh}.json`]);
    expect(workspace.hunk("notes", "clear", "--all").stdout).toBe(
      "Removed saved notes for 1 review.\n",
    );
    expect(readdirSync(workspace.directory)).toEqual([]);
    expect(workspace.hunk("notes", "list").stdout).toBe("No saved notes.\n");
  });

  // Source: Antonio's pruning rule (a saved commit review goes once its commit is gone) with
  // the 2026-11-24 decision to answer it through Hunk's VCS interface. Passes when `hunk notes
  // prune` keeps a Git commit review while a branch reaches the commit and removes it after the
  // branch is deleted.
  test("prunes a Git commit review once its branch is deleted", async () => {
    const workspace = createTestWorkspace();
    expect(workspace.run(["git", "switch", "-qc", "topic"]).code).toBe(0);
    expect(workspace.run(["git", "commit", "-qam", "topic"]).code).toBe(0);
    const topic = workspace.run(["git", "rev-parse", "HEAD"]).stdout.trim();
    expect(workspace.run(["git", "switch", "-q", "main"]).code).toBe(0);
    const key = await saveTestNoteFor(workspace, ["show", topic]);

    expect(workspace.hunk("notes", "prune").stdout).toBe("Removed saved notes for 0 reviews.\n");
    expect(workspace.run(["git", "branch", "-qD", "topic"]).code).toBe(0);
    expect(workspace.hunk("notes", "prune").stdout).toBe("Removed saved notes for 1 review.\n");
    expect(existsSync(savedReviewNotesPath(workspace.directory, { key }))).toBe(false);
  });

  // jj is an external CLI: CI installs it, so this runs there; a machine without it skips it.
  // Passes when `hunk notes prune` keeps a Jujutsu commit review while the commit is visible and
  // removes it once the commit is abandoned.
  (hasTestJj ? test : test.skip)(
    "prunes a Jujutsu commit review once its commit is abandoned",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "hunk-notes-cli-jj-"));
      dirs.push(root);
      const jj = createTestJjRepository();
      dirs.push(dirname(jj.root));
      jj.write("file.txt", "one\n");
      jj.run("commit", "-m", "first");
      jj.write("file.txt", "two\n");
      jj.run("commit", "-m", "second");
      const second = jj.run("log", "--no-graph", "-r", "@-", "-T", "commit_id");
      const env = {
        ...process.env,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
      };
      const workspace = { repo: jj.root, env, directory: builtInNoteStoreDirectory(env) };
      const key = await saveTestNoteFor(workspace, ["show", second]);
      const prune = () =>
        Bun.spawnSync([process.execPath, "run", main, "notes", "prune"], {
          cwd: jj.root,
          env,
          stdout: "pipe",
          stderr: "pipe",
        }).stdout.toString();

      expect(prune()).toBe("Removed saved notes for 0 reviews.\n");
      jj.run("abandon", second);
      expect(prune()).toBe("Removed saved notes for 1 review.\n");
      expect(existsSync(savedReviewNotesPath(workspace.directory, { key }))).toBe(false);
    },
  );
});
