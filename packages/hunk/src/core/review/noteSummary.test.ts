import { describe, expect, test } from "bun:test";
import {
  createTestReviewState,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import { projectReviewNoteSummary, selectReviewNoteSummaries } from "./noteSummary";
import { reduceReviewState } from "./reducer";
import type { ReviewNoteV1 } from "./types";

// Expected values come from the plan's list-shape rule (task note "Embed Hunk as a panel
// inside Pi", step 3): every `comment list` mode returns one record shape, keeping each mode's
// existing fields (`commentId`, `side`, `line`, `summary`, `rationale` from the live list;
// `noteId`, `source`, ranges, `body`, `title`, `updatedAt`, `editable` from the note list)
// and adding the step-1 `resolution`.

describe("projectReviewNoteSummary", () => {
  // Passes when one agent note carries every field of both former list shapes, with `body`
  // joining summary and rationale the way the note list always did.
  test("reports one note with the fields of both list shapes", () => {
    const note: ReviewNoteV1 = {
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
      commentId: "mcp:1",
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
      body: "Check this\n\nBecause",
      title: "Title",
      author: "Pi",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      editable: false,
      resolution: "stale",
    });
  });
});

describe("selectReviewNoteSummaries", () => {
  // Passes when stored notes are listed per review file in document order, replies under their
  // parent, and a note whose file left the review is listed last as orphaned under the path it
  // was written on.
  test("lists notes by file in thread order and keeps orphaned notes with their path", () => {
    const written = reduceReviewState(
      reduceReviewState(createTestReviewState(["alpha", "beta"]), {
        type: "notes/add-live",
        notes: [
          createTestStoredNote({ id: "mcp:beta", fileKey: "beta" }),
          createTestStoredNote({ id: "mcp:alpha", fileKey: "alpha" }),
        ],
      }),
      {
        type: "notes/add-user",
        note: createTestStoredNote({
          id: "user:reply",
          fileKey: "beta",
          source: "user",
          parentId: "mcp:beta",
          editable: true,
        }),
      },
    );
    const reloaded = reduceReviewState(written, {
      type: "document/reconcile",
      document: createTestReviewState(["alpha"]).document,
    });

    expect(
      selectReviewNoteSummaries(reloaded).map(({ fileKey, summary }) => [
        fileKey,
        summary.noteId,
        summary.filePath,
        summary.resolution,
      ]),
    ).toEqual([
      ["alpha", "mcp:alpha", "alpha.ts", "active"],
      ["beta", "mcp:beta", "beta.ts", "orphaned"],
      ["beta", "user:reply", "beta.ts", "orphaned"],
    ]);
  });
});
