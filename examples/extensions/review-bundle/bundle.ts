/** Validate explicit bundle identity and pin its comparison without changing bundle files. */
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CommandRunner } from "./process";

export interface BundleIdentity {
  repository: string;
  number: number;
  url: string;
  base: string;
  head: string;
  mergeBase: string;
}
export interface BundleInvocation {
  directory: string;
  expectedBase?: string;
  expectedHead?: string;
  diffArgs: string[];
}

/** Require an immutable GitHub commit identity, never a ref or revision expression. */
export function oid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value))
    throw new Error("Bundle revisions must be full 40-digit commit OIDs.");
  return value.toLowerCase();
}

/** Read only the two identity spellings present in existing review-pr bundles. */
export function parseBundleMetadata(value: unknown): BundleIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid review bundle metadata.");
  const data = value as Record<string, unknown>;
  const repository = data.repository;
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Bundle repository must be owner/repository.");
  if (!Number.isSafeInteger(data.number) || (data.number as number) <= 0)
    throw new Error("Bundle PR number must be positive.");
  const number = data.number as number;
  const url = `https://github.com/${repository}/pull/${number}`;
  if (data.url !== url) throw new Error("Bundle URL must identify the recorded GitHub PR.");
  // Other recorded OIDs are not executable inputs, but malformed supplied identities are not accepted.
  for (const [key, item] of Object.entries(data)) if (/(Oid|_oid)$/.test(key)) oid(item);
  const revision = (camel: string, snake: string) => {
    const first = data[camel],
      second = data[snake];
    if (first !== undefined && second !== undefined && oid(first) !== oid(second))
      throw new Error("Bundle contains conflicting revision identities.");
    return oid(first ?? second);
  };
  return {
    repository,
    number,
    url,
    base: revision("baseOid", "base_oid"),
    head: revision("headOid", "head_oid"),
    mergeBase: revision("mergeBaseOid", "merge_base_oid"),
  };
}

/** Parse explicit launcher guards and a bounded set of ordinary presentation options. */
export function parseBundleInvocation(args: readonly string[]): BundleInvocation {
  const directory = args[0];
  if (!directory || directory.startsWith("-"))
    throw new Error(
      "Usage: hunk review-bundle <directory> [--expect-base OID --expect-head OID] [-- <presentation-options>]",
    );
  const result: BundleInvocation = { directory, diffArgs: [] };
  let index = 1;
  for (; index < args.length && args[index] !== "--"; index += 2) {
    const key =
      args[index] === "--expect-base"
        ? "expectedBase"
        : args[index] === "--expect-head"
          ? "expectedHead"
          : null;
    if (!key || result[key] !== undefined)
      throw new Error("Unknown or repeated review-bundle option.");
    result[key] = oid(args[index + 1]);
  }
  if (Boolean(result.expectedBase) !== Boolean(result.expectedHead))
    throw new Error("Supply both --expect-base and --expect-head.");
  const valueOptions = new Set(["--agent-context", "--mode", "--theme", "--cursor-line"]);
  const flags = new Set([
    "--line-numbers",
    "--no-line-numbers",
    "--wrap",
    "--no-wrap",
    "--agent-notes",
    "--no-agent-notes",
  ]);
  for (index += 1; index < args.length; index++) {
    const option = args[index]!;
    if (valueOptions.has(option)) {
      const value = args[++index];
      if (!value || value.startsWith("-") || value === "-")
        throw new Error(
          "A presentation option requires a value; stdin sidecars are not supported.",
        );
      result.diffArgs.push(option, value);
    } else if (flags.has(option)) result.diffArgs.push(option);
    else
      throw new Error(
        "Only presentation and --agent-context options may follow --; bundle revisions are pinned.",
      );
  }
  return result;
}

/** Read metadata with a fixed allocation even if a bundle changes while being read. */
export async function readBundle(directory: string, cwd: string): Promise<BundleIdentity> {
  const handle = await open(join(resolve(cwd, directory), "metadata.json"), "r");
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count === bytes.length) throw new Error("Bundle metadata exceeds 2 MiB.");
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)),
      );
    } catch {
      throw new Error("Bundle metadata is not valid UTF-8 JSON.");
    }
    return parseBundleMetadata(value);
  } finally {
    await handle.close();
  }
}

/** Verify repository provenance and all pinned commits before opening the host comparison. */
export async function validateBundleCheckout(
  bundle: BundleIdentity,
  cwd: string,
  run: CommandRunner,
  signal: AbortSignal,
): Promise<void> {
  const remote = (await run("git", ["remote", "get-url", "origin"], cwd, signal)).trim();
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s?#]+?)(?:\.git)?\/?$/.exec(
      remote,
    );
  if (!match || match[1]!.toLowerCase() !== bundle.repository.toLowerCase())
    throw new Error("This checkout's origin does not match the bundle repository.");
  for (const commit of new Set([bundle.base, bundle.head, bundle.mergeBase])) {
    if ((await run("git", ["cat-file", "-t", commit], cwd, signal)).trim() !== "commit")
      throw new Error("A bundle revision is not a locally available commit.");
  }
  const mergeBase = (
    await run("git", ["merge-base", bundle.base, bundle.head], cwd, signal)
  ).trim();
  if (mergeBase !== bundle.mergeBase)
    throw new Error("The bundle merge-base does not match its pinned commits.");
}
