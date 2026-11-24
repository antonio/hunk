/**
 * Names the review a note store saves notes for, so the next launch of the same review finds
 * them and a different review does not.
 *
 * The identity comes from what the user asked to review, made launch-independent: file paths
 * become absolute, pathspecs are sorted, and revisions are the resolved ones the VCS reported
 * in the review descriptor when there is one, so `show HEAD` keys on the commit rather than on
 * the word `HEAD`. A change request is keyed by provider, repository, and id whatever input
 * carried it. A patch read from standard input has no identity across launches, so it gets no
 * target and its notes are not saved.
 */
import { resolve } from "node:path";
import type { AppBootstrap } from "../core/bootstrap";
import { nodeReviewDigest } from "../core/reviewDigest";
import type { ExtensionReviewNoteStoreTarget } from "../extension-api/types";

/** Resolve one user-given path against the launch directory, normalized for this platform. */
function absolute(cwd: string, path: string) {
  return resolve(cwd, path);
}

/** The operation and spec one launch input names, or undefined when it has no stable identity. */
function identify(
  bootstrap: Pick<AppBootstrap, "input" | "reloadContext" | "review">,
): Pick<ExtensionReviewNoteStoreTarget, "operation" | "spec"> | undefined {
  const { input, review } = bootstrap;
  const cwd = bootstrap.reloadContext.cwd;
  if (review?.kind === "change-request") {
    return {
      operation: "change-request",
      spec: [review.provider, review.repository ?? "", review.id],
    };
  }

  switch (input.kind) {
    case "vcs": {
      const range =
        review?.kind === "comparison"
          ? `${review.base}..${review.head}`
          : input.rangeEndpoints
            ? `${input.rangeEndpoints.from}..${input.rangeEndpoints.to}`
            : (input.range ?? "");
      return {
        operation: "vcs",
        spec: [input.staged ? "staged" : "unstaged", range, ...[...(input.pathspecs ?? [])].sort()],
      };
    }
    case "show":
      return {
        operation: "show",
        spec: [
          review?.kind === "commit" ? review.revision : (input.ref ?? "HEAD"),
          ...[...(input.pathspecs ?? [])].sort(),
        ],
      };
    case "stash-show":
      return { operation: "stash-show", spec: [input.ref ?? ""] };
    case "patch":
      return input.file && input.file !== "-" && input.text === undefined
        ? { operation: "patch", spec: [absolute(cwd, input.file)] }
        : undefined;
    case "diff":
      return { operation: "diff", spec: [absolute(cwd, input.left), absolute(cwd, input.right)] };
    case "difftool":
      return {
        operation: "difftool",
        spec: [absolute(cwd, input.left), absolute(cwd, input.right), input.path ?? ""],
      };
  }
}

/** Build the note-store target for one launch, or undefined when its notes cannot be found again. */
export function reviewNoteStoreTarget(
  bootstrap: Pick<AppBootstrap, "input" | "reloadContext" | "review">,
): ExtensionReviewNoteStoreTarget | undefined {
  const identity = identify(bootstrap);
  if (!identity) return undefined;
  const repoRoot = bootstrap.reloadContext.repoRoot;
  const key = nodeReviewDigest(
    new TextEncoder().encode(JSON.stringify([repoRoot ?? "", identity.operation, identity.spec])),
  );
  return Object.freeze({
    key,
    operation: identity.operation,
    spec: Object.freeze([...identity.spec]),
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    ...(bootstrap.review ? { review: bootstrap.review } : {}),
  });
}
