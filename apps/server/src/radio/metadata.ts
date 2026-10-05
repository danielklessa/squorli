import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { IcyReader, decodeIcyText, isStationName, streamTitleOf } from "./icy";
import { checkHost, publicLookup } from "./resolve";

/** A voice channel whose radio somebody is listening to right now. */
export type RadioTarget = { channelId: string; streamUrl: string; stationName: string };
type Log = { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };

const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 4;
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];

type Feed = { url: string; abort: AbortController; title: string | null; names: Set<string>; icyName: string | null; failures: number; retry: ReturnType<typeof setTimeout> | null; unsupported: boolean };

/**
 * "Now playing" for the web radio. Browsers cannot read a stream's ICY metadata from an <audio> element, so the server
 * reads it: one connection per stream address, **only while a member sits in a voice channel playing it**, the audio is
 * thrown away and only the titles are kept and handed to `publish` (WS event `radio.meta`). That costs the server the
 * stream's bitrate per listened station (not per listener). Stations without ICY metadata, behind an internal address
 * (same guard as for playlists) or unreachable simply have no title; the radio itself does not depend on any of this.
 */
export class RadioMetadata {
  private readonly feeds = new Map<string, Feed>();
  /** channelId -> what it listens to; the title a channel shows is its feed's title. */
  private channels = new Map<string, RadioTarget>();
  private closed = false;

  constructor(private readonly publish: (channelId: string, title: string | null) => void, private readonly log: Log) {}

  titleOf(channelId: string): string | null {
    const target = this.channels.get(channelId);
    return target ? this.visibleTitle(this.feeds.get(target.streamUrl) ?? null) : null;
  }

  /** The complete list of listened channels; feeds are opened and closed to match, channels that changed are told. */
  sync(targets: RadioTarget[]): void {
    if (this.closed) return;
    const before = new Map([...this.channels.keys()].map((id) => [id, this.titleOf(id)] as const));
    this.channels = new Map(targets.map((t) => [t.channelId, t]));
    const wanted = new Map<string, Set<string>>();
    for (const t of targets) wanted.set(t.streamUrl, (wanted.get(t.streamUrl) ?? new Set()).add(t.stationName));
    for (const [url, feed] of this.feeds) if (!wanted.has(url)) { this.stop(feed); this.feeds.delete(url); }
    for (const [url, names] of wanted) {
      const feed = this.feeds.get(url);
      if (feed) { feed.names = names; continue; }
      const fresh: Feed = { url, abort: new AbortController(), title: null, names, icyName: null, failures: 0, retry: null, unsupported: false };
      this.feeds.set(url, fresh);
      void this.run(fresh);
    }
    for (const id of new Set([...before.keys(), ...this.channels.keys()])) {
      const now = this.titleOf(id);
      if ((before.get(id) ?? null) !== now) this.publish(id, now);
    }
  }

  close(): void {
    this.closed = true;
    for (const feed of this.feeds.values()) this.stop(feed);
    this.feeds.clear(); this.channels.clear();
  }

  private stop(feed: Feed) {
    if (feed.retry) clearTimeout(feed.retry);
    feed.retry = null;
    feed.abort.abort();
  }

  private visibleTitle(feed: Feed | null): string | null {
    return feed?.title && !isStationName(feed.title, [...feed.names, feed.icyName]) ? feed.title : null;
  }

  private setTitle(feed: Feed, title: string | null) {
    const before = this.visibleTitle(feed);
    feed.title = title;
    const now = this.visibleTitle(feed);
    if (before === now) return;
    for (const t of this.channels.values()) if (t.streamUrl === feed.url) this.publish(t.channelId, now);
  }

  private alive(feed: Feed): boolean {
    return !this.closed && this.feeds.get(feed.url) === feed && !feed.abort.signal.aborted;
  }

  private async run(feed: Feed): Promise<void> {
    try {
      await this.read(feed);
    } catch (err) {
      if (this.alive(feed)) this.log.info({ url: feed.url, err: err instanceof Error ? err.message : String(err) }, "radio metadata: connection lost");
    }
    if (!this.alive(feed) || feed.unsupported) return;
    // The stream ended or failed: the title is stale. Try again, slower each time.
    this.setTitle(feed, null);
    const delay = RETRY_MS[Math.min(feed.failures, RETRY_MS.length - 1)]!;
    feed.failures++;
    feed.retry = setTimeout(() => { feed.retry = null; if (this.alive(feed)) void this.run(feed); }, delay);
  }

