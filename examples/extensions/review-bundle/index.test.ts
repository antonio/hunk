import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmptyExtensionRegistry,
  type ExtensionLoadIssue,
} from "../../../packages/hunk/src/extensions/types";
import { runExtensionFactory } from "../../../packages/hunk/src/extensions/runExtension";
import { parseCli } from "../../../packages/hunk/src/app/cli";
import { getBundledVcsCatalog } from "../../../packages/hunk/src/app/vcsCatalog";
import { loadAppBootstrap } from "../../../packages/hunk/src/core/changeset/loaders";
import type { ExtensionCliCommandContext } from "hunkdiff/extension";
import { createReviewBundleExtension } from "./index";
import { runCommand } from "./process";

/** Build real immutable commits and an explicit saved bundle, without network access. */
function createTestBundle() {
  const root = mkdtempSync(join(tmpdir(), "hunk-review-bundle-"));
  const repo = join(root, "repo"),
    bundle = join(root, "bundle");
  mkdirSync(repo);
  mkdirSync(bundle);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Hunk test");
  git("config", "user.email", "hunk-test@example.invalid");
  git("remote", "add", "origin", "https://github.com/acme/project.git");
  writeFileSync(join(repo, "alpha.ts"), "export const alpha = 1;\n");
  git("add", "alpha.ts");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "alpha.ts"), "export const alpha = 2;\n");
  git("commit", "-qam", "head");
  const head = git("rev-parse", "HEAD");
  const metadata = JSON.stringify({
    repository: "acme/project",
    number: 7,
    url: "https://github.com/acme/project/pull/7",
    base_oid: base,
    head_oid: head,
    merge_base_oid: base,
  });
  writeFileSync(join(bundle, "metadata.json"), metadata);
  const notes = join(bundle, "explicit-notes.json");
  writeFileSync(
    notes,
    JSON.stringify({
      version: 1,
      files: [
        {
          path: "alpha.ts",
          annotations: [{ summary: "Preserve this human decision", newRange: [1, 1] }],
        },
      ],
    }),
  );
  return { root, repo, bundle, base, head, metadata, notes, git };
}

test("bundle command uses actual Git comparison and explicit notes without touching bundle artifacts", async () => {
  const fixture = createTestBundle();
  try {
    const registry = createEmptyExtensionRegistry(),
      issues: ExtensionLoadIssue[] = [];
    await runExtensionFactory({
      metadata: { id: "review-bundle", sourcePath: "test", origin: "flag" },
      registry,
      issues,
      factory: createReviewBundleExtension(async (binary, args, cwd, signal) => {
        if (binary === "gh") throw new Error("Live GitHub calls forbidden in this test");
        return runCommand(binary, args, cwd, signal);
      }),
    });
    expect(issues).toEqual([]);
    const context: ExtensionCliCommandContext = {
      cwd: fixture.repo,
      signal: new AbortController().signal,
      stdin: {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new Error("stdin must not be read");
            },
          };
        },
      },
      stdout: {
        write: async () => {
          throw new Error("stdout must not be written during delegation");
        },
      },
      stderr: { write: async () => {} },
    };
    const handler = registry.cliCommands[0]!.handler;
    const result = await handler(
      [
        fixture.bundle,
        "--expect-base",
        fixture.base,
        "--expect-head",
        fixture.head,
        "--",
        "--agent-context",
        fixture.notes,
      ],
      context,
    );
    if (result.kind !== "delegate") throw new Error("Expected delegation");
    expect(result.argv).toEqual([
      "diff",
      fixture.base,
      fixture.head,
      "--vcs",
      "git",
      "--exclude-untracked",
      "--agent-context",
      fixture.notes,
    ]);
    expect(result.review).toBeUndefined();
    const input = await parseCli(["bun", "hunk", ...result.argv]);
    if (input.kind !== "vcs") throw new Error("Expected VCS comparison");
    const loaded = await loadAppBootstrap(input, {
      cwd: fixture.repo,
      vcsCatalog: getBundledVcsCatalog(),
    });
    expect(loaded.review).toMatchObject({
      kind: "comparison",
      provider: "Git",
      base: fixture.base,
      head: fixture.head,
    });
    expect(loaded.changeset.files[0]?.agent?.annotations[0]?.summary).toBe(
      "Preserve this human decision",
    );
    expect(readFileSync(join(fixture.bundle, "metadata.json"), "utf8")).toBe(fixture.metadata);
    await expect(
      handler(
        [fixture.bundle, "--expect-base", fixture.base, "--expect-head", "3".repeat(40)],
        context,
      ),
    ).rejects.toThrow("no longer matches");
    fixture.git("remote", "set-url", "origin", "https://github.com/another/project.git");
    await expect(handler([fixture.bundle], context)).rejects.toThrow("does not match");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("subprocess failure and cancellation never include command output in error messages", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(runCommand("git", ["version"], process.cwd(), controller.signal)).rejects.toThrow(
    "cancelled",
  );
  try {
    await runCommand(
      "git",
      ["invalid-secret-output-command"],
      process.cwd(),
      new AbortController().signal,
    );
    throw new Error("Expected failure");
  } catch (error) {
    expect(String(error)).toContain("Cannot validate");
    expect(String(error)).not.toContain("secret-output");
  }
});
