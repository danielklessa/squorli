import { checkHost, isInternalAddress, publicLookup, safeGet } from "@squorli/link-preview";
import { twitchChannelOf, youtubeVideoOf } from "@squorli/protocol";
import { firstPlaylistEntry, isHlsPlaylist, isPlaylistUrl } from "./playlist";

export type ResolveError = "unreachable" | "empty_playlist" | "forbidden_host";
export type ResolveResult = { ok: true; streamUrl: string } | { ok: false; error: ResolveError };

const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;
const MAX_HOPS = 4; // playlists that name another playlist (safeGet follows up to five redirects of each on its own)

// The address rules (which hosts a fetch on behalf of a member may reach) are shared with the link previews.
export { checkHost, isInternalAddress, publicLookup };

/** Audio types that are not a playlist: some stations serve the stream itself under a playlist name. */
const AUDIO = /^audio\/(?!x-mpegurl|mpegurl|x-scpls)/i;

/**
 * What clients should play for a station's address. A plain stream address is returned as it is (no request to it; its host
 * must not be an internal address, because every listener's client would be told to ask it: a member with CONTROL_RADIO
 * could point the whole channel at the router or a machine in somebody's LAN, security audit 2 October 2026, S14; a name that
 * does not resolve is let through as before); a playlist is fetched (public hosts only, short timeout, small body) and its first entry taken.
 */
export async function resolveStreamUrl(stationUrl: string): Promise<ResolveResult> {
  // A Twitch channel page is not played as audio: clients show Twitch's player for it. One spelling, no request.
  const twitch = twitchChannelOf(stationUrl);
  if (twitch) return { ok: true, streamUrl: `https://www.twitch.tv/${twitch}` };
  // The same for a YouTube video (the start offset of the address becomes the playback state, routes/radio.ts).
  const youtube = youtubeVideoOf(stationUrl);
  if (youtube) return { ok: true, streamUrl: `https://www.youtube.com/watch?v=${youtube.videoId}` };
  let url = stationUrl;
  let playlist = isPlaylistUrl(url);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!playlist) return (await checkHost(new URL(url).hostname)) === "internal" ? { ok: false, error: "forbidden_host" } : { ok: true, streamUrl: url };
    // The check here only tells "forbidden" from "unreachable" for the member; the guard is safeGet's lookup, which checks
    // the address it actually connects to (at every redirect too), so a name that resolves elsewhere a moment later
    // (DNS rebinding) reaches nothing internal (25 September 2026; before, a plain fetch resolved the name a second time).
    const host = await checkHost(new URL(url).hostname);
    if (host !== "public") return { ok: false, error: host === "internal" ? "forbidden_host" : "unreachable" };
    const got = await safeGet(url, { accept: "*/*", maxBytes: () => MAX_BYTES, cut: () => true, enough: (type) => AUDIO.test(type), timeoutMs: TIMEOUT_MS });
    if (!got) return { ok: false, error: "unreachable" };
    url = got.url;
    if (AUDIO.test(got.contentType)) return { ok: true, streamUrl: url };
    const text = got.body.toString("utf8");
    if (isHlsPlaylist(text)) return { ok: true, streamUrl: url };
    const entry = firstPlaylistEntry(text, url);
    if (!entry) return { ok: false, error: "empty_playlist" };
    url = entry;
    playlist = isPlaylistUrl(url);
  }
  if (playlist) return { ok: false, error: "unreachable" };
  return (await checkHost(new URL(url).hostname)) === "internal" ? { ok: false, error: "forbidden_host" } : { ok: true, streamUrl: url };
}
