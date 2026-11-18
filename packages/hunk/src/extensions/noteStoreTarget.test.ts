import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { AppBootstrap } from "../core/bootstrap";
import type { CliInput } from "../core/run/commandInputs";
import type { ExtensionReviewDescriptor } from "../extension-api/types";
import { reviewNoteStoreTarget } from "./noteStoreTarget";

// Expected values come from the plan's store-key rule (task note "Embed Hunk as a panel inside
// Pi", Antonio's feedback): reviews are keyed by what was reviewed — resolved commit SHAs, not
// ref text such as HEAD, and PRs by their identity — and a different review never shares a key.

/** The launch facts the target reads, for one input. */
function createTestLaunch(
  input: CliInput,
  review?: ExtensionReviewDescriptor,
): Pick<AppBootstrap, "input" | "reloadContext" | "review"> {
  return {
    input,
    reloadContext: { cwd: REPO, repoRoot: REPO },
    ...(review ? { review } : {}),
  };
}

/** A platform-native absolute repository path. */
const REPO = resolve("work-repo");
const options = {} as CliInput["options"];
const vcs = (staged: boolean, pathspecs?: string[]): CliInput => ({
  kind: "vcs",
  staged,
  ...(pathspecs ? { pathspecs } : {}),
  options,
});
const commit = (revision: string): ExtensionReviewDescriptor => ({
  kind: "commit",
  provider: "Git",
  title: "t",
  revision,
});

describe("reviewNoteStoreTarget", () => {
  // Passes when one review always gets one key, and reviews that differ in what they show get
  // different keys.
  test("gives each review its own stable key", () => {
    const key = (input: CliInput, review?: ExtensionReviewDescriptor) =>
      reviewNoteStoreTarget(createTestLaunch(input, review))?.key;

    expect(key(vcs(false, ["b", "a"]))).toBe(key(vcs(false, ["a", "b"])));
    expect(key(vcs(false))).not.toBe(key(vcs(true)));
    expect(key({ kind: "show", ref: "HEAD", options }, commit("abc123"))).toBe(
      key({ kind: "show", ref: "main", options }, commit("abc123")),
    );
    expect(key({ kind: "show", ref: "HEAD", options }, commit("abc123"))).not.toBe(
      key({ kind: "show", ref: "HEAD", options }, commit("def456")),
    );
    expect(key({ kind: "patch", file: "change.patch", options })).toBe(
      key({ kind: "patch", file: join(REPO, "change.patch"), options }),
    );
  });

  // Passes when a show review names the resolved commit, not the ref text.
  test("names commits by their resolved revision", () => {
    expect(
      reviewNoteStoreTarget(
        createTestLaunch({ kind: "show", ref: "HEAD", options }, commit("abc123")),
      ),
    ).toMatchObject({ operation: "show", spec: ["abc123"], repoRoot: REPO });
  });

  // Passes when a change request is keyed by provider, repository, and id whatever input
  // carried it.
  test("keys change requests by their identity", () => {
    const pr: ExtensionReviewDescriptor = {
      kind: "change-request",
      provider: "GitHub",
      title: "Fix",
      id: "#12",
      repository: "antonio/hunk",
    };

    expect(
      reviewNoteStoreTarget(
        createTestLaunch({ kind: "patch", file: join(REPO, "a.patch"), options }, pr),
      ),
    ).toMatchObject({ operation: "change-request", spec: ["GitHub", "antonio/hunk", "#12"] });
  });

  // Passes when a patch read from standard input gets no target, since no later launch can
  // name the same review.
  test("gives a patch from standard input no target", () => {
    expect(
      reviewNoteStoreTarget(createTestLaunch({ kind: "patch", text: "diff --git", options })),
    ).toBeUndefined();
    expect(
      reviewNoteStoreTarget(createTestLaunch({ kind: "patch", file: "-", options })),
    ).toBeUndefined();
  });
});
