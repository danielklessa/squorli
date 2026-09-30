import { lookUpPage, lookUpYoutubeVideo, type LinkImage } from "@squorli/link-preview";
import { previewLinks, youtubeVideoOf, type LinkPreview } from "@squorli/protocol";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";
import type { StorageMeter } from "../limits";
import type { Db } from "../db";
import { messages } from "../db/schema";

/**
 * Link previews (docs/features/link-previews.md). After a message is stored or edited, the server looks its links up in
 * the background and then sends the message again (`message.update`) with `previews`; sending never waits for a foreign
 * host. What is kept per message (`messages.previews`): the previews found and, as `removed`, the ones the author took
 * away, so an edit does not bring them back. Pictures are copied to DATA_DIR/previews and served from here: a reader's
 * client never talks to the linked host. A YouTube video gets its title from YouTube's oEmbed address and its picture from
 * YouTube's image host, both fixed addresses; the player itself is only loaded by a reader who presses play.
 */
export type StoredPreview = LinkPreview & { removed?: boolean };
type Log = { warn: (o: object, msg: string) => void };

const CACHE_MS = 60 * 60_000;
const CACHE_MAX = 500;
/** Lookups at the same time for the whole server, and new links per member and minute: a flood of links gets no previews, nothing else. */
const CONCURRENT = 4;
const PER_USER_PER_MINUTE = 12;
const SWEEP_MS = 6 * 3_600_000;
const SWEEP_MIN_AGE_MS = 3_600_000;
export const PREVIEW_FILE_RE = /^[0-9a-f]{32}\.(png|jpg|webp|gif)$/;
const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
export const previewImageMime = (file: string) => IMAGE_MIME[file.slice(file.lastIndexOf(".") + 1)] ?? "application/octet-stream";

/** What clients get: without the removed ones and without the marker. */
export function visiblePreviews(stored: StoredPreview[] | null): LinkPreview[] {
  return (stored ?? []).filter((p) => !p.removed).map(({ removed: _removed, ...p }) => p);
}

export class LinkPreviews {
  readonly dir: string;
  private readonly cache = new Map<string, { at: number; preview: LinkPreview | null }>();
  private readonly inFlight = new Map<string, Promise<LinkPreview | null>>();
  private readonly perMessage = new Map<string, Promise<unknown>>();
  private readonly byUser = new Map<string, number[]>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private sweeper: ReturnType<typeof setInterval> | null = null;

  /** The storage quota (docs/features/limits.md): a picture that does not fit is left out, the preview keeps its texts. */
  meter: StorageMeter | null = null;

  constructor(private readonly db: Db, private readonly config: Config, private readonly log: Log, private readonly onChange: (row: typeof messages.$inferSelect) => Promise<void>) {
    this.dir = join(config.DATA_DIR, "previews");
  }

  get enabled(): boolean { return this.config.LINK_PREVIEWS; }

  async init(): Promise<void> {
    if (!this.enabled) return;
    await mkdir(this.dir, { recursive: true });
    this.sweeper = setInterval(() => { void this.sweep().catch((err) => this.log.warn({ err }, "link preview sweep")); }, SWEEP_MS);
    this.sweeper.unref();
  }
  close(): void { if (this.sweeper) clearInterval(this.sweeper); }

  /** One thing at a time per message: a lookup, a second edit and a removal must not overwrite each other. */
  private enqueue<T>(messageId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.perMessage.get(messageId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.perMessage.set(messageId, next);
    void next.catch(() => {}).finally(() => { if (this.perMessage.get(messageId) === next) this.perMessage.delete(messageId); });
    return next;
  }

  /** After a message was stored or its text changed. Returns at once; the result arrives as `message.update`. */
  schedule(messageId: string): void {
    if (!this.enabled) return;
    void this.enqueue(messageId, () => this.reconcile(messageId)).catch((err) => this.log.warn({ err, messageId }, "link preview"));
  }

  private async reconcile(messageId: string): Promise<void> {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!row) return;
    const links = previewLinks(row.content);
    const before = row.previews ?? [];
    const kept = new Map(before.map((p) => [p.url, p]));
    const fresh = links.filter((url) => !kept.has(url));
    const allowed = fresh.filter(() => this.mayLookUp(row.authorId));
    const found = await Promise.all(allowed.map((url) => this.lookUp(url)));
    const byUrl = new Map(allowed.map((url, i) => [url, found[i] ?? null]));
    const after: StoredPreview[] = [];
    for (const url of links) { const p = kept.get(url) ?? byUrl.get(url); if (p) after.push(p); }
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    // Only if the text is still the one we read: a later edit has its own turn in the queue.
    const [updated] = await this.db.update(messages).set({ previews: after }).where(and(eq(messages.id, messageId), eq(messages.content, row.content))).returning();
    if (updated && JSON.stringify(visiblePreviews(after)) !== JSON.stringify(visiblePreviews(before))) await this.onChange(updated);
  }

