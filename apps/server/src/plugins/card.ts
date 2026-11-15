import { PLUGIN_CARD_KICKER_MAX, PLUGIN_CARD_TEXT_MAX, PLUGIN_CARD_TITLE_MAX, PLUGIN_CARD_URL_MAX, type MessageCard } from "@squorli/protocol";

/**
 * A plugin's card as it hands it to `messages.send` (docs/features/plugins.md, interface version 2); pure and tested.
 *
 * The card's texts are stored with the message. Its two pictures are addresses the plugin names: they never reach a
 * client. The server fetches them itself (the link previews' guarded fetch, pictures only) and the card then carries the
 * paths of the files it kept. So what `readCard` returns is two things: the card to store, and the addresses to fetch.
 */
export type CardPictures = { image?: string; thumbnail?: string };

/** An https address without anything a text could smuggle in; the same form a manifest's homepage has. */
const ADDRESS = /^https:\/\/[^\s<>"'`\\]+$/;
const KEYS = new Set(["kicker", "title", "url", "text", "image", "thumbnail"]);

function line(card: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = card[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`card.${key} is a text`);
  // One line: a break or a tab in a title would only be a way to make a card look like two.
  const text = v.replace(/\s+/g, " ").trim();
  if (text.length > max) throw new Error(`card.${key} has at most ${max} characters`);
  return text || undefined;
}

function address(card: Record<string, unknown>, key: string, testOrigin: string | undefined): string | undefined {
  const v = card[key];
  if (v === undefined || v === null || v === "") return undefined;
  const played = testOrigin !== undefined && typeof v === "string" && URL.canParse(v) && new URL(v).origin === testOrigin && !/[\s<>"'`\\]/.test(v);
  if (typeof v !== "string" || v.length > PLUGIN_CARD_URL_MAX || !(played || ADDRESS.test(v)) || !URL.canParse(v)) throw new Error(`card.${key} is an https address of at most ${PLUGIN_CARD_URL_MAX} characters`);
  const url = new URL(v);
  if (url.username || url.password) throw new Error(`card.${key} is an https address without a user name`);
  return v;
}

/**
 * The card of a `messages.send`, or an Error whose message tells the plugin's author what is wrong with it. `testOrigin`
 * (LINK_PREVIEW_TEST_ORIGIN, tests only) is one origin whose addresses count although they are not https.
 */
export function readCard(raw: unknown, testOrigin?: string): { card: MessageCard; pictures: CardPictures } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("card is an object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!KEYS.has(key)) throw new Error(`card.${key} is not a key of a card (kicker, title, url, text, image, thumbnail)`);
  const kicker = line(input, "kicker", PLUGIN_CARD_KICKER_MAX), title = line(input, "title", PLUGIN_CARD_TITLE_MAX);
  let text: string | undefined;
  if (input.text !== undefined && input.text !== null) {
    if (typeof input.text !== "string") throw new Error("card.text is a text");
    text = input.text.trim() || undefined;
    if (text && text.length > PLUGIN_CARD_TEXT_MAX) throw new Error(`card.text has at most ${PLUGIN_CARD_TEXT_MAX} characters`);
  }
  if (!title && !text) throw new Error("a card has a title or a text");
  const url = address(input, "url", testOrigin), image = address(input, "image", testOrigin), thumbnail = address(input, "thumbnail", testOrigin);
  return {
    card: { ...(kicker ? { kicker } : {}), ...(title ? { title } : {}), ...(url ? { url } : {}), ...(text ? { text } : {}) },
    pictures: { ...(image ? { image } : {}), ...(thumbnail ? { thumbnail } : {}) },
  };
}
