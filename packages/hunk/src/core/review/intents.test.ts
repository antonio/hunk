import { describe, expect, test } from "bun:test";
import {
  createTestReviewDocument,
  createTestReviewHunk,
  createTestReviewState,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import {
  applyReviewIntent,
  isBlankReviewNoteBody,
  planReviewIntent,
  planReviewIntentBatch,
  ReviewIntentPlanningError,
  type ReviewIntent,
  type ReviewIntentFacts,
  type ReviewIntentPlanningErrorCode,
} from "./intents";
import { MAX_REVIEW_NOTE_BYTES } from "./noteSize";
import type { ReviewNoteBodyV1 } from "./types";
import { reduceReviewState } from "./reducer";
import type { ReviewState } from "./state";
import { createReviewStore } from "./store";

/** The authorship the terminal composer supplies for every reviewer write. */
const TERMINAL = { source: "user", channel: "terminal" } as const;

/** The authorship the agent session commands supply, with the agent's `--author` label. */
const SESSION_CLI = { source: "agent", channel: "session-cli", label: "Pi" } as const;

const FACTS = { noteId: "user:1", timestamp: "2024-01-01T00:00:00.000Z", authorship: TERMINAL };

/** Assert that planning throws a typed rejection with one code, and optionally one message. */
function expectPlanningRejection(
  plan: () => unknown,
  code: ReviewIntentPlanningErrorCode,
  message?: string,
) {
  let error: unknown;
  try {
    plan();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ReviewIntentPlanningError);
  expect((error as ReviewIntentPlanningError).code).toBe(code);
  if (message !== undefined) expect((error as Error).message).toBe(message);
}

/** Start a draft at the given body so note creation has something to consume. */
function stateWithDraft(body: string): ReviewState {
  return reduceReviewState(createTestReviewState(), {
    type: "draft/start",
    draft: {
      id: "draft-1",
      fileKey: "alpha",
      hunkIndex: 1,
      side: "new",
      line: 12,
      body,
    },
  });
}

describe("isBlankReviewNoteBody", () => {
  test("treats whitespace-only bodies as blank", () => {
    expect(isBlankReviewNoteBody("")).toBe(true);
    expect(isBlankReviewNoteBody("  \n\t ")).toBe(true);
    expect(isBlankReviewNoteBody(" text ")).toBe(false);
  });
});

describe("selection intent", () => {
  test("lowers to one selection action carrying the reveal request", () => {
    expect(
      planReviewIntent(createTestReviewState(), {
        type: "selection/select",
        fileKey: "beta",
        hunkIndex: 1,
        reveal: { anchor: "file-top", scrollToNote: true },
      }).actions,
    ).toEqual([
      {
        type: "selection/select",
        fileKey: "beta",
        hunkIndex: 1,
        reveal: { anchor: "file-top", scrollToNote: true },
      },
    ]);
  });

  test("rejects a file the review does not contain", () => {
    expect(() =>
      planReviewIntent(createTestReviewState(), {
        type: "selection/select",
        fileKey: "missing",
        hunkIndex: 0,
        reveal: { anchor: "hunk", scrollToNote: false },
      }),
    ).toThrow(ReviewIntentPlanningError);
  });
});

describe("selection movement intent", () => {
  const annotations = {
    annotatedHunkIndicesByFileKey: new Map([["beta", new Set([1])]]),
    annotatedFileKeys: new Set(["beta"]),
  };

  test("plans a move over the visible stream and reports where it landed", () => {
    const state = { ...createTestReviewState(), selection: { fileKey: "alpha", hunkIndex: 1 } };

    expect(planReviewIntent(state, { type: "selection/move", scope: "hunk", delta: 1 })).toEqual({
      actions: [
        {
          type: "selection/select",
          fileKey: "beta",
          hunkIndex: 0,
          reveal: { anchor: "file-top", scrollToNote: false },
        },
      ],
      outcome: { type: "selection/changed", fileKey: "beta", hunkIndex: 0 },
    });
  });

  test("publishes nothing when the scope refuses the move", () => {
    const state = { ...createTestReviewState(), selection: { fileKey: "beta", hunkIndex: 1 } };

    expect(planReviewIntent(state, { type: "selection/move", scope: "file", delta: 1 })).toEqual({
      actions: [],
    });
  });

  test("navigates only what the filter leaves visible", () => {
    const state = {
      ...createTestReviewState(),
      filter: "alpha",
      selection: { fileKey: "alpha", hunkIndex: 1 },
    };

    // Beta is filtered out, so the stream ends at alpha's last hunk.
    expect(planReviewIntent(state, { type: "selection/move", scope: "hunk", delta: 1 })).toEqual({
      actions: [
        {
          type: "selection/select",
          fileKey: "alpha",
          hunkIndex: 1,
          reveal: { anchor: "hunk", scrollToNote: false },
        },
      ],
      outcome: { type: "selection/changed", fileKey: "alpha", hunkIndex: 1 },
    });
  });

  test("moves between exact visible stored notes and carries the active identity atomically", () => {
    const state = {
      ...createTestReviewState(undefined, { showAgentNotes: true }),
      liveNotes: [
        createTestStoredNote({ id: "later", fileKey: "alpha", hunkIndex: 0, line: 8 }),
        createTestStoredNote({ id: "next-file", fileKey: "beta", hunkIndex: 1, line: 21 }),
        createTestStoredNote({ id: "earlier", fileKey: "alpha", hunkIndex: 0, line: 2 }),
      ],
    };

    expect(planReviewIntent(state, { type: "selection/move", scope: "note", delta: 1 })).toEqual({
      actions: [
        {
          type: "selection/select",
          fileKey: "alpha",
          hunkIndex: 0,
          activeNoteId: "earlier",
          reveal: { anchor: "hunk", scrollToNote: true },
        },
      ],
      outcome: { type: "selection/changed", fileKey: "alpha", hunkIndex: 0 },
    });

    const activeLater = { ...state, activeNoteId: "later" };
    expect(
      planReviewIntent(activeLater, { type: "selection/move", scope: "note", delta: 1 }).actions[0],
    ).toMatchObject({ fileKey: "beta", hunkIndex: 1, activeNoteId: "next-file" });
    expect(
      planReviewIntent(
        { ...activeLater, filter: "alpha" },
        { type: "selection/move", scope: "note", delta: 1 },
      ),
    ).toEqual({ actions: [] });
  });

  test("selects one exact visible note and rejects a mismatched location", () => {
    const state = {
      ...createTestReviewState(undefined, { showAgentNotes: true }),
      liveNotes: [createTestStoredNote({ id: "target", fileKey: "alpha", hunkIndex: 0 })],
    };
    const reveal = { anchor: "none" as const, scrollToNote: false };

    expect(
      planReviewIntent(state, {
        type: "selection/select",
        fileKey: "alpha",
        hunkIndex: 0,
        activeNoteId: "target",
        reveal,
      }).actions,
    ).toEqual([
      {
        type: "selection/select",
        fileKey: "alpha",
        hunkIndex: 0,
        activeNoteId: "target",
        reveal,
      },
    ]);
    expect(() =>
      planReviewIntent(state, {
        type: "selection/select",
        fileKey: "beta",
        hunkIndex: 0,
        activeNoteId: "target",
        reveal,
      }),
    ).toThrow(ReviewIntentPlanningError);
  });

  test("requires the annotation index for annotated navigation", () => {
    const state = createTestReviewState();

    expect(() =>
      planReviewIntent(state, { type: "selection/move", scope: "annotated-hunk", delta: 1 }),
    ).toThrow(ReviewIntentPlanningError);
    expect(
      planReviewIntent(
        state,
        { type: "selection/move", scope: "annotated-hunk", delta: 1 },
        { annotations },
      ).actions,
    ).toEqual([
      {
        type: "selection/select",
        fileKey: "beta",
        hunkIndex: 1,
        reveal: { anchor: "hunk", scrollToNote: true },
      },
    ]);
  });
});

describe("file jump intent", () => {
  test("lands on the file's first hunk and reveals its header by default", () => {
    expect(
      planReviewIntent(createTestReviewState(), {
        type: "selection/select-file",
        fileKey: "beta",
      }),
    ).toEqual({
      actions: [
        {
          type: "selection/select",
          fileKey: "beta",
          hunkIndex: 0,
          reveal: { anchor: "file-top", scrollToNote: false },
        },
      ],
      outcome: { type: "selection/changed", fileKey: "beta", hunkIndex: 0 },
    });
  });

  test("accepts a caller's own reveal request", () => {
    expect(
      planReviewIntent(createTestReviewState(), {
        type: "selection/select-file",
        fileKey: "beta",
        reveal: { anchor: "hunk", scrollToNote: false },
      }).actions[0],
    ).toEqual({
      type: "selection/select",
      fileKey: "beta",
      hunkIndex: 0,
      reveal: { anchor: "hunk", scrollToNote: false },
    });
  });

  test("rejects a file the review does not contain", () => {
    expect(() =>
      planReviewIntent(createTestReviewState(), {
        type: "selection/select-file",
        fileKey: "missing",
      }),
    ).toThrow(ReviewIntentPlanningError);
  });
});

describe("viewport anchor intent", () => {
  // Intent: a viewport reporting where it settled must not scroll anybody, including itself.
  test("moves the selection without bumping a reveal counter", () => {
    const state = createTestReviewState();
    const plan = planReviewIntent(state, {
      type: "selection/anchor",
      fileKey: "beta",
      hunkIndex: 1,
    });

    expect(plan).toEqual({
      actions: [
        {
          type: "selection/select",
          fileKey: "beta",
          hunkIndex: 1,
          reveal: { anchor: "none", scrollToNote: false },
        },
      ],
    });

    const next = plan.actions.reduce(reduceReviewState, state);
    expect(next.selection).toEqual({ fileKey: "beta", hunkIndex: 1 });
    expect(next.reveal).toEqual({ fileTopToken: 0, hunkToken: 0, scrollToNote: false });
  });

  test("preserves exact note focus when the viewport reports the same hunk", () => {
    const state = {
      ...createTestReviewState(),
      activeNoteId: "note-2",
      selection: { fileKey: "alpha", hunkIndex: 1 },
    };

    expect(
      planReviewIntent(state, {
        type: "selection/anchor",
        fileKey: "alpha",
        hunkIndex: 1,
      }).actions[0],
    ).toMatchObject({ activeNoteId: "note-2" });
  });
});

describe("user note creation", () => {
  test("anchors the note to the draft's line and hunk", () => {
    const plan = planReviewIntent(
      stateWithDraft("  looks wrong  "),
      {
        type: "notes/create-user",
        consumeDraft: true,
      },
      FACTS,
    );

    expect(plan.outcome).toEqual({
      type: "notes/created",
      note: {
        note: {
          id: "user:1",
          source: "user",
          originalSource: "user",
          fileKey: "alpha",
          anchor: {
            newRange: [12, 12],
            preferred: { side: "new", line: 12 },
            intersectingHunkIndices: [1],
            ownerHunkIndex: 1,
          },
          summary: "looks wrong",
          author: "user",
          createdAt: FACTS.timestamp,
          editable: true,
        },
        resolution: "active",
      },
    });
    expect(plan.actions.map((action) => action.type)).toEqual(["draft/save"]);
  });

  test("retires a blank draft instead of persisting an empty note", () => {
    const plan = planReviewIntent(
      stateWithDraft("   "),
      { type: "notes/create-user", consumeDraft: true },
      FACTS,
    );

    expect(plan.actions).toEqual([{ type: "draft/cancel" }]);
    expect(plan.outcome).toBeUndefined();
  });

  test("rejects creation without a draft or without caller-owned facts", () => {
    expect(() =>
      planReviewIntent(
        createTestReviewState(),
        { type: "notes/create-user", consumeDraft: true },
        FACTS,
      ),
    ).toThrow(new ReviewIntentPlanningError("draft-missing", "No user note draft is active."));
    expect(() =>
      planReviewIntent(stateWithDraft("body"), { type: "notes/create-user", consumeDraft: true }),
    ).toThrow(ReviewIntentPlanningError);
  });

  // Source: the authorship rule — the composer holds the reviewer's words. Passes when a save
  // attributed to an agent is refused and the draft is not consumed.
  test("refuses to save the composer's draft as an agent note", () => {
    expectPlanningRejection(
      () =>
        planReviewIntent(
          stateWithDraft("body"),
          { type: "notes/create-user", consumeDraft: true },
          { ...FACTS, authorship: SESSION_CLI },
        ),
      "invalid-request",
      "The note composer saves reviewer notes only.",
    );
  });

  test("rejects saving after reconciliation changes the draft file's content", () => {
    const reloaded = reduceReviewState(stateWithDraft("body"), {
      type: "document/reconcile",
      document: createTestReviewDocument([
        { key: "alpha", contentIdentity: "content:alpha:changed" },
        { key: "beta" },
      ]),
    });

    expect(reloaded.draftNote).toBeNull();
    expect(() =>
      planReviewIntent(reloaded, { type: "notes/create-user", consumeDraft: true }, FACTS),
    ).toThrow(new ReviewIntentPlanningError("draft-missing", "No user note draft is active."));
  });

  test("rejects a draft anchored to a hunk the file no longer has", () => {
    const reloaded = reduceReviewState(stateWithDraft("body"), {
      type: "document/reconcile",
      document: createTestReviewDocument([{ key: "alpha", hunkCount: 1 }, { key: "beta" }]),
    });

    expect(() =>
      planReviewIntent(reloaded, { type: "notes/create-user", consumeDraft: true }, FACTS),
    ).toThrow(ReviewIntentPlanningError);
  });
});

describe("user note editing", () => {
  test("prefills an edit draft and replaces the saved note without changing its identity", () => {
    const original = createTestStoredNote({
      id: "user-1",
      fileKey: "alpha",
      source: "user",
      summary: "before",
      editable: true,
      createdAt: "2023-01-01T00:00:00.000Z",
    });
    const state = { ...createTestReviewState(), userNotes: [original] };
    const started = planReviewIntent(
      state,
      { type: "notes/start-edit", noteId: "user-1" },
      { draftId: "draft:edit" },
    );
    const withDraft = started.actions.reduce(reduceReviewState, state);

    expect(withDraft.draftNote).toMatchObject({
      kind: "edit",
      targetNoteId: "user-1",
      body: "before",
    });
    const edited = planReviewIntent(withDraft, {
      type: "notes/update-draft",
      body: "  after  ",
    }).actions.reduce(reduceReviewState, withDraft);
    const saved = planReviewIntent(
      edited,
      { type: "notes/update-user", noteId: "user-1", consumeDraft: true },
      { timestamp: FACTS.timestamp, authorship: TERMINAL },
    );
    const next = saved.actions.reduce(reduceReviewState, edited);

    expect(saved.outcome).toMatchObject({ type: "notes/updated" });
    expect(next.draftNote).toBeNull();
    expect(next.userNotes).toHaveLength(1);
    expect(next.userNotes[0]?.note).toMatchObject({
      id: "user-1",
      summary: "after",
      createdAt: "2023-01-01T00:00:00.000Z",
      updatedAt: FACTS.timestamp,
    });
    expect(next.userNotes[0]?.note.anchor).toEqual(original.note.anchor);
  });

  test("preserves a multiline anchor and preferred endpoint through editing", () => {
    const original = createTestStoredNote({
      id: "user-range",
      fileKey: "alpha",
      source: "user",
      editable: true,
    });
    original.note.anchor = {
      oldRange: [1, 2],
      newRange: [11, 12],
      preferred: { side: "new", line: 12 },
      intersectingHunkIndices: [0, 1],
      ownerHunkIndex: 1,
    };
    const state = { ...createTestReviewState(), userNotes: [original] };
    const started = planReviewIntent(
      state,
      { type: "notes/start-edit", noteId: original.note.id },
      { draftId: "draft:range-edit" },
    ).actions.reduce(reduceReviewState, state);

    expect(started.draftNote).toMatchObject({
      targetKind: "range",
      hunkIndex: 1,
      side: "new",
      line: 12,
      anchor: original.note.anchor,
    });
    const written = reduceReviewState(started, { type: "draft/update", body: "edited range" });
    const saved = planReviewIntent(
      written,
      { type: "notes/update-user", noteId: original.note.id, consumeDraft: true },
      { timestamp: FACTS.timestamp, authorship: TERMINAL },
    ).actions.reduce(reduceReviewState, written);

    expect(saved.userNotes[0]?.note.anchor).toEqual(original.note.anchor);
  });

  test("reopens retained notes after reload clamps away their former hunk", () => {
    const original = createTestStoredNote({
      id: "user-1",
      fileKey: "alpha",
      hunkIndex: 1,
      source: "user",
      editable: true,
    });
    const state = {
      ...createTestReviewState([{ key: "alpha", hunkCount: 1 }]),
      userNotes: [original],
    };

    const plan = planReviewIntent(
      state,
      { type: "notes/start-edit", noteId: "user-1" },
      { draftId: "draft:edit" },
    );

    expect(plan.outcome).toMatchObject({
      type: "notes/draft-started",
      draft: { kind: "edit", targetNoteId: "user-1", hunkIndex: 0 },
    });
  });

  test("rejects blank edits without retiring the draft", () => {
    const state = {
      ...createTestReviewState(),
      userNotes: [
        createTestStoredNote({
          id: "user-1",
          fileKey: "alpha",
          source: "user",
          editable: true,
        }),
      ],
    };
    const started = planReviewIntent(
      state,
      { type: "notes/start-edit", noteId: "user-1" },
      { draftId: "draft:edit" },
    ).actions.reduce(reduceReviewState, state);
    const blank = reduceReviewState(started, { type: "draft/update", body: "  " });

    expect(() =>
      planReviewIntent(
        blank,
        { type: "notes/update-user", noteId: "user-1", consumeDraft: true },
        { timestamp: FACTS.timestamp, authorship: TERMINAL },
      ),
    ).toThrow(ReviewIntentPlanningError);
    expect(blank.draftNote).not.toBeNull();
  });
});

describe("threaded replies", () => {
  test("copies the parent's anchor and records its direct identity", () => {
    const parent = createTestStoredNote({ id: "live-1", fileKey: "alpha", hunkIndex: 1, line: 12 });
    const state = { ...createTestReviewState(), liveNotes: [parent] };
    const started = planReviewIntent(
      state,
      { type: "notes/start-reply", noteId: "live-1" },
      { draftId: "draft:reply" },
    ).actions.reduce(reduceReviewState, state);
    const written = planReviewIntent(started, {
      type: "notes/update-draft",
      body: "reply body",
    }).actions.reduce(reduceReviewState, started);
    const plan = planReviewIntent(
      written,
      { type: "notes/create-user", consumeDraft: true },
      FACTS,
    );

    expect(plan.outcome).toMatchObject({
      type: "notes/created",
      note: { note: { id: "user:1", parentId: "live-1", summary: "reply body" } },
    });
    expect(
      plan.outcome?.type === "notes/created" ? plan.outcome.note.note.anchor : undefined,
    ).toEqual(parent.note.anchor);
  });

  test("preserves a multiline parent anchor through a nested reply", () => {
    const parent = createTestStoredNote({ id: "live-range", fileKey: "alpha" });
    parent.note.anchor = {
      oldRange: [1, 2],
      newRange: [11, 12],
      preferred: { side: "new", line: 12 },
      intersectingHunkIndices: [0, 1],
      ownerHunkIndex: 1,
    };
    const state = { ...createTestReviewState(), liveNotes: [parent] };
    const started = planReviewIntent(
      state,
      { type: "notes/start-reply", noteId: parent.note.id },
      { draftId: "draft:range-reply" },
    ).actions.reduce(reduceReviewState, state);

    expect(started.draftNote).toMatchObject({
      targetKind: "range",
      hunkIndex: 1,
      side: "new",
      line: 12,
      anchor: parent.note.anchor,
    });
    const written = reduceReviewState(started, { type: "draft/update", body: "range reply" });
    const saved = planReviewIntent(
      written,
      { type: "notes/create-user", consumeDraft: true },
      FACTS,
    );

    expect(saved.outcome).toMatchObject({
      type: "notes/created",
      note: { note: { parentId: parent.note.id, anchor: parent.note.anchor } },
    });
  });
});

describe("note removal", () => {
  test("removes from the collection that owns the note", () => {
    const state = reduceReviewState(createTestReviewState(), {
      type: "notes/add-live",
      notes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })],
    });

    expect(planReviewIntent(state, { type: "notes/remove-live", noteId: "live-1" })).toEqual({
      actions: [{ type: "notes/remove-live", noteId: "live-1" }],
      outcome: { type: "notes/removed", noteId: "live-1", source: "live" },
    });
    expect(() => planReviewIntent(state, { type: "notes/remove-user", noteId: "live-1" })).toThrow(
      ReviewIntentPlanningError,
    );
  });

  test("blocks removing a parent while replies still reference it", () => {
    const state = {
      ...createTestReviewState(),
      liveNotes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })],
      userNotes: [
        createTestStoredNote({
          id: "reply-1",
          parentId: "live-1",
          fileKey: "alpha",
          source: "user",
        }),
      ],
    };

    expect(() => planReviewIntent(state, { type: "notes/remove-live", noteId: "live-1" })).toThrow(
      new ReviewIntentPlanningError(
        "note-has-replies",
        "Review note live-1 cannot be removed while it has replies.",
      ),
    );
  });
});