  private async read(feed: Feed): Promise<void> {
    // One controller per attempt: the feed being dropped, the connect timeout and the idle watchdog all end it.
    const attempt = new AbortController();
    const dropped = () => attempt.abort();
    feed.abort.signal.addEventListener("abort", dropped, { once: true });
    let watchdog: ReturnType<typeof setTimeout> = setTimeout(dropped, CONNECT_TIMEOUT_MS);
    try {
      let url = feed.url;
      let res: IncomingMessage | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // The address comes from a member (or a playlist): never connect to the host itself or its private network.
        if ((await checkHost(new URL(url).hostname)) !== "public") { feed.unsupported = true; return; }
        const r = await openStream(url, attempt.signal, this.log);
        const location = r.statusCode && r.statusCode >= 300 && r.statusCode < 400 ? r.headers.location : undefined;
        if (location) {
          r.destroy();
          url = new URL(location, url).href;
          if (!/^https?:$/.test(new URL(url).protocol)) { feed.unsupported = true; return; }
          continue;
        }
        res = r;
        break;
      }
      if (!res || res.statusCode !== 200) throw new Error(`status ${res?.statusCode ?? "too many redirects"}`);
      const metaint = Number(res.headers["icy-metaint"]);
      if (!Number.isInteger(metaint) || metaint <= 0 || metaint > 1_000_000) {
        // No ICY metadata (or HLS, a web page, ...): nothing to read, and no reason to keep downloading audio.
        feed.unsupported = true;
        this.log.info({ url: feed.url }, "radio metadata: station sends none");
        return;
      }
      // Between songs stations often send their own name (icy-name) as the title.
      const icyName = res.headers["icy-name"];
      feed.icyName = typeof icyName === "string" ? icyName : null;
      const parser = new IcyReader(metaint, (block) => { feed.failures = 0; this.setTitle(feed, streamTitleOf(decodeIcyText(block))); });
      for await (const chunk of res as AsyncIterable<Buffer>) {
        clearTimeout(watchdog);
        watchdog = setTimeout(dropped, IDLE_TIMEOUT_MS);
        parser.push(chunk);
      }
    } finally {
      clearTimeout(watchdog);
      feed.abort.signal.removeEventListener("abort", dropped);
      attempt.abort(); // closes whatever is still open (a refused, redirected or finished response)
    }
  }
}

/**
 * Not `fetch`: stations answer an `Icy-MetaData` request with sloppy HTTP often enough (bare line feeds in the header,
 * seen at a large German CDN) that the strict parser refuses them; Node's lenient parser reads them. The strict parser
 * goes first and the lenient one is tried only after it refused the answer (an `HPE_*` error; security audit of
 * 5 October 2026, L-18): this process is the client here, the host was checked and the address pinned (`publicLookup`), so
 * all a sloppy station can do is shape the title it sends; still, the lenient parser reads only what the strict one
 * would not, and the log says which stations needed it.
 */
export async function openStream(url: string, signal: AbortSignal, log?: Log): Promise<IncomingMessage> {
  try {
    return await openStreamWith(url, signal, false);
  } catch (err) {
    if (!isParserRefusal(err) || signal.aborted) throw err;
    log?.info({ url, code: (err as { code?: string }).code }, "radio metadata: sloppy HTTP answer, read with the lenient parser");
    return openStreamWith(url, signal, true);
  }
}
/** Node's parser errors (`HPE_*`: a bare line feed, an invalid header character, ...), as opposed to a refused connection or a timeout. */
export const isParserRefusal = (err: unknown): boolean => typeof (err as { code?: unknown })?.code === "string" && (err as { code: string }).code.startsWith("HPE_");
function openStreamWith(url: string, signal: AbortSignal, lenient: boolean): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
      method: "GET", signal, insecureHTTPParser: lenient, lookup: publicLookup,
      headers: { "icy-metadata": "1", "user-agent": "Squorli", accept: "*/*" },
    }, resolve);
    req.on("error", reject);
    req.end();
  });
}
