/** Open a saved review-pr bundle at its pinned Git comparison and synchronize only file visibility. */
import { HunkExtensionUserError, type ExtensionFactory } from "hunkdiff/extension";
import { parseBundleInvocation, readBundle, validateBundleCheckout } from "./bundle";
import { createGitHubViewedClient } from "./github";
import { runCommand, type CommandRunner } from "./process";
import { createViewedSync } from "./sync";

/** Register the bundle workflow with subprocess boundaries injectable for offline tests. */
export function createReviewBundleExtension(run: CommandRunner = runCommand): ExtensionFactory {
  return (hunk) => {
    let sync: ReturnType<typeof createViewedSync> | undefined;
    hunk.registerCliCommand(
      {
        name: "review-bundle",
        summary: "Open a pinned review bundle with GitHub Viewed sync",
        usage: "<directory> [--expect-base OID --expect-head OID] [-- <presentation-options>]",
      },
      async (args, ctx) => {
        if (args.length === 1 && args[0] === "--help") {
          await ctx.stdout.write(
            "Usage: hunk review-bundle <directory> [--expect-base OID --expect-head OID] [-- <presentation-options>]\nRun in the bundle repository checkout. Reads metadata.json; GitHub sync uses authenticated gh.\nRefresh pulls Viewed only. Refresh a stale bundle through the assessment workflow and reopen.\n",
          );
          return { kind: "exit" };
        }
        try {
          const invocation = parseBundleInvocation(args);
          const bundle = await readBundle(invocation.directory, ctx.cwd);
          if (
            (invocation.expectedBase && invocation.expectedBase !== bundle.mergeBase) ||
            (invocation.expectedHead && invocation.expectedHead !== bundle.head)
          )
            throw new Error(
              "Bundle comparison no longer matches the launcher's expected revisions. Refresh the review link before opening.",
            );
          await validateBundleCheckout(bundle, ctx.cwd, run, ctx.signal);
          ctx.signal.throwIfAborted();
          sync?.close();
          sync = createViewedSync(bundle, createGitHubViewedClient(bundle, ctx.cwd, run));
          return {
            kind: "delegate",
            argv: [
              "diff",
              bundle.mergeBase,
              bundle.head,
              "--vcs",
              "git",
              "--exclude-untracked",
              ...invocation.diffArgs,
            ],
          };
        } catch (error) {
          throw new HunkExtensionUserError(
            error instanceof Error ? error.message : "Could not open review bundle.",
          );
        }
      },
    );
    hunk.on("changeset_loaded", (_event, ctx) => sync?.refresh(ctx));
    hunk.on("file_viewed_changed", (event, ctx) => sync?.changed(event, ctx));
    hunk.on("shutdown", () => sync?.close());
  };
}

export default createReviewBundleExtension();