describe("bulk clear", () => {
  test("reports removed and remaining counts for one file", () => {
    const state = reduceReviewState(createTestReviewState(), {
      type: "notes/add-live",
      notes: [
        createTestStoredNote({ id: "live-1", fileKey: "alpha" }),
        createTestStoredNote({ id: "live-2", fileKey: "beta" }),
      ],
    });

    expect(planReviewIntent(state, { type: "notes/clear", fileKey: "alpha" }).outcome).toEqual({
      type: "notes/cleared",
      removedLiveCount: 1,
      removedUserCount: 0,
      remainingLiveCount: 1,
      remainingUserCount: 0,
    });
  });

  test("rejects clearing a live parent while retaining its user reply", () => {
    const state = {
      ...createTestReviewState(),
      liveNotes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })],
      userNotes: [
        createTestStoredNote({
          id: "reply-1",
          parentId: "live-1",
          fileKey: "alpha",
          source: "user",
        }),
      ],
    };

    expect(() => planReviewIntent(state, { type: "notes/clear" })).toThrow(
      new ReviewIntentPlanningError(
        "note-has-replies",
        "Review notes cannot be cleared while replies to them would remain.",
      ),
    );
    expect(
      planReviewIntent(state, { type: "notes/clear", includeUser: true }).outcome,
    ).toMatchObject({ removedLiveCount: 1, removedUserCount: 1 });
  });

  test("counts user notes only when the caller clears them too", () => {
    const withDraft = reduceReviewState(createTestReviewState(), {
      type: "draft/start",
      draft: { id: "d", fileKey: "alpha", hunkIndex: 0, side: "new", line: 1, body: "x" },
    });
    const state = reduceReviewState(withDraft, {
      type: "draft/save",
      note: createTestStoredNote({ id: "user-1", fileKey: "alpha", source: "user" }),
    });

    expect(planReviewIntent(state, { type: "notes/clear" }).outcome).toMatchObject({
      removedUserCount: 0,
      remainingUserCount: 1,
    });
    expect(
      planReviewIntent(state, { type: "notes/clear", includeUser: true }).outcome,
    ).toMatchObject({
      removedUserCount: 1,
      remainingUserCount: 0,
    });
  });
});

