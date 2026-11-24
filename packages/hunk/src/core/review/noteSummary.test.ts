import { describe, expect, test } from "bun:test";
import { projectReviewNoteSummary, reviewNoteListRecord } from "./noteSummary";
import type { ReviewNote } from "./types";

// Expected values come from the plan's list-shape rule (task note "Embed Hunk as a panel
// inside Pi", step 3): every `comment list` mode returns one record shape, keeping each mode's
// existing fields (`commentId`, `side`, `line`, `summary`, `rationale` from the live list;
// `noteId`, `source`, ranges, `body`, `title`, `updatedAt`, `editable` from the note list)
// and adding the stored note's `resolution`.

describe("projectReviewNoteSummary", () => {
  // Passes when one agent note carries every field of both former list shapes, with `body`
  // joining summary and rationale the way the note list always did.
  test("reports one note with the fields of both list shapes", () => {
    const note: ReviewNote = {
      id: "mcp:1",
      parentId: "user:1",
      source: "agent",
      originalSource: "mcp",
      fileKey: "alpha",
      anchor: {
        newRange: [12, 12],
        preferred: { side: "new", line: 12 },
        intersectingHunkIndices: [1],
        ownerHunkIndex: 1,
      },
      summary: "Check this",
      rationale: "Because",
      title: "Title",
      author: "Pi",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      editable: false,
      tags: ["mcp"],
      confidence: "high",
    };

    expect(projectReviewNoteSummary(note, "alpha.ts", "stale")).toEqual({
      noteId: "mcp:1",
      parentId: "user:1",
      source: "agent",
      filePath: "alpha.ts",
      hunkIndex: 1,
      side: "new",
      line: 12,
      newRange: [12, 12],
      summary: "Check this",
      rationale: "Because",
      title: "Title",
      author: "Pi",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      editable: false,
      resolution: "stale",
    });
  });
});

describe("reviewNoteListRecord", () => {
  // Passes when the list record adds `commentId` equal to `noteId`, the joined `body`, and an
  // explicit `active` for a snapshot note that carries no resolution, and keeps every other field.
  test("adds the derived list fields to a snapshot note", () => {
    const summary = projectReviewNoteSummary(
      {
        id: "user:1",
        source: "user",
        fileKey: "alpha",
        anchor: { oldRange: [2, 3], intersectingHunkIndices: [0], ownerHunkIndex: 0 },
        summary: "Mine",
        rationale: "Why",
        editable: true,
      },
      "alpha.ts",
      "active",
    );

    expect(summary).not.toHaveProperty("resolution");
    expect(reviewNoteListRecord(summary)).toEqual({
      ...summary,
      commentId: "user:1",
      body: "Mine\n\nWhy",
      resolution: "active",
    });
    expect(reviewNoteListRecord({ ...summary, resolution: "stale" }).resolution).toBe("stale");
  });
});
