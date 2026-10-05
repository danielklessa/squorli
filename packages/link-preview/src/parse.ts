/**
 * What a web page says about itself, read from the head of its HTML without a parser library: Open Graph (`og:*`), the
 * Twitter card's fields, `<meta name="description">` and `<title>`. Pure and tested. Everything here comes from a foreign
 * host: it ends up as text in React elements (never as HTML), is cut to the protocol's lengths, loses control characters,
 * and the picture's address only counts when it is http(s).
 *
 * The scan is linear in the page's length (security audit of 5 October 2026, H-1): one pass from left to right, index
 * based, no regular expression that has to look ahead for a closing token. The earlier version removed comments and scripts
 * with backtracking expressions and read `<meta ...>` with `[^>]*`; a 512 KB page made only of `<meta ` without a `>` kept
 * the thread busy for 26 s, a single 128 KB tag 12 s in the attribute reader. Now a token whose end is missing (a comment
 * without `-->`, a script without `</script>`, a tag without `>`) ends the head, as a browser treats it too, and the same
 * pages take a few milliseconds. The limits below only bound work that no real page needs.
 */
export type PageMeta = { title: string | null; description: string | null; siteName: string | null; imageUrl: string | null };

/** A tag longer than this is skipped (a real `<meta>` is a few hundred bytes); more `<meta>` tags than this are not read. */
export const TAG_MAX = 16 * 1024;
export const META_MAX = 256;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»",
  bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", euro: "€", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? whole;
  });
}

/** One line of plain text: entities decoded, control characters and line breaks gone, cut to `max`. null = nothing left. */
export function cleanText(raw: string | undefined, max: number): string | null {
  if (!raw) return null;
  const text = decodeEntities(raw).replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ---- The scanner: character classes and bounded, case-insensitive looks at a tag's name. Every helper only moves forward.

const GT = 0x3e, SLASH = 0x2f, EQUALS = 0x3d, DQUOTE = 0x22, SQUOTE = 0x27, BANG = 0x21, QUESTION = 0x3f;
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
const isWordChar = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** indexOf for a lower-case ASCII needle, ignoring the case of letters. Each occurrence of the needle's first character is looked at once. */
function indexOfIgnoreCase(html: string, needle: string, from: number): number {
  const first = needle[0]!;
  let at = from;
  for (;;) {
    at = html.indexOf(first, at);
    if (at < 0) return -1;
    if (html.slice(at, at + needle.length).toLowerCase() === needle) return at;
    at++;
  }
}

/** `<name` at `at`, followed by a boundary (what `\b` meant in the earlier expressions: no word character). */
function tagNameAt(html: string, at: number, name: string): boolean {
  if (html.slice(at + 1, at + 1 + name.length).toLowerCase() !== name) return false;
  const next = html.charCodeAt(at + 1 + name.length);
  return Number.isNaN(next) || !isWordChar(next);
}

/** The first `</name` + optional whitespace + `>` from `from`: where it starts and where it ends (after the `>`); null = not closed. */
function closeTag(html: string, from: number, name: string): { at: number; end: number } | null {
  const needle = `</${name}`;
  let at = from;
  for (;;) {
    at = indexOfIgnoreCase(html, needle, at);
    if (at < 0) return null;
    let i = at + needle.length;
    while (i < html.length && isSpace(html.charCodeAt(i))) i++;
    if (i < html.length && html.charCodeAt(i) === GT) return { at, end: i + 1 };
    at++;
  }
}

/**
 * The attributes of one tag (`<meta ...>` as written), first occurrence of a name wins, names lower-cased. A hand-written
 * scan: a name, `=`, a value in double or single quotes or up to the next whitespace, quote or `>`; an attribute without `=`
 * is skipped, an open quote runs to the end of the tag. Every character is visited once.
 */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = tag.length;
  let i = 1;
  while (i < n && !isSpace(tag.charCodeAt(i)) && tag.charCodeAt(i) !== SLASH && tag.charCodeAt(i) !== GT) i++; // the tag's own name
  while (i < n) {
    while (i < n && (isSpace(tag.charCodeAt(i)) || tag.charCodeAt(i) === SLASH)) i++;
    if (i >= n || tag.charCodeAt(i) === GT) break;
    if (!isLetter(tag.charCodeAt(i))) { i++; continue; }
    const nameStart = i;
    while (i < n) { const c = tag.charCodeAt(i); if (isSpace(c) || c === EQUALS || c === SLASH || c === GT) break; i++; }
    const name = tag.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < n && isSpace(tag.charCodeAt(j))) j++;
    if (j >= n || tag.charCodeAt(j) !== EQUALS) continue; // a bare attribute: nothing to record, the scan goes on at `i`
    j++;
    while (j < n && isSpace(tag.charCodeAt(j))) j++;
    if (j >= n) break;
    const q = tag.charCodeAt(j);
    let value: string | null = null;
    if (q === DQUOTE || q === SQUOTE) {
      const end = tag.indexOf(tag[j]!, j + 1);
      if (end < 0) break;
      value = tag.slice(j + 1, end);
      i = end + 1;
    } else {
      let k = j;
      while (k < n) { const c = tag.charCodeAt(k); if (isSpace(c) || c === DQUOTE || c === SQUOTE || c === GT) break; k++; }
      if (k > j) value = tag.slice(j, k);
      i = k > j ? k : j + 1;
    }
    if (value !== null && !out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * The head's `<meta>` tags and its `<title>` in one pass. Comments and the contents of script, style and noscript are
 * skipped; `<body` ends the head (what stands in the body is the page's content, not its description of itself). A
 * comment, script or tag without its end ends the head too; a `<title>` without its end has no title.
 */
function scanHead(html: string): { meta: Map<string, string>; title: string | undefined } {
  const meta = new Map<string, string>();
  let title: string | undefined;
  let metas = 0;
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) break;
    const next = html.charCodeAt(lt + 1);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break;
      pos = end + 3;
    } else if (tagNameAt(html, lt, "script") || tagNameAt(html, lt, "style") || tagNameAt(html, lt, "noscript")) {
      const close = closeTag(html, lt + 1, tagNameAt(html, lt, "script") ? "script" : tagNameAt(html, lt, "style") ? "style" : "noscript");
      if (!close) break;
      pos = close.end;
    } else if (tagNameAt(html, lt, "body") && (isSpace(html.charCodeAt(lt + 5)) || html.charCodeAt(lt + 5) === GT)) {
      break;
    } else if (tagNameAt(html, lt, "title")) {
      const tagEnd = html.indexOf(">", lt + 6);
      if (tagEnd < 0) break;
      const close = closeTag(html, tagEnd + 1, "title");
      if (!close) { pos = tagEnd + 1; continue; }
      if (title === undefined) title = html.slice(tagEnd + 1, close.at);
      pos = close.end;
    } else if (tagNameAt(html, lt, "meta")) {
      const tagEnd = html.indexOf(">", lt + 5);
      if (tagEnd < 0) break;
      pos = tagEnd + 1;
      if (tagEnd - lt > TAG_MAX || metas >= META_MAX) continue;
      metas++;
      const a = attributes(html.slice(lt, tagEnd + 1));
      const key = (a.get("property") ?? a.get("name") ?? "").toLowerCase();
      const content = a.get("content");
      if (key && content && !meta.has(key)) meta.set(key, content);
    } else if (isLetter(next) || next === SLASH || next === BANG || next === QUESTION) {
      const tagEnd = html.indexOf(">", lt + 1); // any other tag, also `</head>`, `<!doctype>` and `<?xml ?>`
      if (tagEnd < 0) break;
      pos = tagEnd + 1;
    } else {
      pos = lt + 1; // a `<` in text
    }
  }
  return { meta, title };
}

