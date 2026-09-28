import { rename, rm } from "node:fs/promises";

/** What Windows answers while somebody holds the target open; on Linux a rename over an open file just works. */
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
/** Waits before the second to fifth try. */
export const REPLACE_WAITS_MS = [50, 100, 200, 400];

export type ReplaceFileDeps = {
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};
const defaults: ReplaceFileDeps = {
  rename,
  remove: (path) => rm(path, { force: true }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
const isBusy = (err: unknown) => BUSY.has((err as { code?: string } | null)?.code ?? "");

/**
 * Put a finished temp file in the place of its target (avatar, server icon). Under Windows the rename fails with EPERM,
 * EBUSY or EACCES while the target is open, be it a download of the old picture by this server or a virus scanner. That
 * mostly passes within moments, so it is tried five times with a growing wait. A download can take longer than that:
 * then the target is removed first, which Windows allows under a reader of this server (the reader keeps its file), and
 * the rename tried once more. Any other error, and a failure of that last try, removes the temp file and is thrown.
 */
export async function replaceFile(from: string, to: string, deps: ReplaceFileDeps = defaults): Promise<void> {
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.rename(from, to);
        return;
      } catch (err) {
        if (!isBusy(err)) throw err;
        const wait = REPLACE_WAITS_MS[attempt];
        if (wait === undefined) break;
        await deps.sleep(wait);
      }
    }
    await deps.remove(to);
    await deps.rename(from, to);
  } catch (err) {
    await deps.remove(from).catch(() => {});
    throw err;
  }
}
