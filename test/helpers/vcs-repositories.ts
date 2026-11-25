/**
 * Creates throwaway Git and Jujutsu repositories for tests that need a real VCS behind Hunk's
 * providers. Each repository lives in its own temporary directory (resolved through symlinks, as
 * the providers report roots) with a fixed author, and ignores the user's own VCS configuration.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Whether the `jj` CLI is installed; CI installs it, other machines may not. */
export const hasTestJj = Bun.which("jj") !== null;

/** Run one command and return its trimmed stdout; throws with stderr when it fails. */
export function runTestCommand(
  cwd: string,
  argv: readonly string[],
  env: Record<string, string> = {},
) {
  const result = Bun.spawnSync([...argv], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

/** A temporary directory with symlinks resolved. */
function createTestDirectory(prefix: string) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** One test repository: its root, a runner for its VCS, and a file writer. */
export interface TestRepository {
  root: string;
  /** Run the repository's VCS with these arguments; returns trimmed stdout. */
  run(...args: string[]): string;
  /** Write one file relative to the root. */
  write(path: string, text: string): void;
}

/** A Git repository on branch `main` with no commits yet. */
export function createTestGitRepository(prefix = "hunk-test-git-"): TestRepository {
  const parent = createTestDirectory(prefix);
  const root = join(parent, "repo");
  mkdirSync(root);
  const env = {
    GIT_CONFIG_GLOBAL: join(parent, "git-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "author@example.com",
  };
  runTestCommand(root, ["git", "init", "-qb", "main"], env);
  return {
    root,
    run: (...args) => runTestCommand(root, ["git", ...args], env),
    write: (path, text) => writeFileSync(join(root, path), text),
  };
}

/** A Jujutsu repository (not colocated with Git) whose working copy is an empty change. */
export function createTestJjRepository(prefix = "hunk-test-jj-"): TestRepository {
  const parent = createTestDirectory(prefix);
  const root = join(parent, "repo");
  const config = join(parent, "jj-config.toml");
  writeFileSync(config, 'user.name = "Test Author"\nuser.email = "author@example.com"\n');
  const env = { JJ_CONFIG: config };
  runTestCommand(parent, ["jj", "git", "init", "--no-colocate", root], env);
  return {
    root,
    run: (...args) => runTestCommand(root, ["jj", ...args], env),
    write: (path, text) => writeFileSync(join(root, path), text),
  };
}
