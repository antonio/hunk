/** Run bounded Git and GitHub CLI requests without a shell or credential inspection. */
import { execFile } from "node:child_process";

export type CommandRunner = (
  binary: "git" | "gh",
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<string>;

/** Bound output, runtime and cancellation; never expose subprocess output in failure messages. */
export const runCommand: CommandRunner = (binary, args, cwd, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Review-bundle operation cancelled."));
      return;
    }
    execFile(
      binary,
      [...args],
      {
        cwd,
        signal,
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              binary === "gh"
                ? "GitHub Viewed sync unavailable: gh failed, timed out, or is not authenticated. Local Viewed remains available; refresh to retry."
                : "Cannot validate the bundle comparison in this Git checkout.",
            ),
          );
        } else resolve(stdout);
      },
    );
  });
