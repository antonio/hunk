/**
 * The note-write corpus: every writer produces the same note for the same write.
 *
 * Agent comments used to be built and anchored outside the planner while reviewer notes
 * went through core's composer intents, so the two could disagree about placement, reply
 * rules, size, and provenance (`docs/browser-review-seam-audit.md`, D6). Each fixture states
 * one write and the note it must produce; the expectations follow the test helper's
 * geometry, where hunk `i` covers lines `10i+1`–`10i+3` on both sides and changes line `10i+2`.
 */
import { createTestReviewState, createTestStoredNote } from "../helpers/review-store-helpers";
import type {
  ConformanceNoteWriteChannel,
  ConformanceNoteWriter,
  ReviewNoteWriteFixture,
} from "./types";

/** Name the channel a fixture's writer writes on. */
export function conformanceNoteWriteChannel(
  writer: ConformanceNoteWriter,
): ConformanceNoteWriteChannel {
  return writer === "reviewer" ? "reviewer" : writer.channel;
}

export const REVIEW_NOTE_WRITE_FIXTURES: readonly ReviewNoteWriteFixture[] = [
  {
    id: "agent-hunk-comment",
    findings: ["D6"],
    description:
      "an agent's hunk-number comment is an agent note, labelled by its author, on the hunk's changed line",
    build: () => createTestReviewState(["alpha", "beta"]),
    writer: { source: "agent", channel: "session-cli", label: "Pi" },
    placement: { file: 0, hunkIndex: 1 },
    summary: "Check the second hunk",
    expected: {
      source: "agent",
      originalSource: "mcp",
      author: "Pi",
      editable: false,
      file: 0,
      resolution: "active",
      newRange: [12, 12],
      preferred: { side: "new", line: 12 },
      intersectingHunkIndices: [1],
      ownerHunkIndex: 1,
    },
  },
  {
    id: "reviewer-line-note",
    findings: ["D6"],
    description: "a reviewer's note on an old-side line is an editable reviewer note there",
    build: () => createTestReviewState(["alpha", "beta"]),
    writer: "reviewer",
    placement: { file: 1, line: { side: "old", line: 2 } },
    summary: "This removal needs a test",
    expected: {
      source: "user",
      originalSource: "user",
      author: "user",
      editable: true,
      file: 1,
      resolution: "active",
      oldRange: [2, 2],
      preferred: { side: "old", line: 2 },
      intersectingHunkIndices: [0],
      ownerHunkIndex: 0,
    },
  },
  {
    id: "agent-reply-to-stale-reviewer-note",
    findings: ["D6"],
    description:
      "an agent's reply inherits a reviewer note's anchor and stale verdict and stays the agent's",
    build: () => ({
      ...createTestReviewState(["alpha", "beta"]),
      userNotes: [
        createTestStoredNote({
          id: "user:parent",
          fileKey: "alpha",
          hunkIndex: 1,
          line: 12,
          source: "user",
          editable: true,
          resolution: "stale",
        }),
      ],
    }),
    writer: { source: "agent", channel: "session-cli" },
    placement: { parentId: "user:parent" },
    summary: "Still applies after the edit",
    expected: {
      source: "agent",
      originalSource: "mcp",
      editable: false,
      file: 0,
      parentId: "user:parent",
      resolution: "stale",
      newRange: [12, 12],
      preferred: { side: "new", line: 12 },
      intersectingHunkIndices: [1],
      ownerHunkIndex: 1,
    },
  },
  {
    id: "reviewer-reply-to-agent-note",
    findings: ["D6"],
    description: "a reviewer's reply under an agent note is the reviewer's, on the agent's anchor",
    build: () => ({
      ...createTestReviewState(["alpha", "beta"]),
      liveNotes: [createTestStoredNote({ id: "mcp:parent", fileKey: "beta", line: 2 })],
    }),
    writer: "reviewer",
    placement: { parentId: "mcp:parent" },
    summary: "Agreed, fixing",
    expected: {
      source: "user",
      originalSource: "user",
      author: "user",
      editable: true,
      file: 1,
      parentId: "mcp:parent",
      resolution: "active",
      newRange: [2, 2],
      preferred: { side: "new", line: 2 },
      intersectingHunkIndices: [0],
      ownerHunkIndex: 0,
    },
  },
  {
    id: "extension-reviewer-note",
    findings: ["D6"],
    description:
      "an extension writing for the reviewer makes an editable reviewer note, recorded as an extension's",
    build: () => createTestReviewState(["alpha", "beta"]),
    writer: { source: "user", channel: "extension" },
    placement: { file: 1, hunkIndex: 0 },
    summary: "Checked by the extension",
    expected: {
      source: "user",
      originalSource: "extension",
      author: "user",
      editable: true,
      file: 1,
      resolution: "active",
      newRange: [2, 2],
      preferred: { side: "new", line: 2 },
      intersectingHunkIndices: [0],
      ownerHunkIndex: 0,
    },
  },
  {
    id: "extension-agent-reply",
    findings: ["D6"],
    description:
      "an extension writing as an agent replies under a reviewer note with its own label, not editable by the reviewer",
    build: () => ({
      ...createTestReviewState(["alpha", "beta"]),
      userNotes: [
        createTestStoredNote({
          id: "user:parent",
          fileKey: "alpha",
          hunkIndex: 1,
          line: 12,
          source: "user",
          editable: true,
        }),
      ],
    }),
    writer: { source: "agent", channel: "extension", label: "Linter" },
    placement: { parentId: "user:parent" },
    summary: "Lint agrees",
    expected: {
      source: "agent",
      originalSource: "extension",
      author: "Linter",
      editable: false,
      file: 0,
      parentId: "user:parent",
      resolution: "active",
      newRange: [12, 12],
      preferred: { side: "new", line: 12 },
      intersectingHunkIndices: [1],
      ownerHunkIndex: 1,
    },
  },
];
