import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Operator limits (docs/features/limits.md, 30 September 2026): generic settings for whoever runs a server for other people
 * and wants to bound what it uses. Every limit is off when its variable is unset; nothing here knows why a limit exists.
 */

/** How long a measured storage total is trusted before the folders are walked again. */
export const STORAGE_CACHE_MS = 10_000;

export type StorageSources = {
  /** The attachments' bytes as the database records them (sum of attachments.size); the files are not walked for that. */
  attachmentsBytes: () => Promise<number>;
  /** Folders walked for their files' sizes (previews, reports, avatars), missing ones count as empty. */
  dirs: string[];
  /** Single files (the server icon), a missing one counts as empty. */
  files: string[];
};

/** Bytes of every regular file below `dir`, 0 for a folder that does not exist. */
export async function walkBytes(dir: string): Promise<number> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  let total = 0;
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) total += await walkBytes(path);
    else if (e.isFile()) total += await stat(path).then((s) => s.size).catch(() => 0);
  }
  return total;
}

async function fileBytes(path: string): Promise<number> {
  return stat(path).then((s) => (s.isFile() ? s.size : 0)).catch(() => 0);
}

/**
 * The storage quota (STORAGE_QUOTA_MB): the bytes of every file this server keeps for its members against one upper bound.
 * `used()` is measured at most every STORAGE_CACHE_MS; a store that wrote or removed something calls `invalidate()`, and a
 * store that is about to write asks `room(bytes)`. Without a quota every question answers "yes" and nothing is measured.
 */
export class StorageMeter {
  readonly quotaBytes: number | null;
  private cached: { at: number; bytes: number } | null = null;
  private measuring: Promise<number> | null = null;

  constructor(quotaMb: number | undefined, private readonly sources: StorageSources, private readonly now: () => number = Date.now) {
    this.quotaBytes = quotaMb === undefined ? null : Math.round(quotaMb * 1024 * 1024);
  }

  /** Bytes in use, measured or from the short cache. */
  used(): Promise<number> {
    if (this.cached && this.now() - this.cached.at < STORAGE_CACHE_MS) return Promise.resolve(this.cached.bytes);
    if (!this.measuring) {
      this.measuring = this.measure().then((bytes) => { this.cached = { at: this.now(), bytes }; return bytes; }).finally(() => { this.measuring = null; });
    }
    return this.measuring;
  }

  /** Whether `bytes` more (or fewer, negative) still fit under the quota; always true without one. */
  async room(bytes = 0): Promise<boolean> {
    if (this.quotaBytes === null) return true;
    return (await this.used()) + bytes <= this.quotaBytes;
  }

  /** Something was written or removed: the next question measures again. */
  invalidate(): void { this.cached = null; }

  private async measure(): Promise<number> {
    const [attachments, dirs, files] = await Promise.all([
      this.sources.attachmentsBytes().catch(() => 0),
      Promise.all(this.sources.dirs.map(walkBytes)),
      Promise.all(this.sources.files.map(fileBytes)),
    ]);
    return attachments + dirs.reduce((a, b) => a + b, 0) + files.reduce((a, b) => a + b, 0);
  }
}

/**
 * How many voice seats are taken (VOICE_SEATS_MAX): everyone the presence list seats plus every participant LiveKit still
 * holds that the list does not know (a client between two rooms, a bot), each person once. `except` is the one asking for
 * a seat: their own seat does not count against them (a channel switch, a reconnect). `livekit` null = LiveKit did not
 * answer; the presence list decides alone then.
 */
export function seatsTaken(seated: readonly { userId: string }[], livekit: ReadonlyMap<string, string> | null, except: string | null = null): number {
  const people = new Set<string>();
  for (const s of seated) people.add(s.userId);
  if (livekit) for (const identity of livekit.keys()) people.add(identity);
  if (except !== null) people.delete(except);
  return people.size;
}

/** Whether one more may sit down: `max` undefined = unlimited. */
export function seatsFull(taken: number, max: number | undefined): boolean {
  return max !== undefined && taken >= max;
}

/** Whether one more member may join (MEMBER_MAX): `max` undefined = unlimited. */
export function membersFull(count: number, max: number | undefined): boolean {
  return max !== undefined && count >= max;
}
