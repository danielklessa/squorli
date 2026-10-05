/**
 * Which links of a message get a preview (docs/features/link-previews.md). The rules are the Markdown parser's
 * (apps/web/src/markdown.ts, which takes `readBareUrl` from here): a bare http(s) address, also as the target of
 * `[text](address)`, outside code and not behind a backslash (scan.ts). An address in angle brackets, `<https://...>`, is
 * a link WITHOUT a preview: that is how an author says "no preview" while writing. At most MAX_PREVIEW_LINKS per message.
 */
import { scanOutsideCode } from "./scan";

export const MAX_PREVIEW_LINKS = 3;
const MAX_URL_LENGTH = 2100;
const wordRe = /[\p{L}\p{N}]/u;
const autolinkRe = /^<(?:https?:\/\/|mailto:)[^\s<>]+>/i;
const TRAILING_PUNCTUATION = /[.,;:!?*_~'"\]]/;

/**
 * Bare http(s) address at `at`; trailing punctuation and emphasis marks belong to the sentence, not to the address. A
 * closing parenthesis stays only while the address has at least as many opening ones: the balance is counted once and
 * kept up while the end is trimmed (until 5 October 2026 every trimmed character counted the whole address again, so an
 * address of 2100 closing parentheses took the square of its length; security audit of that day, L-9).
 */
export function readBareUrl(text: string, at: number): string | null {
  const m = /^https?:\/\/[^\s<]+/i.exec(text.slice(at, at + MAX_URL_LENGTH));
  if (!m) return null;
  let url = m[0];
  const cut = url.indexOf("](");
  if (cut >= 0) url = url.slice(0, cut);
  let open = 0, close = 0;
  for (const c of url) { if (c === "(") open++; else if (c === ")") close++; }
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1]!;
    if (TRAILING_PUNCTUATION.test(last)) { end--; continue; }
    if (last === ")" && close > open) { end--; close--; continue; }
    break;
  }
  url = url.slice(0, end);
  return /^https?:\/\/[^/?#]/i.test(url) ? url : null;
}

/** The addresses of a message text that get a preview, as written, in order, without repeats. */
export function previewLinks(content: string): string[] {
  if (!/https?:\/\//i.test(content)) return [];
  return scanOutsideCode(content, (text, at) => {
    const c = text[at]!;
    if (c === "<") {
      const m = autolinkRe.exec(text.slice(at, at + MAX_URL_LENGTH + 2));
      return m ? { value: null, length: m[0].length } : null;
    }
    if ((c !== "h" && c !== "H") || (at > 0 && wordRe.test(text[at - 1]!))) return null;
    const url = readBareUrl(text, at);
    return url ? { value: url, length: url.length } : null;
  }).slice(0, MAX_PREVIEW_LINKS);
}
