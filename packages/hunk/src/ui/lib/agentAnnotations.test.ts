import { describe, expect, test } from "bun:test";
import { reviewAnnotatedHunkIndices } from "../../core/review/annotations";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { projectReviewDocument } from "../../core/review/document";
import { planReviewIntent } from "../../core/review/intents";
import { createInitialReviewState } from "../../core/review/state";
import { storedNoteToLiveComment } from "./reviewNoteMapping";
import { annotationRangeLabel, getSelectedAnnotations, inlineNoteTitle } from "./agentAnnotations";

function createContextHeavyHunkFile() {
  const beforeLines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`);
  const afterLines = [...beforeLines.slice(0, 12), "INSERTED", ...beforeLines.slice(12)];

  return createTestDiffFile({
    before: lines(...beforeLines),
    after: lines(...afterLines),
    context: 100,
    id: "file:context-heavy-annotation",
    path: "src/sparse.ts",
    previousPath: "src/sparse.ts",
  });
}

describe("agent annotations", () => {
  test("formats inline note titles without depending on the pane component", () => {
    expect(inlineNoteTitle({ summary: "Draft", source: "user-draft" }, 0, 1)).toBe("Draft note");
    expect(inlineNoteTitle({ summary: "Mine", source: "user" }, 0, 1)).toBe("Your note");
    expect(
      inlineNoteTitle({ summary: "Agent", source: "agent", author: " Pi\rspoof " }, 1, 3),
    ).toBe("Pispoof note 2/3");
  });

  test("formats inline note locations with GitHub-style file and side anchors", () => {
    const file = createContextHeavyHunkFile();

    expect(annotationRangeLabel({ summary: "Added", newRange: [142, 142] }, file)).toBe(
      "src/sparse.ts R142",
    );
    expect(annotationRangeLabel({ summary: "Removed", oldRange: [88, 91] }, file)).toBe(
      "src/sparse.ts L88–L91",
    );
    expect(
      annotationRangeLabel({ summary: "Changed", oldRange: [10, 11], newRange: [20, 21] }, file),
    ).toBe("src/sparse.ts L10–L11 → R20–R21");
  });

  // Regression: a hunk-number comment lands on the first changed row, past the leading
  // context. Passes when the note planned for hunk 0 hangs at new line 13 and the rendered
  // comment still marks hunk 0 as annotated and shows in it.
  test("keeps hunk-number comments visible when anchored after leading context", () => {
    const file = createContextHeavyHunkFile();
    const hunk = file.metadata.hunks[0]!;
    const document = projectReviewDocument([file]);

    const plan = planReviewIntent(
      createInitialReviewState(document),
      {
        type: "notes/create",
        fileKey: document.files[0]!.key,
        target: { hunkIndex: 0 },
        body: {
          summary: "Explain inserted line",
          rationale: "The daemon resolves hunk-number comments to the first change row.",
        },
      },
      {
        noteId: "comment-1",
        timestamp: "2026-03-22T00:00:00.000Z",
        authorship: { source: "agent", channel: "session-cli" },
      },
    );
    if (plan.outcome?.type !== "notes/created") throw new Error("comment not created");
    const comment = storedNoteToLiveComment(plan.outcome.note.note, file.path);

    expect(comment).toMatchObject({ hunkIndex: 0, side: "new", line: 13 });
    expect(hunk.additionLines).toBe(1);
    expect(hunk.additionCount).toBeGreaterThan(comment.line - hunk.additionStart + 1);

    const annotatedFile = {
      ...file,
      agent: {
        path: file.path,
        annotations: [comment],
      },
    };

    expect([...reviewAnnotatedHunkIndices(annotatedFile)]).toEqual([0]);
    expect(getSelectedAnnotations(annotatedFile, hunk)).toEqual([comment]);
  });
});