describe("draftless note creation", () => {
  const AGENT_FACTS = {
    noteId: "mcp:1",
    timestamp: "2024-02-02T00:00:00.000Z",
    authorship: SESSION_CLI,
  };

  /** Plan one `notes/create` and return the stored note it reports. */
  function created(state: ReviewState, intent: ReviewIntent, facts: ReviewIntentFacts) {
    const plan = planReviewIntent(state, intent, facts);
    if (plan.outcome?.type !== "notes/created") throw new Error("note not created");
    return { plan, entry: plan.outcome.note };
  }

  // Source: the authorship rule (session commands write agent notes) and the record agent
  // comments have always stored. Passes when the note lands in the agent collection with
  // `mcp` provenance, the agent's label, and a single-line anchor in hunk 1.
  test("writes an agent note at one line from the session channel", () => {
    const { plan, entry } = created(
      createTestReviewState(),
      {
        type: "notes/create",
        fileKey: "alpha",
        target: { side: "new", line: 12 },
        body: { summary: "Check this", rationale: "Because", tags: ["mcp"], confidence: "high" },
      },
      AGENT_FACTS,
    );

    expect(entry).toEqual({
      note: {
        id: "mcp:1",
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
        tags: ["mcp"],
        confidence: "high",
        author: "Pi",
        createdAt: AGENT_FACTS.timestamp,
        editable: false,
      },
      resolution: "active",
    });
    expect(plan.actions).toEqual([{ type: "notes/add-live", notes: [entry] }]);
  });

  // Source: the authorship rule — nothing in the request body can choose who a note is from.
  // Passes when a body smuggling an id, a source, an author, and editability still yields an
  // agent note with the caller's id and label.
  test("takes identity and provenance from the facts, never from the body", () => {
    const body = {
      summary: "x",
      id: "user:forged",
      source: "user",
      author: "Antonio",
      editable: true,
    } as unknown as ReviewNoteBodyV1;
    const { entry } = created(
      createTestReviewState(),
      { type: "notes/create", fileKey: "alpha", target: { hunkIndex: 0 }, body },
      AGENT_FACTS,
    );

    expect(entry.note).toMatchObject({
      id: "mcp:1",
      source: "agent",
      author: "Pi",
      editable: false,
    });
  });

  // Source: a hunk-wide comment hangs from the hunk's first added line (the shared default
  // target). Hunk 1 of the test file adds line 12, so passes when the anchor prefers new 12.
  test("places a hunk-wide note on the hunk's default line", () => {
    const { entry } = created(
      createTestReviewState(),
      { type: "notes/create", fileKey: "alpha", target: { hunkIndex: 1 }, body: { summary: "x" } },
      AGENT_FACTS,
    );

    expect(entry.note.anchor.preferred).toEqual({ side: "new", line: 12 });
    expect(entry.note.anchor.ownerHunkIndex).toBe(1);
  });

  // Source: a range target names inclusive source lines, owned by the hunk holding its
  // preferred line. Passes when lines 11-13 stay one range owned by hunk 1.
  test("anchors a range target the patch covers", () => {
    const { entry } = created(
      createTestReviewState(),
      {
        type: "notes/create",
        fileKey: "alpha",
        target: { newRange: [11, 13], preferred: { side: "new", line: 13 } },
        body: { summary: "range" },
      },
      AGENT_FACTS,
    );

    expect(entry.note.anchor).toEqual({
      newRange: [11, 13],
      preferred: { side: "new", line: 13 },
      intersectingHunkIndices: [1],
      ownerHunkIndex: 1,
    });
  });

  // Source: the authorship rule (reviewer channels write reviewer notes). Passes when the
  // note joins the reviewer collection, editable and labelled `user`, and any open composer
  // draft is left alone.
  test("writes an editable reviewer note from a reviewer channel without touching the draft", () => {
    const state = stateWithDraft("still typing");
    const { plan, entry } = created(
      state,
      {
        type: "notes/create",
        fileKey: "beta",
        target: { side: "old", line: 2 },
        body: { summary: "Mine" },
      },
      { ...FACTS, noteId: "user:2" },
    );

    expect(entry.note).toMatchObject({
      id: "user:2",
      source: "user",
      originalSource: "user",
      author: "user",
      editable: true,
    });
    expect(plan.actions).toEqual([{ type: "notes/add-user", note: entry }]);
    const next = plan.actions.reduce(reduceReviewState, state);
    expect(next.draftNote).toEqual(state.draftNote);
    expect(next.userNotes.map(({ note }) => note.id)).toEqual(["user:2"]);
  });

  // Source: replies inherit their parent's file and anchor. Passes when the reply copies the
  // parent's anchor, file, and stale verdict and records the parent id.
  test("replies under an existing note on its anchor", () => {
    const parent = createTestStoredNote({
      id: "user-1",
      fileKey: "beta",
      hunkIndex: 1,
      line: 12,
      source: "user",
      resolution: "stale",
    });
    const { entry } = created(
      { ...createTestReviewState(), userNotes: [parent] },
      { type: "notes/create", parentId: "user-1", body: { summary: "Agreed" } },
      AGENT_FACTS,
    );

    expect(entry).toMatchObject({
      note: { parentId: "user-1", fileKey: "beta", anchor: parent.note.anchor },
      resolution: "stale",
    });
  });

  // Source: the existing agent-comment errors and the shared rejection codes. Passes when
  // each invalid write is refused with its code before any action is planned.
  test("rejects targets, bodies, and facts it cannot honor", () => {
    const state = {
      ...createTestReviewState(),
      liveNotes: [
        createTestStoredNote({ id: "mcp:1", fileKey: "alpha" }),
        createTestStoredNote({ id: "gone", fileKey: "alpha", resolution: "orphaned" }),
      ],
    };
    const root = (target: object, body = { summary: "x" }) =>
      ({ type: "notes/create", fileKey: "alpha", target, body }) as ReviewIntent;
    const expectCode = (
      intent: ReviewIntent,
      code: ReviewIntentPlanningErrorCode,
      facts: ReviewIntentFacts = { ...AGENT_FACTS, noteId: "mcp:2" },
      message?: string,
    ) => expectPlanningRejection(() => planReviewIntent(state, intent, facts), code, message);

    expectCode(
      root({ side: "new", line: 5 }),
      "hunk-not-found",
      undefined,
      "No new diff hunk in alpha.ts covers line 5.",
    );
    expectCode(
      root({ hunkIndex: 2 }),
      "hunk-not-found",
      undefined,
      "No diff hunk 3 exists in alpha.ts.",
    );
    expectCode(
      {
        type: "notes/create",
        fileKey: "missing",
        target: { hunkIndex: 0 },
        body: { summary: "x" },
      },
      "file-not-found",
    );
    expectCode(
      root({ newRange: [5, 12], preferred: { side: "new", line: 12 } }),
      "invalid-request",
    );
    expectCode(root({ hunkIndex: 0 }, { summary: "  " }), "blank-note");
    expectCode(
      root({ hunkIndex: 0 }, { summary: "x".repeat(MAX_REVIEW_NOTE_BYTES) }),
      "note-too-large",
    );
    expectCode(
      { type: "notes/create", parentId: "gone", body: { summary: "x" } },
      "invalid-note-parent",
    );
    expectCode(root({ hunkIndex: 0 }), "note-id-conflict", AGENT_FACTS);
    expectCode(root({ hunkIndex: 0 }), "missing-fact", {
      noteId: "mcp:2",
      timestamp: AGENT_FACTS.timestamp,
    });
  });
});

