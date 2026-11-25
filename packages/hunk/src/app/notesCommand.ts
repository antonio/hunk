/**
 * Runs `hunk notes list|clear|prune` against Hunk's built-in note store.
 *
 * The store's files live in the user's state directory (`extensions/default/core/notes.ts`);
 * these commands only read, list, and delete them. A review to clear by command is resolved
 * before this runs, by the same startup pipeline that opens that review, so `hunk notes clear
 * show HEAD` clears exactly what `hunk show HEAD` would restore.
 */
import { homedir } from "node:os";
import type { AppBootstrap } from "../core/bootstrap";
import type { NotesCommandInput } from "../core/run/commandInputs";
import type { ExtensionReviewNoteStoreTarget } from "../extension-api/types";
import {
  builtInNoteStoreDirectory,
  listSavedReviews,
  removeGoneSavedReviews,
  removeSavedReview,
  removeSavedReviewsChangedBefore,
  type SavedReviewSummary,
} from "../extensions/default/core/notes";
import { reviewNoteStoreTarget } from "../extensions/noteStoreTarget";
import { createVcsCommitCheck } from "./savedNoteCommits";
import { getBundledVcsCatalog } from "./vcsCatalog";

/** What the command needs from its process. */
export interface NotesCommandEnvironment {
  env: Record<string, string | undefined>;
  /** The current time, for pruning. */
  now?: Date;
  /** Home directory, for shortening paths in listings. */
  home?: string;
}

/** Shorten a path under the home directory to `~/…` for display. */
function displayPath(path: string, home: string) {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Describe a saved review the way a reader would name it. */
export function describeNoteStoreTarget(target: ExtensionReviewNoteStoreTarget, home: string) {
  const where = target.repoRoot ? `${displayPath(target.repoRoot, home)} ` : "";
  const [first = "", second = "", ...rest] = target.spec;
  switch (target.operation) {
    case "change-request":
      return `${first} ${second} ${rest[0] ?? ""}`.replace(/\s+/g, " ").trim();
    case "vcs": {
      const what = second ? `diff ${second}` : "working tree";
      const staged = first === "staged" ? " --staged" : "";
      const paths = rest.length > 0 ? ` -- ${rest.join(" ")}` : "";
      return `${where}${what}${staged}${paths}`;
    }
    case "show":
      return `${where}show ${first.slice(0, 12)}${target.spec.length > 1 ? ` -- ${target.spec.slice(1).join(" ")}` : ""}`;
    case "stash-show":
      return `${where}stash show ${first}`.trim();
    case "patch":
      return `patch ${displayPath(first, home)}`;
    case "diff":
    case "difftool":
      return `diff ${displayPath(first, home)} ${displayPath(second, home)}`;
  }
}

/** Format one timestamp as local `YYYY-MM-DD HH:MM`. */
function formatTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Render the listing as an aligned table. */
function formatList(reviews: readonly SavedReviewSummary[], home: string) {
  if (reviews.length === 0) return "No saved notes.\n";
  const rows = reviews.map((review) => [
    review.key.slice(0, 12),
    String(review.noteCount),
    formatTime(review.lastChange),
    review.target ? describeNoteStoreTarget(review.target, home) : "(unreadable)",
  ]);
  const header = ["REVIEW", "NOTES", "LAST CHANGE", "WHAT"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  return `${[header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
        .join("  "),
    )
    .join("\n")}\n`;
}

/** Find the full key of a review from a key or a unique prefix of one, as `list` prints them. */
async function resolveKey(directory: string, key: string) {
  const matches = (await listSavedReviews(directory)).filter((review) =>
    review.key.startsWith(key),
  );
  if (matches.length > 1) {
    throw new Error(`Review key ${key} matches ${matches.length} saved reviews; give more of it.`);
  }
  return matches[0]?.key;
}

/** Run one notes command and return what it prints. */
export async function runNotesCommand(
  input: NotesCommandInput,
  review: Pick<AppBootstrap, "input" | "reloadContext" | "review"> | undefined,
  { env, now = new Date(), home = homedir() }: NotesCommandEnvironment,
): Promise<string> {
  const directory = builtInNoteStoreDirectory(env, home);
  const json = input.output === "json";

  if (input.action === "list") {
    const reviews = await listSavedReviews(directory);
    return json
      ? `${JSON.stringify(
          {
            reviews: reviews.map(({ key, target, noteCount, lastChange }) => ({
              key,
              noteCount,
              lastChange: lastChange.toISOString(),
              ...(target ? { target } : {}),
            })),
          },
          null,
          2,
        )}\n`
      : formatList(reviews, home);
  }

  let removed: string[];
  let described: string | undefined;
  if (input.action === "prune") {
    if (input.olderThanMs === undefined) {
      const commitCheck = createVcsCommitCheck(getBundledVcsCatalog());
      try {
        removed = await removeGoneSavedReviews(directory, {
          isCommitGone: commitCheck.isCommitGone,
        });
      } finally {
        await commitCheck.close();
      }
    } else {
      removed = await removeSavedReviewsChangedBefore(
        directory,
        new Date(now.getTime() - input.olderThanMs),
      );
    }
  } else if (input.scope.kind === "all") {
    removed = await removeSavedReviewsChangedBefore(directory);
  } else {
    let key: string | undefined;
    if (input.scope.kind === "key") {
      key = await resolveKey(directory, input.scope.key);
      described = `review ${input.scope.key}`;
    } else {
      const target = review && reviewNoteStoreTarget(review);
      if (!target) {
        throw new Error(
          "This review has no saved notes: Hunk saves no notes for a patch read from stdin.",
        );
      }
      key = target.key;
      described = describeNoteStoreTarget(target, home);
    }
    removed = key && (await removeSavedReview(directory, key)) ? [key] : [];
  }

  if (json) return `${JSON.stringify({ removed }, null, 2)}\n`;
  if (described !== undefined) {
    return removed.length > 0
      ? `Cleared the saved notes for ${described}.\n`
      : `No saved notes for ${described}.\n`;
  }
  return `Removed saved notes for ${removed.length} ${removed.length === 1 ? "review" : "reviews"}.\n`;
}
