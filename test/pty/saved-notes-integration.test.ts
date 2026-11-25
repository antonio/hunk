import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(40_000);

afterEach(() => {
  harness.cleanup();
});

// Expected behavior comes from the plan's step-6 acceptance criteria (task note "Embed Hunk as a
// panel inside Pi"): saving is off by default and a repository's config cannot turn it on; with
// `--save-notes` a `c` note comes back after the process is killed, at its line, editable, with
// the same id; and it is not shown in a different review of the same repository.

/** Saved review files in one state home's built-in note store. */
function savedReviewFiles(stateHome: string) {
  try {
    return readdirSync(join(stateHome, "hunk", "notes")).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Wait until the built-in store holds one saved review, and return its notes. */
async function waitForSavedNotes(stateHome: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const [file] = savedReviewFiles(stateHome);
    if (file) {
      const saved = JSON.parse(readFileSync(join(stateHome, "hunk", "notes", file), "utf8")) as {
        records: Array<{ note: { id: string; summary: string; source: string } }>;
      };
      return saved.records.map((record) => record.note);
    }
    if (Date.now() > deadline) throw new Error("No saved review appeared.");
    await Bun.sleep(20);
  }
}

describe("saved notes (PTY)", () => {
  test("saving is off by default, and a repository's config cannot turn it on", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const stateHome = harness.createIsolatedConfigHome();
    const fixture = harness.createTwoFileRepoFixture();
    mkdirSync(join(fixture.dir, ".hunk"), { recursive: true });
    writeFileSync(join(fixture.dir, ".hunk", "config.toml"), "save_notes = true\n");
    const launch = () =>
      harness.launchHunk({
        args: ["diff", "--mode", "unified"],
        cwd: fixture.dir,
        cols: 140,
        rows: 30,
        env: { XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
      });

    const first = await launch();
    try {
      await first.waitForText(/alpha\.ts/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(first);
      await harness.pressAndWaitForText(first, "c", /Draft note/, { timeout: 5_000 });
      await first.type("Forget me.");
      await harness.pressAndWaitForText(first, ["ctrl", "s"], /Your note/, { timeout: 5_000 });
      // Quit normally and wait for exit: shutdown waits for pending saves, so any save that
      // was going to happen has landed by now.
      first.sendKey("q");
      expect(await first.waitForExit(10_000)).toBe(true);
      expect(savedReviewFiles(stateHome)).toEqual([]);
    } finally {
      first.close();
    }

    const second = await launch();
    try {
      await second.waitForText(/alpha\.ts/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(second);
      const screen = await second.text({ immediate: true });
      expect(screen).not.toContain("Forget me.");
      expect(savedReviewFiles(stateHome)).toEqual([]);
    } finally {
      second.close();
    }
  });

  test("with --save-notes a note survives a killed process and stays with its review", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const stateHome = harness.createIsolatedConfigHome();
    const fixture = harness.createTwoFileRepoFixture();
    const launch = (args: string[]) =>
      harness.launchHunk({
        args: [...args, "--mode", "unified", "--save-notes"],
        cwd: fixture.dir,
        cols: 140,
        rows: 30,
        env: { XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
      });

    const first = await launch(["diff"]);
    let noteId = "";
    try {
      await first.waitForText(/alpha\.ts/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(first);
      await harness.pressAndWaitForText(first, "c", /Draft note/, { timeout: 5_000 });
      await first.type("Keep me.");
      await harness.pressAndWaitForText(first, ["ctrl", "s"], /Your note/, { timeout: 5_000 });
      const [saved] = await waitForSavedNotes(stateHome);
      expect(saved).toMatchObject({ source: "user", summary: "Keep me." });
      noteId = saved!.id;
      // A crash, not a quit: nothing runs after the save already on disk.
      process.kill((first as unknown as { pty: { pid: number } }).pty.pid, "SIGKILL");
    } finally {
      first.close();
    }

    const second = await launch(["diff"]);
    try {
      await second.waitForText(/Keep me\./, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(second);
      let screen = await second.text({ immediate: true });
      expect(screen).toContain("Your note");
      for (let step = 0; step < 4 && !screen.includes("● Your note"); step += 1) {
        second.sendKey("j");
        await second.waitIdle();
        screen = await second.text({ immediate: true });
      }
      await harness.pressAndWaitForText(second, ["shift", "e"], /Edit note -/, {
        timeout: 5_000,
      });
      await second.type(" Edited.");
      await harness.pressAndWaitForSnapshot(
        second,
        ["ctrl", "s"],
        (text) => !text.includes("Edit note -") && text.includes("Edited."),
        5_000,
      );
      const deadline = Date.now() + 5_000;
      let notes = await waitForSavedNotes(stateHome);
      while (!notes[0]?.summary.includes("Edited.") && Date.now() < deadline) {
        await Bun.sleep(20);
        notes = await waitForSavedNotes(stateHome);
      }
      expect(notes).toEqual([expect.objectContaining({ id: noteId, source: "user" })]);
    } finally {
      second.close();
    }

    const otherReview = await launch(["show", "HEAD"]);
    try {
      await otherReview.waitForText(/alpha\.ts/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(otherReview);
      expect(await otherReview.text({ immediate: true })).not.toContain("Keep me.");
    } finally {
      otherReview.close();
    }
  });

  // Source: Antonio's step-8 rule — deleting a branch's worktree retires its saved notes with no
  // setting. Passes when a note saved in a linked worktree is removed from the state directory
  // the next time a review opens with saving on after `git worktree remove`.
  test("removing a worktree retires its saved notes at the next launch", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const stateHome = harness.createIsolatedConfigHome();
    const fixture = harness.createTwoFileRepoFixture();
    const worktree = join(harness.createIsolatedConfigHome(), "feature");
    const git = (...args: string[]) =>
      expect(Bun.spawnSync(["git", ...args], { cwd: fixture.dir }).exitCode).toBe(0);
    git("add", ".");
    git("commit", "-qm", "work");
    git("worktree", "add", "-q", worktree, "-b", "feature");
    writeFileSync(join(worktree, "alpha.ts"), "export const alpha = 3;\n");
    const launch = (cwd: string) =>
      harness.launchHunk({
        args: ["diff", "--mode", "unified", "--save-notes"],
        cwd,
        cols: 140,
        rows: 30,
        env: { XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
      });

    const inWorktree = await launch(worktree);
    try {
      await inWorktree.waitForText(/alpha\.ts/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(inWorktree);
      await harness.pressAndWaitForText(inWorktree, "c", /Draft note/, { timeout: 5_000 });
      await inWorktree.type("Feature note.");
      await harness.pressAndWaitForText(inWorktree, ["ctrl", "s"], /Your note/, {
        timeout: 5_000,
      });
      await waitForSavedNotes(stateHome);
    } finally {
      inWorktree.close();
    }
    expect(savedReviewFiles(stateHome)).toHaveLength(1);

    git("worktree", "remove", "--force", worktree);
    writeFileSync(join(fixture.dir, "alpha.ts"), "export const alpha = 4;\n");
    const inMain = await launch(fixture.dir);
    try {
      await inMain.waitForText(/alpha\.ts/, { timeout: 20_000 });
      const deadline = Date.now() + 5_000;
      while (savedReviewFiles(stateHome).length > 0 && Date.now() < deadline) await Bun.sleep(20);
      expect(savedReviewFiles(stateHome)).toEqual([]);
    } finally {
      inMain.close();
    }
  });
});