  /** The author takes a preview away. false = the message has no such preview. */
  remove(messageId: string, url: string): Promise<boolean> {
    return this.enqueue(messageId, async () => {
      const [row] = await this.db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
      const stored = row?.previews ?? [];
      if (!row || !stored.some((p) => p.url === url && !p.removed)) return false;
      const [updated] = await this.db.update(messages).set({ previews: stored.map((p) => (p.url === url ? { ...p, removed: true } : p)) }).where(eq(messages.id, messageId)).returning();
      if (updated) await this.onChange(updated);
      return !!updated;
    });
  }

  private mayLookUp(userId: string): boolean {
    const now = Date.now();
    const recent = (this.byUser.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= PER_USER_PER_MINUTE) { this.byUser.set(userId, recent); return false; }
    recent.push(now);
    this.byUser.set(userId, recent);
    if (this.byUser.size > 5000) for (const [k, v] of this.byUser) if (v.every((t) => now - t >= 60_000)) this.byUser.delete(k);
    return true;
  }

  /** Cached for an hour (also "nothing found"); the same link posted by ten people is one request. */
  private lookUp(url: string): Promise<LinkPreview | null> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.preview);
    const running = this.inFlight.get(url);
    if (running) return running;
    const work = this.limited(() => this.build(url)).catch(() => null).then((preview) => {
      this.cache.delete(url);
      this.cache.set(url, { at: Date.now(), preview });
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      return preview;
    }).finally(() => { this.inFlight.delete(url); });
    this.inFlight.set(url, work);
    return work;
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= CONCURRENT) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    try { return await work(); } finally { this.running--; this.waiting.shift()?.(); }
  }

  /** The lookup itself is the shared package's; here the picture becomes a file of this server. */
  private async build(url: string): Promise<LinkPreview | null> {
    const options = { testOrigin: this.config.LINK_PREVIEW_TEST_ORIGIN };
    const video = youtubeVideoOf(url);
    const found = video ? await lookUpYoutubeVideo(video.videoId, options) : await lookUpPage(url, options);
    if (!found) return null;
    const image = found.image && (this.meter === null || await this.meter.room(found.image.bytes.length)) ? await this.saveImage(found.image) : null;
    return { url, kind: found.kind, siteName: found.siteName, title: found.title, description: found.description, image, ...(video ? { videoId: video.videoId, ...(video.start > 0 ? { start: video.start } : {}) } : {}) };
  }

  /** Named by its content, so the same picture is one file; the type is what the bytes say. */
  private async saveImage(image: LinkImage): Promise<string> {
    const file = `${createHash("sha256").update(image.bytes).digest("hex").slice(0, 32)}.${image.ext}`;
    await writeFile(join(this.dir, file), image.bytes);
    this.meter?.invalidate();
    return `/api/previews/${file}`;
  }

  /** Pictures no message names any more (deleted or edited messages). Young files stay: their message may not be written yet. */
  async sweep(): Promise<number> {
    const rows = await this.db.execute<{ image: string | null }>(sql`select distinct p->>'image' as image from ${messages}, jsonb_array_elements(${messages.previews}) p where ${messages.previews} is not null`);
    const used = new Set([...rows].map((r) => r.image?.replace("/api/previews/", "")).filter(Boolean));
    let removed = 0;
    for (const file of await readdir(this.dir)) {
      if (!PREVIEW_FILE_RE.test(file) || used.has(file)) continue;
      const info = await stat(join(this.dir, file)).catch(() => null);
      if (!info || Date.now() - info.mtimeMs < SWEEP_MIN_AGE_MS) continue;
      await rm(join(this.dir, file), { force: true });
      removed++;
    }
    return removed;
  }
}
