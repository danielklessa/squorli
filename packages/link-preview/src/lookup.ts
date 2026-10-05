import { safeGet } from "./fetch";
import { parseHead, type HeadParser } from "./headParser";
import { cleanText, sniffImage, type ImageType } from "./parse";
import { lookupYoutube } from "./youtube";

/**
 * What there is to show for a link: the text a page says about itself and, as bytes, one picture. Whoever calls this
 * decides what becomes of the picture (the chat server keeps a copy and serves it, a client encrypts it for a direct
 * message); nobody who only READS a preview ever contacts the linked host. null = no preview, the link stays a link.
 */
export type LinkImage = ImageType & { bytes: Buffer };
export type LinkLookup = { kind: "page" | "youtube"; siteName: string | null; title: string | null; description: string | null; image: LinkImage | null };
export type LookupOptions = {
  testOrigin?: string | undefined;
  /** Reads the page's head in a worker thread with a time budget (headParser.ts); none = on the calling thread. */
  parser?: HeadParser | undefined;
};

export const HTML_MAX_BYTES = 512 * 1024;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const isHtml = (type: string) => /^(text\/html|application\/xhtml\+xml)\b/.test(type);
const isImage = (type: string) => /^image\/(png|jpeg|webp|gif)\b/.test(type);

const get = (url: string, accept: string, options: LookupOptions) => safeGet(url, {
  accept, testOrigin: options.testOrigin,
  maxBytes: (type) => (isHtml(type) ? HTML_MAX_BYTES : isImage(type) ? IMAGE_MAX_BYTES : 0),
  cut: isHtml,
  enough: (type, latest) => isHtml(type) && latest.includes("</head>"),
});

/** The picture's type is what its bytes say, whatever the host calls it. */
function imageOf(bytes: Buffer): LinkImage | null {
  const type = sniffImage(bytes);
  return type && bytes.length <= IMAGE_MAX_BYTES ? { ...type, bytes } : null;
}

async function fetchImage(address: string, options: LookupOptions): Promise<LinkImage | null> {
  const res = await get(address, "image/webp,image/png,image/jpeg,image/gif", options);
  return res && isImage(res.contentType) ? imageOf(res.body) : null;
}

/** A web page (or, for a link straight to a picture, that picture). A page without a title has no preview. */
export async function lookUpPage(url: string, options: LookupOptions = {}): Promise<LinkLookup | null> {
  const res = await get(url, "text/html,application/xhtml+xml;q=0.9,image/*;q=0.5", options);
  if (!res) return null;
  if (isImage(res.contentType)) {
    const image = imageOf(res.body);
    return image ? { kind: "page", siteName: null, title: null, description: null, image } : null;
  }
  const meta = options.parser ? await options.parser.parse(res.body, res.contentType, res.url) : parseHead(res.body, res.contentType, res.url);
  if (!meta?.title) return null;
  let siteName = meta.siteName;
  if (!siteName) { try { siteName = cleanText(new URL(res.url).hostname.replace(/^www\./, ""), 100); } catch { siteName = null; } }
  return { kind: "page", siteName, title: meta.title, description: meta.description, image: meta.imageUrl ? await fetchImage(meta.imageUrl, options) : null };
}

/**
 * A YouTube video by its id (the caller recognised the link): title from YouTube's oEmbed address, picture from YouTube's
 * image host, both fixed addresses. Private, deleted or not allowed to be embedded = no preview.
 */
export async function lookUpYoutubeVideo(videoId: string, options: LookupOptions = {}): Promise<LinkLookup | null> {
  if (!/^[\w-]{11}$/.test(videoId)) return null;
  const info = await lookupYoutube(videoId);
  if (!info.ok) return null;
  return { kind: "youtube", siteName: "YouTube", title: cleanText(info.title ?? undefined, 300), description: null, image: await fetchImage(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, options) };
}
