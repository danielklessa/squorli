import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { checkHost, publicLookup } from "./addresses";

/**
 * One GET to an address a user wrote into a message (docs/features/link-previews.md). Whoever runs it (chat server,
 * directory, the sender's desktop app) must never be made to ask itself or its private network.
 *  - http(s) only; every host, also after each redirect, must resolve to public addresses only (`checkHost`), and the
 *    connection itself may only go to a public address (`publicLookup`, closes the gap between check and connect);
 *  - redirects are followed by hand, at most MAX_REDIRECTS; no cookies, no credentials in the address;
 *  - one deadline for everything, a cap on the bytes read (counted after decompression, so a small answer cannot unfold
 *    into a large one), and the reading stops as soon as `enough` says so (a page's head is all we want).
 * `testOrigin` (LINK_PREVIEW_TEST_ORIGIN, tests only) exempts exactly one origin from the public-address rule.
 */
export type Fetched = { url: string; contentType: string; body: Buffer };
export type FetchOptions = {
  accept: string;
  /** Cap per content type of the answer; 0 = a type nobody asked for, it is not read at all. */
  maxBytes: (contentType: string) => number;
  /** true = an answer longer than the cap is cut there (a page's head is at its start); false = it is no answer (half a picture is none). */
  cut?: (contentType: string) => boolean;
  /**
   * Asked after every piece that arrives, with that piece and the ENOUGH_OVERLAP bytes before it (so a marker of up to that
   * length is seen even when it is split across two pieces); true = stop reading. Everything read so far is not handed over
   * on purpose: searching it again after every piece grew with the square of the answer (security audit of 5 October 2026).
   */
  enough?: (contentType: string, latest: Buffer) => boolean;
  testOrigin?: string | undefined;
  timeoutMs?: number;
};

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 6000;
export const ENOUGH_OVERLAP = 16;
// Sites hand their description to programs that say what they are; a bare library name often gets a consent wall or a 403.
const USER_AGENT = "Mozilla/5.0 (compatible; SquorliBot/1.0; +https://squorli.com)";

function open(url: URL, accept: string, signal: AbortSignal, exempt: boolean): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", signal, ...(exempt ? {} : { lookup: publicLookup }),
      headers: { "user-agent": USER_AGENT, accept, "accept-encoding": "gzip, deflate, br", "accept-language": "de,en;q=0.8" },
    }, resolve);
    req.on("error", reject);
    req.end();
  });
}

function decoded(res: IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  const unpack = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
  if (!unpack) return res;
  res.on("error", (err) => unpack.destroy(err));
  return res.pipe(unpack);
}

async function readCapped(res: IncomingMessage, limit: number, cut: boolean, enough: (latest: Buffer) => boolean): Promise<Buffer | null> {
  const stream = decoded(res);
  const chunks: Buffer[] = [];
  let size = 0;
  let tail: Buffer | null = null;
  try {
    for await (const chunk of stream) {
      const c = chunk as Buffer;
      chunks.push(c); size += c.length;
      if (size > limit) { if (!cut) return null; break; }
      const latest: Buffer = tail ? Buffer.concat([tail, c]) : c;
      if (enough(latest)) break;
      tail = latest.subarray(Math.max(0, latest.length - ENOUGH_OVERLAP));
    }
  } catch (err) {
    // A truncated compressed stream still holds the head we came for.
    if (size === 0 || !(err as { code?: string }).code?.startsWith("Z_")) throw err;
  } finally { stream.destroy(); res.destroy(); }
  return Buffer.concat(chunks, size).subarray(0, limit);
}

/** null = no usable answer (unreachable, not public, not 200, a type nobody asked for, too large, too slow). Never throws. */
export async function safeGet(address: string, options: FetchOptions): Promise<Fetched | null> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let current = address;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const url = new URL(current);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      if (url.username || url.password) return null;
      const exempt = !!options.testOrigin && url.origin === options.testOrigin;
      if (!exempt && (await checkHost(url.hostname)) !== "public") return null;
      const res = await open(url, options.accept, signal, exempt);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.destroy();
        current = new URL(res.headers.location, url).href;
        continue;
      }
      if (status !== 200) { res.destroy(); return null; }
      const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
      const limit = options.maxBytes(contentType);
      const cut = options.cut?.(contentType) ?? false;
      const declared = res.headers["content-encoding"] ? 0 : Number(res.headers["content-length"] ?? 0);
      if (limit <= 0 || (!cut && declared > limit)) { res.destroy(); return null; }
      const body = await readCapped(res, limit, cut, (latest) => options.enough?.(contentType, latest) ?? false);
      return body && body.length > 0 ? { url: url.href, contentType, body } : null;
    }
    return null;
  } catch { return null; }
}