describe("draftless note editing", () => {
  const agentNote = createTestStoredNote({
    id: "mcp:1",
    fileKey: "alpha",
    summary: "before",
    createdAt: "2024-01-01T00:00:00.000Z",
  });
  agentNote.note.rationale = "old rationale";
  const userNote = createTestStoredNote({
    id: "user:1",
    fileKey: "alpha",
    source: "user",
    editable: true,
  });
  const state = { ...createTestReviewState(), liveNotes: [agentNote], userNotes: [userNote] };
  const EDIT_FACTS = { timestamp: "2024-03-03T00:00:00.000Z", authorship: SESSION_CLI };

  // Source: the plan's `notes/update` contract (the body replaces the note's words; identity,
  // anchor, and provenance stay). Passes when the agent note keeps its id and anchor, takes
  // the new body exactly, and records `updatedAt`.
  test("replaces an agent note's body in place from an agent channel", () => {
    const plan = planReviewIntent(
      state,
      { type: "notes/update", noteId: "mcp:1", body: { summary: "after" } },
      EDIT_FACTS,
    );

    const note = {
      ...agentNote.note,
      summary: "after",
      rationale: undefined,
      updatedAt: EDIT_FACTS.timestamp,
    };
    expect(plan.outcome).toEqual({
      type: "notes/updated",
      note: { ...agentNote, note },
    });
    const next = plan.actions.reduce(reduceReviewState, state);
    expect(next.liveNotes.map((entry) => entry.note)).toEqual([note]);
    expect(next.userNotes).toBe(state.userNotes);
  });

  // Source: the authorship rule — reviewer notes are edited only from reviewer channels and
  // agent notes only from agent channels. Passes when both crossings are refused with
  // `note-not-editable`, and a missing or blank target with its own code.
  test("refuses edits across the authorship line", () => {
    const expectCode = (
      intent: ReviewIntent,
      facts: ReviewIntentFacts,
      code: ReviewIntentPlanningErrorCode,
    ) => expectPlanningRejection(() => planReviewIntent(state, intent, facts), code);
    const update = (noteId: string, summary = "x") =>
      ({ type: "notes/update", noteId, body: { summary } }) as ReviewIntent;

    expectCode(update("user:1"), EDIT_FACTS, "note-not-editable");
    expectCode(update("mcp:1"), { ...EDIT_FACTS, authorship: TERMINAL }, "note-not-editable");
    expectCode(update("missing"), EDIT_FACTS, "note-not-found");
    expectCode(update("mcp:1", " "), EDIT_FACTS, "blank-note");
    expectCode(update("mcp:1"), { timestamp: EDIT_FACTS.timestamp }, "missing-fact");
  });

  // Source: the same rule applied to the composer's edit intent. Passes when an agent
  // authorship cannot commit a composer edit of a reviewer note.
  test("applies the authorship rule to composer edits", () => {
    const editing = planReviewIntent(
      state,
      { type: "notes/start-edit", noteId: "user:1" },
      { draftId: "draft:edit" },
    ).actions.reduce(reduceReviewState, state);

    expect(() =>
      planReviewIntent(
        editing,
        { type: "notes/update-user", noteId: "user:1", consumeDraft: true },
        EDIT_FACTS,
      ),
    ).toThrow(
      new ReviewIntentPlanningError("note-not-editable", "Review note user:1 is not editable."),
    );
  });
});

