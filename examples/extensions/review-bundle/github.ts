/** Read authenticated GitHub Viewed state and guard unconditional mutations against pinned content. */
import type { BundleIdentity } from "./bundle";
import { oid } from "./bundle";
import type { CommandRunner } from "./process";

export type ViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";
export interface GitHubViewedSnapshot {
  id: string;
  head: string;
  mergeBase: string;
  files: ReadonlyMap<string, ViewedState>;
}
export interface GitHubViewedClient {
  read(signal: AbortSignal): Promise<GitHubViewedSnapshot>;
  write(id: string, path: string, viewed: boolean, signal: AbortSignal): Promise<void>;
}
const FIELDS = "id baseRefOid headRefOid";
const FILES_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){${FIELDS} files(first:100,after:$cursor){totalCount nodes{path viewerViewedState} pageInfo{hasNextPage endCursor}}}}}`;
const REFS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){${FIELDS}}}}`;
const MAX_FILES = 10_000;

/** Reject malformed API data without echoing potentially sensitive server messages. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned invalid Viewed data; sync unavailable.");
  return value as Record<string, unknown>;
}
/** Parse JSON without including response snippets in error output. */
function jsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GitHub returned malformed Viewed JSON; sync unavailable.");
  }
}
/** Validate PR identity on every paginated response. */
function pullRequest(json: string) {
  const root = record(jsonValue(json));
  if (root.errors !== undefined)
    throw new Error(
      "GitHub denied or could not complete Viewed sync; check gh authentication and permissions.",
    );
  const pr = record(record(record(root.data).repository).pullRequest);
  if (typeof pr.id !== "string" || !pr.id || pr.id.length > 1024)
    throw new Error("GitHub returned invalid PR identity.");
  return { raw: pr, id: pr.id, base: oid(pr.baseRefOid), head: oid(pr.headRefOid) };
}

/** Build bounded gh API calls; all repository/path inputs travel as arguments or JSON variables. */
export function createGitHubViewedClient(
  bundle: BundleIdentity,
  cwd: string,
  run: CommandRunner,
): GitHubViewedClient {
  const [owner, name] = bundle.repository.split("/");
  let acceptedId: string | undefined;
  const query = async (source: string, signal: AbortSignal, cursor?: string) =>
    pullRequest(
      await run(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          "graphql",
          "-f",
          `query=${source}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `number=${bundle.number}`,
          ...(cursor === undefined ? [] : ["-f", `cursor=${cursor}`]),
        ],
        cwd,
        signal,
      ),
    );
  return {
    async read(signal) {
      signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      signal.throwIfAborted();
      const files = new Map<string, ViewedState>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let identity: { id: string; base: string; head: string } | undefined;
      let total: number | undefined;
      for (let page = 0; page < 100; page++) {
        const pr = await query(FILES_QUERY, signal, cursor);
        if (
          identity &&
          (pr.id !== identity.id || pr.base !== identity.base || pr.head !== identity.head)
        )
          throw new Error(
            "PR changed while reading Viewed state; refresh the bundle before syncing.",
          );
        identity = pr;
        const connection = record(pr.raw.files);
        if (
          !Number.isSafeInteger(connection.totalCount) ||
          (connection.totalCount as number) < 0 ||
          (connection.totalCount as number) > MAX_FILES ||
          (total !== undefined && total !== connection.totalCount)
        )
          throw new Error("GitHub Viewed file listing is incomplete or exceeds its safety limit.");
        total = connection.totalCount as number;
        if (!Array.isArray(connection.nodes) || connection.nodes.length > 100)
          throw new Error("GitHub returned invalid file pagination.");
        for (const value of connection.nodes) {
          const file = record(value);
          if (
            typeof file.path !== "string" ||
            !file.path ||
            file.path.length > 4096 ||
            /[\u0000-\u001f\u007f]/.test(file.path) ||
            files.has(file.path) ||
            !["VIEWED", "UNVIEWED", "DISMISSED"].includes(String(file.viewerViewedState))
          )
            throw new Error("GitHub returned invalid or duplicate file Viewed state.");
          files.set(file.path, file.viewerViewedState as ViewedState);
        }
        const pageInfo = record(connection.pageInfo);
        if (typeof pageInfo.hasNextPage !== "boolean")
          throw new Error("GitHub returned invalid pagination.");
        if (!pageInfo.hasNextPage) {
          if (files.size !== total)
            throw new Error("GitHub Viewed listing is incomplete; sync unavailable.");
          const comparison = record(
            jsonValue(
              await run(
                "gh",
                [
                  "api",
                  "--hostname",
                  "github.com",
                  `repos/${bundle.repository}/compare/${pr.base}...${pr.head}`,
                ],
                cwd,
                signal,
              ),
            ),
          );
          const mergeBase = oid(record(comparison.merge_base_commit).sha);
          const after = await query(REFS_QUERY, signal);
          if (after.id !== pr.id || after.base !== pr.base || after.head !== pr.head)
            throw new Error(
              "PR changed while reading Viewed state; refresh the bundle before syncing.",
            );
          if (pr.head !== bundle.head || mergeBase !== bundle.mergeBase)
            throw new Error(
              "Stale review bundle: GitHub's comparison changed. Refresh the bundle through the assessment workflow, then reopen Hunk. Viewed is local only.",
            );
          if (acceptedId !== undefined && acceptedId !== pr.id)
            throw new Error(
              "GitHub PR identity changed; reopen the reviewed bundle before syncing.",
            );
          acceptedId = pr.id;
          return { id: pr.id, head: pr.head, mergeBase, files };
        }
        if (
          typeof pageInfo.endCursor !== "string" ||
          !pageInfo.endCursor ||
          pageInfo.endCursor.length > 2048 ||
          cursors.has(pageInfo.endCursor)
        )
          throw new Error("GitHub pagination did not advance.");
        cursor = pageInfo.endCursor;
        cursors.add(cursor);
      }
      throw new Error("GitHub Viewed pagination exceeded its safety limit.");
    },
    async write(id, path, viewed, signal) {
      const mutation = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
      const json = await run(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          "graphql",
          "-f",
          `query=mutation($id:ID!,$path:String!){${mutation}(input:{pullRequestId:$id,path:$path}){clientMutationId}}`,
          "-f",
          `id=${id}`,
          "-f",
          `path=${path}`,
        ],
        cwd,
        signal,
      );
      const result = record(jsonValue(json));
      if (result.errors !== undefined || !record(result.data)[mutation])
        throw new Error(
          "GitHub did not confirm the Viewed mutation; outcome unknown. Refresh to reconcile.",
        );
    },
  };
}
