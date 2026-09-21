import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
setDefaultTimeout(30_000);
afterEach(() => harness.cleanup());

test("Viewed retains a file header, skips its search matches, and reveals on toggle", async () => {
  const fixture = harness.createSearchRepoFixture();
  const session = await harness.launchHunk({
    args: ["diff", "--mode", "unified"],
    cwd: fixture.dir,
    cols: 120,
    rows: 24,
  });
  await session.waitForText('readConfig("first")', { timeout: 15_000 });
  await harness.ensureKeyboardIsLive(session);
  await session.type("V");
  const collapsed = await harness.waitForSnapshot(
    session,
    (text) => text.includes("[x] Viewed"),
    5_000,
  );
  expect(collapsed).toContain("alpha.ts");
  expect(collapsed).not.toContain('readConfig("first")');
  await session.type("/");
  await session.type("readconfig");
  await session.press("enter");
  await harness.waitForSnapshot(session, (text) => text.includes("[1/1] beta.ts"), 5_000);
  await session.type(",");
  await session.type("V");
  await harness.waitForSnapshot(session, (text) => text.includes('readConfig("first")'), 5_000);
});
