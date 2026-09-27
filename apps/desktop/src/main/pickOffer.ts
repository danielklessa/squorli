import type { ScreenPickRequest, ScreenSource } from "@squorli/web/platform/bridge";

type Kind = ScreenSource["kind"];
/** A source as the list names it; its thumbnail comes on its own. */
export type ListedSource = Omit<ScreenSource, "thumbnail" | "pending">;

/**
 * What one request of the screen share offers while it fills up (displayMedia.ts). Pure (tested), no Electron import.
 * The client is asked at once, with nothing, so its dialog opens without a wait (user's wish, 28 September 2026: measured on
 * the user's computer with 21 sources, the list takes 0.4 s, the thumbnails of the screens as long, those of the windows
 * 3.4 s). The list follows, then the thumbnails per kind of source as they are done, and only when the client asked for them.
 */
export class PickOffer {
  private listing = true;
  private sources: ListedSource[] = [];
  private readonly thumbnails = new Map<string, string>();
  /** Kinds of source whose thumbnails are being made. */
  private readonly busy = new Set<Kind>();

  constructor(readonly requestId: number) {}

  /** Whether the list went out: only then an update says something new. */
  get listed(): boolean { return !this.listing; }

  /** The list is known (empty = nothing to offer, or the listing failed). */
  list(sources: ListedSource[]): void { this.sources = sources; this.listing = false; }

  /** The thumbnails of this kind are being made. */
  making(kind: Kind): void { this.busy.add(kind); }

  /** They are done: data URLs by source id; a source without one keeps its symbol. */
  made(kind: Kind, thumbnails: ReadonlyMap<string, string>): void {
    for (const [id, url] of thumbnails) this.thumbnails.set(id, url);
    this.busy.delete(kind);
  }

  /** The request as it stands now: what goes to the client. */
  state(): ScreenPickRequest {
    return {
      requestId: this.requestId, listing: this.listing,
      sources: this.sources.map((s) => { const thumbnail = this.thumbnails.get(s.id) ?? ""; return { ...s, thumbnail, pending: thumbnail === "" && this.busy.has(s.kind) }; }),
    };
  }
}