describe("planReviewIntentBatch", () => {
  const facts = (index: number) => ({
    noteId: `mcp:batch:${index}`,
    timestamp: "2024-04-04T00:00:00.000Z",
    authorship: SESSION_CLI,
  });

  // Source: batch comments apply all-or-nothing, in order. Passes when a later reply sees the
  // note an earlier intent created, and every action is returned for one commit.
  test("plans each intent against the state the earlier ones produce", () => {
    const state = createTestReviewState();
    const plan = planReviewIntentBatch(state, [
      {
        intent: {
          type: "notes/create",
          fileKey: "alpha",
          target: { hunkIndex: 0 },
          body: { summary: "root" },
        },
        facts: facts(0),
      },
      {
        intent: { type: "notes/create", parentId: "mcp:batch:0", body: { summary: "reply" } },
        facts: facts(1),
      },
    ]);

    expect(plan.outcomes.map((outcome) => outcome?.type)).toEqual([
      "notes/created",
      "notes/created",
    ]);
    const next = plan.actions.reduce(reduceReviewState, state);
    expect(next.liveNotes.map(({ note }) => [note.id, note.parentId])).toEqual([
      ["mcp:batch:0", undefined],
      ["mcp:batch:1", "mcp:batch:0"],
    ]);
  });

  // Source: batch comments apply all-or-nothing. Passes when one invalid item rejects the
  // whole batch, so the caller has nothing to commit.
  test("rejects the whole batch when any intent is rejected", () => {
    expect(() =>
      planReviewIntentBatch(createTestReviewState(["alpha"]), [
        {
          intent: {
            type: "notes/create",
            fileKey: "alpha",
            target: { hunkIndex: 0 },
            body: { summary: "ok" },
          },
          facts: facts(0),
        },
        {
          intent: {
            type: "notes/create",
            fileKey: "alpha",
            target: { hunkIndex: 9 },
            body: { summary: "bad" },
          },
          facts: facts(1),
        },
      ]),
    ).toThrow(ReviewIntentPlanningError);
  });
});