export function parsePageMeta(html: string, baseUrl: string): PageMeta {
  const { meta, title: titleTag } = scanHead(html);
  const first = (...keys: string[]) => { for (const k of keys) { const v = meta.get(k); if (v?.trim()) return v; } return undefined; };

  let imageUrl: string | null = null;
  const image = first("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src");
  if (image) {
    try { const u = new URL(decodeEntities(image).trim(), baseUrl); if (u.protocol === "http:" || u.protocol === "https:") imageUrl = u.href; } catch { imageUrl = null; }
  }
  return {
    title: cleanText(first("og:title", "twitter:title") ?? titleTag, 300),
    description: cleanText(first("og:description", "twitter:description", "description"), 500),
    siteName: cleanText(first("og:site_name", "application-name"), 100),
    imageUrl,
  };
}

/** The charset a `<meta>` in `top` names (`<meta charset=...>` or `content="text/html; charset=..."`); undefined = none. */
function charsetFromMeta(top: string): string | undefined {
  let pos = 0;
  while (pos < top.length) {
    const lt = indexOfIgnoreCase(top, "<meta", pos);
    if (lt < 0) return undefined;
    const end = top.indexOf(">", lt);
    const tag = top.slice(lt, end < 0 ? top.length : end + 1);
    const found = /charset\s*=\s*["']?([\w.:-]+)/i.exec(tag)?.[1];
    if (found) return found;
    pos = end < 0 ? top.length : end + 1;
  }
  return undefined;
}

/** The charset a page names for itself: the Content-Type header first, then a `<meta charset>` near the top; utf-8 otherwise. */
export function decodeHtml(bytes: Buffer, contentType: string): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
  const fromMeta = charsetFromMeta(bytes.subarray(0, 2048).toString("latin1"));
  for (const label of [fromHeader, fromMeta, "utf-8"]) {
    if (!label) continue;
    try { return new TextDecoder(label).decode(bytes); } catch { /* a label nobody knows: try the next */ }
  }
  return bytes.toString("utf8");
}

export type ImageType = { mime: string; ext: "png" | "jpg" | "webp" | "gif" };
/** The picture's type by its first bytes, whatever the host calls it. No SVG: it is a document, not a picture. */
export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mime: "image/webp", ext: "webp" };
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { mime: "image/gif", ext: "gif" };
  return null;
}
