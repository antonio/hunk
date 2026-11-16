import { describe, expect, test } from "bun:test";
import type { ExtensionReviewSelection } from "../../../packages/hunk/src/extension-api/types";
import { selectionNoteRequest } from "./index";

/** Build the selection facts the request reads; everything else is irrelevant here. */
function createTestSelection(
  overrides: Partial<Pick<ExtensionReviewSelection, "file" | "hunkIndex">>,
): ExtensionReviewSelection {
  return {
    file: { path: "src/app.ts" } as ExtensionReviewSelection["file"],
    hunkIndex: 1,
    currentLine: null,
    files: [],
    layout: "unified",
    ...overrides,
  } as ExtensionReviewSelection;
}

describe("selection note example", () => {
  // Passes when the request names the selected file and hunk and writes for the user.
  test("writes a reviewer note on the selected hunk", () => {
    expect(selectionNoteRequest(createTestSelection({}), "Check this")).toEqual({
      filePath: "src/app.ts",
      hunkIndex: 1,
      body: { summary: "Check this" },
      as: "user",
    });
  });

  // Passes when there is nothing to anchor the note to.
  test("asks for a selection when no hunk is selected", () => {
    expect(selectionNoteRequest(createTestSelection({ hunkIndex: null }), "x")).toBeNull();
    expect(selectionNoteRequest(createTestSelection({ file: null }), "x")).toBeNull();
  });
});
