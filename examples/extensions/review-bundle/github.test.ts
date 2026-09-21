import { expect, test } from "bun:test";
import { createGitHubViewedClient } from "./github";
import type { CommandRunner } from "./process";
const bundle = {
  repository: "acme/project",
  number: 7,
  url: "https://github.com/acme/project/pull/7",
  base: "1".repeat(40),
  mergeBase: "1".repeat(40),
  head: "2".repeat(40),
};
const signal = new AbortController().signal;
/** Build a complete GitHub response with controllable page and revision facts. */
function page(
  nodes: unknown[],
  next = false,
  cursor: string | null = null,
  total = nodes.length,
  head = bundle.head,
) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          id: "PR_7",
          baseRefOid: bundle.base,
          headRefOid: head,
          files: { totalCount: total, nodes, pageInfo: { hasNextPage: next, endCursor: cursor } },
        },
      },
    },
  });
}
/** Capture real command arguments while supplying only transport responses. */
function createTestTransport(responses: string[]) {
  const calls: readonly string[][] = [];
  const mutable = calls as string[][];
  const run: CommandRunner = async (binary, args) => {
    expect(binary).toBe("gh");
    mutable.push([...args]);
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected API call");
    return response;
  };
  return { calls, run };
}
const compare = JSON.stringify({ merge_base_commit: { sha: bundle.mergeBase } });

test("reads all pages and preserves VIEWED, UNVIEWED and DISMISSED", async () => {
  const transport = createTestTransport([
    page([{ path: "a.ts", viewerViewedState: "VIEWED" }], true, "cursor1", 3),
    page(
      [
        { path: "b.ts", viewerViewedState: "UNVIEWED" },
        { path: "c.ts", viewerViewedState: "DISMISSED" },
      ],
      false,
      null,
      3,
    ),
    compare,
    page([]),
  ]);
  const result = await createGitHubViewedClient(bundle, process.cwd(), transport.run).read(signal);
  expect([...result.files]).toEqual([
    ["a.ts", "VIEWED"],
    ["b.ts", "UNVIEWED"],
    ["c.ts", "DISMISSED"],
  ]);
  expect(transport.calls[1]).toContain("cursor=cursor1");
  expect(transport.calls.every((args) => args.includes("github.com"))).toBe(true);
});

test("refuses incomplete, duplicate, malformed and cycling pages", async () => {
  for (const responses of [
    [page([], false, null, 1)],
    [page([{ path: "a", viewerViewedState: "BOGUS" }])],
    [
      page([
        { path: "a", viewerViewedState: "VIEWED" },
        { path: "a", viewerViewedState: "VIEWED" },
      ]),
    ],
    [page([], true, "x", 1), page([], true, "x", 1)],
    [JSON.stringify({ errors: [{ message: "secret token" }] })],
    ["malformed private response"],
  ]) {
    const transport = createTestTransport(responses);
    try {
      await createGitHubViewedClient(bundle, process.cwd(), transport.run).read(signal);
      throw new Error("Expected refusal");
    } catch (error) {
      expect(String(error)).not.toContain("secret token");
      expect(String(error)).not.toContain("private response");
      expect(String(error)).not.toContain("Expected refusal");
    }
  }
});

test("rejects changed heads, merge bases and movement during the read", async () => {
  for (const responses of [
    [page([], false, null, 0, "3".repeat(40)), compare, page([], false, null, 0, "3".repeat(40))],
    [page([]), JSON.stringify({ merge_base_commit: { sha: "4".repeat(40) } }), page([])],
    [page([]), compare, page([], false, null, 0, "3".repeat(40))],
    [page([], true, "x", 1), page([], false, null, 1, "3".repeat(40))],
  ])
    await expect(
      createGitHubViewedClient(bundle, process.cwd(), createTestTransport(responses).run).read(
        signal,
      ),
    ).rejects.toThrow();
});

test("uses parameterized mutations for the exact file path and requires confirmation", async () => {
  const transport = createTestTransport([
    JSON.stringify({ data: { markFileAsViewed: { clientMutationId: null } } }),
    JSON.stringify({ data: { unmarkFileAsViewed: { clientMutationId: null } } }),
    JSON.stringify({ errors: [{ message: "private" }] }),
  ]);
  const client = createGitHubViewedClient(bundle, process.cwd(), transport.run);
  await client.write("PR_7", 'a" $(cmd).ts', true, signal);
  await client.write("PR_7", 'a" $(cmd).ts', false, signal);
  expect(transport.calls[0]).toContain('path=a" $(cmd).ts');
  expect(transport.calls[0]?.join(" ")).toContain("markFileAsViewed");
  expect(transport.calls[1]?.join(" ")).toContain("unmarkFileAsViewed");
  await expect(client.write("PR_7", "a.ts", true, signal)).rejects.toThrow("outcome unknown");
});
