# packages/link-preview – `@squorli/link-preview`

Part of the project description. The entry point is the root [AGENTS.md](../../AGENTS.md) (commands, definition of done, cross-cutting conventions, the map of all documentation in its section 0). What the feature is, the user's wishes and what was checked: `docs/features/link-previews.md`.

**This whole package is the source of a byte-identical copy in `../squorli-directory/packages/link-preview/`** (the directory looks links up for senders of direct messages who use a browser). Sync in the same work step and check with `diff -r`, root `AGENTS.md` section 2a.

## Structure

```
packages/link-preview/   @squorli/link-preview: node only, no dependencies, consumed as TypeScript source (no build step)
  src/addresses.ts       `isInternalAddress` (BlockList of private, loopback, link-local, CGNAT, multicast, benchmark, documentation and IETF protocol ranges and, for IPv6, `::/96` (loopback and the IPv4-compatible spelling), 6to4, Teredo, both NAT64 prefixes and site-local; IPv4-mapped spelling included; `addresses.test.ts`, 4 tests), `checkHost` (every address of a name must be public), `publicLookup` (DNS hook for http(s).request: the address actually connected to must be public)
  src/fetch.ts           `safeGet`: one guarded GET: http(s) only, no credentials in the address, `checkHost` + `publicLookup` at every hop, at most 5 redirects followed by hand, one deadline (6 s), byte caps per content type counted after decompression (gzip, deflate, brotli), `cut` (a page is cut at its cap, a picture over its cap is none), `enough` (stop at `</head>`); `testOrigin` exempts one origin, for tests only
  src/parse.ts           pure, tested: `parsePageMeta` (Open Graph, Twitter card, description, title; head only, no scripts or comments), `decodeEntities`, `cleanText` (one line, no control or bidi characters, cut), `decodeHtml` (charset from the header, then the page, then utf-8), `sniffImage` (PNG, JPEG, WebP, GIF by their bytes; no SVG)
  src/youtube.ts         `lookupYoutube` / `readOembed`: a video's title and embeddability from YouTube's oEmbed address (also used by the web radio)
  src/lookup.ts          `lookUpPage(url)` and `lookUpYoutubeVideo(videoId)` -> `LinkLookup` (kind, site name, title, description, the picture as bytes with its type) or null = no preview. The caller recognises a YouTube link (the protocol's `youtubeVideoOf`; this package must not import the protocol package, whose chat part the directory does not have) and decides what becomes of the picture
```

## Conventions

- **Security first:** nothing here may follow a redirect by itself, skip `checkHost` for a hop, read an answer without a cap or trust a content type for what bytes are. A change to `addresses.ts` or `fetch.ts` needs a run of the chat smoke test with `LINK_PREVIEW_TEST_ORIGIN` (it checks that a redirect to another local port is never asked) and of `playlist.test.ts` in the server (it pins the address rules).
- No dependencies and no import of `@squorli/protocol`, so the copy in the directory repo stays self-contained.
