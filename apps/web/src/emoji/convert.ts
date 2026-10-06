import { EMOJI_SOURCE } from "@squorli/protocol";
import { SHORTCODES } from "./shortcodes";

/**
 * Emoji in message text, pure functions for the Markdown parser (`markdown.ts`): find real emoji so they can be set in
 * the emoji font, and turn the two written forms into emoji when a message is shown: shortcodes (`:smile:`, the Markdown
 * habit from GitHub, Slack and Discord) and classic emoticons (`:)`, `;-)`, `<3`). Messages are stored as typed; code
 * spans, code blocks and addresses never pass through here, and a backslash keeps a form literal (`\:)`).
 */

// One emoji as a user perceives it: the rule lives in the protocol (`EMOJI_SOURCE` in primitives.ts, since 6 October 2026 shared
// with the server's reaction check and the direct messages' reaction control), so text and reactions agree on what one emoji is.
const emojiRe = new RegExp(EMOJI_SOURCE, "gu");

export type TextPiece = { emoji: boolean; text: string };

/** Cuts a text into runs of plain text and single emoji. */
export function splitEmoji(text: string): TextPiece[] {
  const out: TextPiece[] = [];
  let at = 0;
  for (const m of text.matchAll(emojiRe)) {
    if (m.index > at) out.push({ emoji: false, text: text.slice(at, m.index) });
    out.push({ emoji: true, text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ emoji: false, text: text.slice(at) });
  return out;
}

export type Converted = { emoji: string; length: number };

const shortcodeRe = /:([A-Za-z0-9_+-]{1,48}):/y;
const wordRe = /[\p{L}\p{N}]/u;

/** `:name:` at `at`. Not directly after a letter or digit, so "12:30:45" and "a:b:c" stay what they are. */
export function shortcodeAt(text: string, at: number): Converted | null {
  if (at > 0 && wordRe.test(text[at - 1]!)) return null;
  shortcodeRe.lastIndex = at;
  const m = shortcodeRe.exec(text);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  // hasOwn: the table is a plain object, ":constructor:" must not find Object.prototype.
  return Object.hasOwn(SHORTCODES, name) ? { emoji: SHORTCODES[name]!, length: m[0].length } : null;
}

/** Deliberately few and unambiguous; "8)" (a list in a sentence), ":3" or "D:" would hit ordinary text too often. */
export const EMOTICONS: Readonly<Record<string, string>> = {
  ":)": "🙂", ":-)": "🙂", ":(": "🙁", ":-(": "🙁", ":D": "😃", ":-D": "😃", ";)": "😉", ";-)": "😉",
  ":P": "😛", ":-P": "😛", ":p": "😛", ":-p": "😛", ":O": "😮", ":-O": "😮", ":o": "😮", ":-o": "😮",
  ":'(": "😢", ":*": "😘", ":-*": "😘", ":|": "😐", ":-|": "😐", ":/": "😕", ":-/": "😕",
  ">:(": "😠", "xD": "😆", "XD": "😆", "^^": "😊", "^_^": "😊", "-_-": "😑", "<3": "❤️", "</3": "💔",
};
const emoticonRe = new RegExp(
  `(?:${Object.keys(EMOTICONS).sort((a, b) => b.length - a.length).map((e) => e.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})(?=$|[\\s.,!?])`, "y");

/** Emoticon at `at`: only as a word of its own (start or white space before, end, white space or sentence punctuation after). */
export function emoticonAt(text: string, at: number): Converted | null {
  if (at > 0 && !/\s/.test(text[at - 1]!)) return null;
  emoticonRe.lastIndex = at;
  const m = emoticonRe.exec(text);
  return m ? { emoji: EMOTICONS[m[0]]!, length: m[0].length } : null;
}

/** First characters an emoticon can start with (cheap test before the regular expression runs). */
export const EMOTICON_STARTS: ReadonlySet<string> = new Set(Object.keys(EMOTICONS).map((e) => e[0]!));
