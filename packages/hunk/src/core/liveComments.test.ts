import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../../test/helpers/diff-helpers";
import { findDiffFileByPath, findHunkIndexForLine, lowerSessionComment } from "./liveComments";
import { reviewHunkRanges } from "./review/geometry";

function createExampleDiffFile() {
  return createTestDiffFile({
    after: lines(
      "export const alpha = 2;",
      "export const keep = true;",
      "export const beta = 2;",
      "export const gamma = true;",
    ),
    before: lines("export const alpha = 1;", "export const keep = true;", "export const beta = 1;"),
    context: 3,
    id: "file:example",
    path: "src/example.ts",
    previousPath: "src/example-old.ts",
  });
}

describe("live comment helpers", () => {
  test("finds a diff file by current or previous path", () => {
    const file = createExampleDiffFile();

    expect(findDiffFileByPath([file], "src/example.ts")?.id).toBe(file.id);
    expect(findDiffFileByPath([file], "src/example-old.ts")?.id).toBe(file.id);
    expect(findDiffFileByPath([file], "missing.ts")).toBeUndefined();
  });

  test("maps old/new line numbers onto the covering hunk", () => {
    const file = createExampleDiffFile();

    expect(findHunkIndexForLine(file, "old", 1)).toBe(0);
    expect(findHunkIndexForLine(file, "new", 2)).toBe(0);
    expect(findHunkIndexForLine(file, "new", 40)).toBe(-1);
  });

  /** Resolve the one test path the way the session edge does, and refuse any other. */
  const resolveTestFileKey = (filePath: string) => {
    if (filePath !== "src/example.ts") throw new Error(`No file ${filePath}`);
    return "file:example";
  };

  // Source: `hunk session comment add` (docs/agent-workflows.md and the generated skill):
  // agent comments are agent notes labelled by `--author`, tagged `mcp`, high confidence.
  // Passes when a line comment lowers to an agent-authored `notes/create` at that line with
  // every body field carried and no placement decided here.
  test("lowers a line comment to an agent note write", () => {
    expect(
      lowerSessionComment(
        {
          filePath: "src/example.ts",
          side: "new",
          line: 4,
          summary: "Note",
          rationale: "Why this matters",
          markup: "<box border>shape</box>",
          author: "Pi",
        },
        resolveTestFileKey,
      ),
    ).toEqual({
      intent: {
        type: "notes/create",
        fileKey: "file:example",
        target: { side: "new", line: 4 },
        body: {
          summary: "Note",
          rationale: "Why this matters",
          markup: "<box border>shape</box>",
          tags: ["mcp"],
          confidence: "high",
        },
      },
      authorship: { source: "agent", channel: "session-cli", label: "Pi" },
    });
  });

  // Source: the session command's `--hunk` and `--reply-to` forms. Passes when a hunk-wide
  // comment names the hunk, and a reply names only its parent.
  test("lowers hunk-wide comments and replies without resolving their lines", () => {
    expect(
      lowerSessionComment(
        { filePath: "src/example.ts", hunkIndex: 0, summary: "Hunk" },
        resolveTestFileKey,
      ).intent,
    ).toEqual({
      type: "notes/create",
      fileKey: "file:example",
      target: { hunkIndex: 0 },
      body: { summary: "Hunk", tags: ["mcp"], confidence: "high" },
    });
    expect(
      lowerSessionComment({ replyTo: "user:1", summary: "Reply" }, resolveTestFileKey),
    ).toEqual({
      intent: {
        type: "notes/create",
        parentId: "user:1",
        body: { summary: "Reply", tags: ["mcp"], confidence: "high" },
      },
      authorship: { source: "agent", channel: "session-cli" },
    });
  });

  // Source: the session command's input rules. Passes when each malformed comment is refused
  // with the message agents have always received, and an unknown path with the resolver's.
  test("refuses comment shapes the session commands do not accept", () => {
    expect(() =>
      lowerSessionComment(
        { replyTo: "user:1", filePath: "src/example.ts", summary: "x" } as never,
        resolveTestFileKey,
      ),
    ).toThrow("A reply comment must not include an explicit file or target.");
    expect(() =>
      lowerSessionComment({ side: "new", line: 1, summary: "x" } as never, resolveTestFileKey),
    ).toThrow("A root comment requires a file path.");
    expect(() =>
      lowerSessionComment(
        { filePath: "src/example.ts", summary: "x" } as never,
        resolveTestFileKey,
      ),
    ).toThrow("Specify either hunkIndex or both side and line for src/example.ts.");
    expect(() =>
      lowerSessionComment(
        { filePath: "missing.ts", hunkIndex: 0, summary: "x" },
        resolveTestFileKey,
      ),
    ).toThrow("No file missing.ts");
  });

  // Regression: a hunk with one addition surrounded by lots of context used to report
  // newRange = [start, start] (additions-only), so a comment anchored past the leading
  // context fell outside the hunk's range, annotationOverlapsHunk returned false, and
  // the hunk silently disappeared from getAnnotatedHunkIndices / annotated-cursor lists.
  // Fix: reviewHunkRange uses additionCount/deletionCount (header total, includes context)
  // instead of additionLines/deletionLines (just '+' / '-' counts).
  test("includes context lines when one hunk has many context rows around few changes", () => {
    // 12 leading + 1 added + many trailing context lines on the new side.
    const beforeLines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`);
    const afterLines = [...beforeLines.slice(0, 12), "INSERTED", ...beforeLines.slice(12)];

    const file = createTestDiffFile({
      before: lines(...beforeLines),
      after: lines(...afterLines),
      context: 100,
      id: "file:context-heavy",
      path: "src/sparse.ts",
      previousPath: "src/sparse.ts",
    });

    expect(file.metadata.hunks.length).toBe(1);
    const hunk = file.metadata.hunks[0]!;
    expect(hunk.additionLines).toBe(1);

    const range = reviewHunkRanges(hunk);

    // The range must cover the inserted line at position 13 — additions-only bounds
    // would put newEnd at additionStart and miss it.
    expect(range.newRange[1]).toBeGreaterThanOrEqual(13);
    expect(findHunkIndexForLine(file, "new", 13)).toBe(0);
    expect(findHunkIndexForLine(file, "new", 20)).toBe(0);
  });
});