describe("applyReviewIntent", () => {
  test("commits the planned actions and returns the outcome", () => {
    const store = createReviewStore(createTestReviewDocument(["alpha", "beta"]));
    store.dispatch({
      type: "draft/start",
      draft: { id: "d", fileKey: "alpha", hunkIndex: 0, side: "new", line: 3, body: "note body" },
    });

    const outcome = applyReviewIntent(
      store,
      { type: "notes/create-user", consumeDraft: true },
      FACTS,
    );

    expect(outcome?.type).toBe("notes/created");
    expect(store.getSnapshot().draftNote).toBeNull();
    expect(store.getSnapshot().userNotes.map((entry) => entry.note.id)).toEqual(["user:1"]);
  });

  test("leaves state untouched when planning rejects the intent", () => {
    const store = createReviewStore(createTestReviewDocument(["alpha"]));
    const before = store.getSnapshot();

    expect(() =>
      applyReviewIntent(store, { type: "notes/remove-user", noteId: "missing" }),
    ).toThrow(ReviewIntentPlanningError);
    expect(store.getSnapshot()).toBe(before);
  });
});

describe("notes/start-draft", () => {
  test("opens a draft at the hunk's default note target and reveals it", () => {
    const state = createTestReviewState();

    const plan = planReviewIntent(
      state,
      { type: "notes/start-draft", fileKey: "alpha", hunkIndex: 1 },
      { draftId: "draft:1" },
    );

    expect(plan.actions).toEqual([
      {
        type: "draft/start",
        draft: {
          kind: "create",
          id: "draft:1",
          fileKey: "alpha",
          hunkIndex: 1,
          // The second test hunk starts at line 11 with one context line before the change.
          side: "new",
          line: 12,
          targetKind: "line",
          anchor: {
            newRange: [12, 12],
            preferred: { side: "new", line: 12 },
            intersectingHunkIndices: [1],
            ownerHunkIndex: 1,
          },
          body: "",
        },
      },
      {
        type: "selection/select",
        fileKey: "alpha",
        hunkIndex: 1,
        reveal: { anchor: "hunk", scrollToNote: true },
      },
    ]);
    expect(plan.outcome).toEqual({
      type: "notes/draft-started",
      draft: {
        kind: "create",
        id: "draft:1",
        fileKey: "alpha",
        hunkIndex: 1,
        side: "new",
        line: 12,
        targetKind: "line",
        anchor: {
          newRange: [12, 12],
          preferred: { side: "new", line: 12 },
          intersectingHunkIndices: [1],
          ownerHunkIndex: 1,
        },
        body: "",
      },
    });
  });

  test("honors a caller-measured line target and reveal request", () => {
    const plan = planReviewIntent(
      createTestReviewState(),
      {
        type: "notes/start-draft",
        fileKey: "alpha",
        hunkIndex: 0,
        target: { side: "old", line: 2 },
        reveal: { anchor: "none", scrollToNote: false },
      },
      { draftId: "draft:2" },
    );

    expect(plan.actions[0]).toMatchObject({
      type: "draft/start",
      draft: { side: "old", line: 2, targetKind: "line" },
    });
    expect(plan.actions[1]).toMatchObject({ reveal: { anchor: "none", scrollToNote: false } });
  });

  test("preserves a legacy line target in an expanded gap with its source authority", () => {
    const plan = planReviewIntent(
      createTestReviewState([
        { key: "alpha", sourceIdentity: "source:alpha", sourceAttested: true },
      ]),
      {
        type: "notes/start-draft",
        fileKey: "alpha",
        hunkIndex: 1,
        target: { side: "new", line: 7 },
      },
      { draftId: "draft:gap-line" },
    );

    expect(plan.outcome).toMatchObject({
      type: "notes/draft-started",
      draft: {
        targetKind: "line",
        side: "new",
        line: 7,
        expandedLineSource: {
          sourceIdentity: "source:alpha",
          sourceAttested: true,
        },
        anchor: { newRange: [7, 7], ownerHunkIndex: 1 },
      },
    });
  });

  test("does not attach source authority to an ordinary patch line", () => {
    const plan = planReviewIntent(
      createTestReviewState([
        { key: "alpha", sourceIdentity: "source:alpha", sourceAttested: true },
      ]),
      {
        type: "notes/start-draft",
        fileKey: "alpha",
        hunkIndex: 0,
        target: { side: "new", line: 2 },
      },
      { draftId: "draft:patch-line" },
    );

    expect(plan.outcome?.type).toBe("notes/draft-started");
    if (plan.outcome?.type !== "notes/draft-started") throw new Error("draft not started");
    expect(plan.outcome.draft.expandedLineSource).toBeUndefined();
  });

  test("attaches source authority to a zero-count hunk side", () => {
    for (const side of ["old", "new"] as const) {
      const state = createTestReviewState([
        { key: "alpha", sourceIdentity: "source:alpha", sourceAttested: true },
      ]);
      const hunk = createTestReviewHunk(0);
      state.document.files[0]!.hunks = [
        side === "old"
          ? { ...hunk, deletionCount: 0, deletionLines: 0 }
          : { ...hunk, additionCount: 0, additionLines: 0 },
      ];
      const line = side === "old" ? hunk.deletionStart : hunk.additionStart;
      const plan = planReviewIntent(
        state,
        {
          type: "notes/start-draft",
          fileKey: "alpha",
          hunkIndex: 0,
          target: { side, line },
        },
        { draftId: `draft:${side}` },
      );

      expect(plan.outcome).toMatchObject({
        type: "notes/draft-started",
        draft: {
          side,
          line,
          expandedLineSource: {
            sourceIdentity: "source:alpha",
            sourceAttested: true,
          },
        },
      });
    }
  });

  test("rejects a range target that includes a line omitted from the patch", () => {
    expect(() =>
      planReviewIntent(
        createTestReviewState(),
        {
          type: "notes/start-draft",
          fileKey: "alpha",
          hunkIndex: 1,
          target: { newRange: [7, 7], preferred: { side: "new", line: 7 } },
        },
        { draftId: "draft:gap-range" },
      ),
    ).toThrow("Review range target is not covered by the current patch (new).");
  });

  test("rejects a covered range whose requested hunk is not its resolved owner", () => {
    expect(() =>
      planReviewIntent(
        createTestReviewState(),
        {
          type: "notes/start-draft",
          fileKey: "alpha",
          hunkIndex: 0,
          target: { newRange: [11, 13], preferred: { side: "new", line: 12 } },
        },
        { draftId: "draft:wrong-owner" },
      ),
    ).toThrow("Review range resolves to hunk 1, not requested hunk 0.");
  });

  test("retains a multiline range unchanged through draft creation and save", () => {
    const initial = createTestReviewState();
    const startPlan = planReviewIntent(
      initial,
      {
        type: "notes/start-draft",
        fileKey: "alpha",
        hunkIndex: 1,
        target: { newRange: [11, 13], preferred: { side: "new", line: 13 } },
      },
      { draftId: "draft:range" },
    );
    if (startPlan.outcome?.type !== "notes/draft-started") throw new Error("draft not started");
    const started = startPlan.outcome;
    expect(started.draft.targetKind).toBe("range");
    expect(started.draft.anchor).toEqual({
      newRange: [11, 13],
      preferred: { side: "new", line: 13 },
      intersectingHunkIndices: [1],
      ownerHunkIndex: 1,
    });

    const withDraft = {
      ...initial,
      draftNote: { ...started.draft, body: "Range feedback" },
    };
    const saved = planReviewIntent(
      withDraft,
      { type: "notes/create-user", consumeDraft: true },
      { noteId: "user:range", timestamp: "2026-01-01T00:00:00.000Z", authorship: TERMINAL },
    );
    if (saved.outcome?.type !== "notes/created") throw new Error("note not created");
    expect(saved.outcome.note.note.anchor).toEqual(started.draft.anchor!);
  });

  test("requires the caller to own the draft's identity", () => {
    expect(() =>
      planReviewIntent(createTestReviewState(), {
        type: "notes/start-draft",
        fileKey: "alpha",
        hunkIndex: 0,
      }),
    ).toThrow(ReviewIntentPlanningError);
  });

  test("rejects a hunk the file does not have", () => {
    expect(() =>
      planReviewIntent(
        createTestReviewState(),
        { type: "notes/start-draft", fileKey: "alpha", hunkIndex: 9 },
        { draftId: "draft:3" },
      ),
    ).toThrow(ReviewIntentPlanningError);
  });
});

