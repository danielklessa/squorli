import { describe, expect, it } from "vitest";
import { cleanText, decodeEntities, decodeHtml, META_MAX, parsePageMeta, sniffImage, TAG_MAX } from "./parse";

describe("parsePageMeta", () => {
  it("prefers Open Graph, in any attribute order and quoting", () => {
    const html = `<!doctype html><html><head><title>Nur der Titel</title>
      <meta content="Der OG-Titel &amp; mehr" property="og:title">
      <meta property='og:description' content='Eine Beschreibung&#44; kurz'>
      <meta property=og:site_name content=Beispiel>
      <meta property="og:image" content="/bilder/vorschau.png?a=1&amp;b=2">
      </head><body><meta property="og:title" content="aus dem Body"></body></html>`;
    expect(parsePageMeta(html, "https://example.org/artikel/1")).toEqual({
      title: "Der OG-Titel & mehr", description: "Eine Beschreibung, kurz", siteName: "Beispiel", imageUrl: "https://example.org/bilder/vorschau.png?a=1&b=2",
    });
  });

  it("falls back to the Twitter card, the description and the title tag", () => {
    const html = `<head><title>\n  Titel über\n  zwei Zeilen </title><meta name="description" content="Beschreibung"><meta name="twitter:image" content="https://cdn.example.com/a.jpg"></head>`;
    expect(parsePageMeta(html, "https://example.org/")).toEqual({ title: "Titel über zwei Zeilen", description: "Beschreibung", siteName: null, imageUrl: "https://cdn.example.com/a.jpg" });
  });

  it("ignores scripts, comments and pictures that are not http(s)", () => {
    const html = `<head><script>var t = "<title>falsch</title>";</script><!-- <meta property="og:title" content="auskommentiert"> -->
      <title>Richtig</title><meta property="og:image" content="javascript:alert(1)"></head>`;
    expect(parsePageMeta(html, "https://example.org/")).toEqual({ title: "Richtig", description: null, siteName: null, imageUrl: null });
    expect(parsePageMeta(`<meta property="og:image" content="data:image/png;base64,AAAA">`, "https://example.org/").imageUrl).toBeNull();
  });

  it("a page that says nothing has nothing", () => {
    expect(parsePageMeta("<html><body>Hallo</body></html>", "https://example.org/")).toEqual({ title: null, description: null, siteName: null, imageUrl: null });
  });
});

// ---- Security audit of 5 October 2026, H-1: the parser before it (kept here as the oracle for well-formed pages) read the
// head with backtracking regular expressions; 512 KB of `<meta ` without a `>` took 26 s, a single 128 KB tag 12 s.

const legacyAttrRe = /([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
function legacyAttributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(legacyAttrRe)) { const name = m[1]!.toLowerCase(); if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? ""); }
  return out;
}
function legacyParsePageMeta(html: string, baseUrl: string) {
  const bodyAt = html.search(/<body[\s>]/i);
  const head = (bodyAt >= 0 ? html.slice(0, bodyAt) : html).replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, "");
  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = legacyAttributes(m[0]);
    const key = (a.get("property") ?? a.get("name") ?? "").toLowerCase();
    const content = a.get("content");
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
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

const SIZE = 512 * 1024;
const fill = (piece: string) => piece.repeat(Math.ceil(SIZE / piece.length)).slice(0, SIZE);
const timed = (work: () => unknown) => { const t0 = performance.now(); work(); return performance.now() - t0; };
/** A small deterministic generator (mulberry32), so a failing case can be repeated. */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}