describe("expansion/toggle", () => {
  test("expands a collapsed gap and reports the address it resolved", () => {
    const plan = planReviewIntent(createTestReviewState(), {
      type: "expansion/toggle",
      fileKey: "alpha",
      gapId: "before:1",
    });

    expect(plan.actions).toEqual([
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: true },
    ]);
    expect(plan.outcome).toEqual({
      type: "expansion/toggled",
      fileKey: "alpha",
      gapId: "before:1",
      expanded: true,
      side: "new",
      oldRange: [2, 10],
      newRange: [2, 10],
      lineCount: 9,
    });
  });

  test("collapses a gap that is already expanded", () => {
    const state = reduceReviewState(createTestReviewState(), {
      type: "expansion/toggle",
      fileKey: "alpha",
      gapId: "before:1",
      expanded: true,
    });

    const plan = planReviewIntent(state, {
      type: "expansion/toggle",
      fileKey: "alpha",
      gapId: "before:1",
    });

    expect(plan.actions).toEqual([
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: false },
    ]);
    expect(plan.outcome).toMatchObject({ expanded: false });
  });

  test("carries the source identity a caller needs to fill the gap", () => {
    const state = createTestReviewState([{ key: "alpha", sourceIdentity: "source:alpha" }]);

    const plan = planReviewIntent(state, {
      type: "expansion/toggle",
      fileKey: "alpha",
      gapId: "before:1",
    });

    expect(plan.outcome).toMatchObject({ sourceIdentity: "source:alpha" });
  });

  test("rejects a gap id the file's geometry does not address", () => {
    for (const gapId of ["before:0", "trailing:1", "nonsense"]) {
      expect(() =>
        planReviewIntent(createTestReviewState(), {
          type: "expansion/toggle",
          fileKey: "alpha",
          gapId,
        }),
      ).toThrow(ReviewIntentPlanningError);
    }
  });
});