describe("parsePageMeta is linear in the page's length (security audit of 5 October 2026, H-1)", () => {
  it("reads 512 KB of a token whose end never comes in milliseconds, not seconds", () => {
    const cases: Record<string, string> = {
      "meta without >": fill("<meta "),
      "title without >": fill("<title "),
      "comment without end": fill("<!--"),
      "script without end": fill("<script "),
      "one tag of 512 KB": `<meta ${"a".repeat(SIZE)}>`,
      "one tag of 512 KB with attributes": `<meta ${'x="y" '.repeat(SIZE / 6)}>`,
      "closing tags without >": `<script>${fill("</script ")}`,
      "quote never closed": fill('<meta content="'),
      "metas without =": fill("<meta aaaaaaaaaaaaaaaa bbbbbbbbbbbbbb>"),
      "titles": fill("<title>x</title>"),
    };
    for (const [name, html] of Object.entries(cases)) {
      let result: unknown;
      const ms = timed(() => { result = parsePageMeta(html, "https://example.org/"); });
      // 3 ms here; the bound leaves room for a slow CI machine and is still a thousandth of what it was.
      expect(ms, `${name}: ${ms.toFixed(0)} ms`).toBeLessThan(250);
      expect(result).toBeTruthy();
    }
  });

  it("a tag, comment or script without its end ends the head; a title without its end has no title", () => {
    const base = "https://example.org/";
    expect(parsePageMeta('<meta property="og:title" content="a"><meta content="b" property="og:description', base)).toEqual({ title: "a", description: null, siteName: null, imageUrl: null });
    expect(parsePageMeta('<meta property="og:title" content="a"><!-- <meta property="og:description" content="b">', base).description).toBeNull();
    expect(parsePageMeta('<meta property="og:title" content="a"><script><meta property="og:description" content="b">', base).description).toBeNull();
    expect(parsePageMeta('<meta property="og:title" content="a"><style><meta property="og:description" content="b">', base).description).toBeNull();
    const unclosedTitle = parsePageMeta('<title>Nur<meta property="og:description" content="d">', base);
    expect(unclosedTitle.title).toBeNull();
    expect(unclosedTitle.description).toBe("d");
    expect(parsePageMeta("<TITLE>Groß</TITLE  ><META PROPERTY=og:description CONTENT=x>", base)).toEqual({ title: "Groß", description: "x", siteName: null, imageUrl: null });
  });

  it("skips a tag longer than TAG_MAX and reads at most META_MAX meta tags; the title still counts", () => {
    const base = "https://example.org/";
    const big = `<meta property="og:title" content="${"x".repeat(TAG_MAX)}">`;
    expect(parsePageMeta(`${big}<meta property="og:title" content="klein">`, base).title).toBe("klein");
    const many = `${'<meta name="n" content="c">'.repeat(META_MAX)}<meta property="og:title" content="zu spät"><title>Titel</title>`;
    expect(parsePageMeta(many, base).title).toBe("Titel");
  });

  it("answers exactly like the earlier parser for well-formed heads (300 seeded pages)", () => {
    const r = rng(20261005);
    const keys = ["og:title", "og:description", "og:site_name", "og:image", "og:image:secure_url", "twitter:title", "twitter:image", "description", "application-name", "viewport", "robots"];
    const words = ["Titel", "Grüße", "a &amp; b", "x&#44;y", "  Leer  ", "", "Ein längerer Satz mit Umlauten äöü", "/bild.png", "https://cdn.example.net/p.jpg?x=1&amp;y=2", "javascript:alert(1)"];
    const token = ["Titel", "x", "/bild.png", "Beispiel", "og:title"];
    const quote = (r2: ReturnType<typeof rng>, value: string) => { const q = r2.int(3); if (q === 0) return `"${value}"`; if (q === 1) return `'${value}'`; return /^[^\s"'>=]+$/.test(value) ? value : `"${value}"`; };
    const ws = () => r.pick([" ", "  ", "\n  ", "\t"]);
    const name = (n: string) => (r.int(4) === 0 ? n.toUpperCase() : n);
    const meta = () => {
      const key = r.pick(keys);
      const value = r.int(4) === 0 ? r.pick(token) : r.pick(words);
      const attrs = [`${name(r.int(3) === 0 ? "name" : "property")}${r.int(3) === 0 ? " = " : "="}${quote(r, key)}`, `${name("content")}${r.int(3) === 0 ? " = " : "="}${quote(r, value)}`];
      if (r.int(2)) attrs.reverse();
      if (r.int(4) === 0) attrs.push(r.pick(["async", "data-x=1", 'charset="utf-8"', "hidden"]));
      return `<${name("meta")}${ws()}${attrs.join(ws())}${r.pick(["", " ", "/", " /"])}>`;
    };
    const parts: (() => string)[] = [
      meta, meta, meta,
      () => `<title${r.pick(["", " id=t"])}>${r.pick(words)}${r.pick(["", "\n", " "])}</title${r.pick(["", " ", "\n"])}>`,
      () => `<!--${r.pick([" ein Kommentar ", ` <meta property="og:title" content="versteckt"> `, "\n<title>versteckt</title>\n"])}-->`,
      () => `<script${r.pick(["", ' type="text/javascript"', " async"])}>${r.pick(["var a = 1;", 'document.write("<meta property=\\"og:title\\" content=\\"skript\\">");', "<title>skript</title>", "if (a < b) {}"])}</script${r.pick(["", " "])}>`,
      () => `<style>${r.pick(["body { color: red }", 'a::after { content: "<meta>" }'])}</style>`,
      () => `<noscript><meta property="og:title" content="noscript"></noscript>`,
      () => `<link rel="${r.pick(["icon", "stylesheet"])}" href="${r.pick(["/a.css", "https://x/y.png"])}">`,
      () => r.pick(["\n", " Text ohne Tags ", "a < b", "<br>", "</head>", "<base href=\"https://example.org/x/\">"]),
    ];
    for (let i = 0; i < 300; i++) {
      let html = r.pick(["<!doctype html><html><head>", "<html><head>", "", "<?xml version=\"1.0\"?><html><head>"]);
      const n = 1 + r.int(12);
      for (let k = 0; k < n; k++) html += r.pick(parts)();
      if (r.int(2)) html += `</head><body><meta property="og:title" content="im Body"><title>Body</title></body></html>`;
      const base = r.pick(["https://example.org/artikel/1", "http://example.net/", "https://sub.example.com/a/b?c=d"]);
      expect(parsePageMeta(html, base), html).toEqual(legacyParsePageMeta(html, base));
    }
  });

  it("never throws and stays fast on random tag soup (100 seeded pages of 64 KB)", () => {
    const r = rng(5102026);
    const pieces = ["<meta ", "<!--", "<script", "<title", "<style", "<noscript", "<body", ">", "/>", '"', "'", "=", " ", "\n", "content", "property", "og:title", "name", "</script>", "</script", "-->", "</title>", "</style>", "<", "/", "x", "ä", "&amp;", "<meta property=\"og:title\" content=\"ok\">"];
    for (let i = 0; i < 100; i++) {
      let html = "";
      while (html.length < 64 * 1024) html += r.pick(pieces);
      let result: ReturnType<typeof parsePageMeta> | undefined;
      const ms = timed(() => { result = parsePageMeta(html, "https://example.org/"); });
      expect(ms, `page ${i}: ${ms.toFixed(0)} ms`).toBeLessThan(100);
      expect(result).toHaveProperty("title");
    }
  });

  it("decodeHtml finds the charset in a meta tag and is not slowed by a hostile first 2 KB", () => {
    expect(decodeHtml(Buffer.from('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=ISO-8859-1"><title>Gr\xfc\xdfe</title>', "latin1"), "text/html")).toContain("Grüße");
    const hostile = Buffer.from(`${"<meta ".repeat(400)}charset=`, "latin1");
    const ms = timed(() => decodeHtml(hostile, "text/html"));
    expect(ms).toBeLessThan(100);
  });
});

describe("text from a foreign host", () => {
  it("decodes entities, also numeric ones, and leaves unknown ones alone", () => {
    expect(decodeEntities("&lt;b&gt; &#x1F600; &#228; &auml; &unbekannt; &#xD800;")).toBe("<b> 😀 ä ä &unbekannt; ");
  });
  it("becomes one line without control characters and is cut", () => {
    expect(cleanText("a\u0000b\r\n c‮ d", 100)).toBe("a b c d");
    expect(cleanText("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
    expect(cleanText("  \n ", 10)).toBeNull();
  });
});

describe("decodeHtml", () => {
  it("takes the charset from the header, then from the page, then utf-8", () => {
    const latin = Buffer.from("<title>Gr\xfc\xdfe</title>", "latin1");
    expect(decodeHtml(latin, "text/html; charset=ISO-8859-1")).toContain("Grüße");
    expect(decodeHtml(Buffer.concat([Buffer.from("<meta charset=\"windows-1252\">", "latin1"), latin]), "text/html")).toContain("Grüße");
    expect(decodeHtml(Buffer.from("<title>Grüße</title>", "utf8"), "text/html; charset=quatsch")).toContain("Grüße");
  });
});

describe("sniffImage", () => {
  it("knows the four raster types by their bytes and nothing else", () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext).toBe("png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpg");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))?.ext).toBe("webp");
    expect(sniffImage(Buffer.from("GIF89a", "latin1"))?.ext).toBe("gif");
    expect(sniffImage(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\">", "latin1"))).toBeNull();
  });
});
