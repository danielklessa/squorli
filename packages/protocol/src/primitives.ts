import { z } from "zod";
// COPY NOTE: also exists byte-identically in the squorli-directory repo (packages/protocol/src); the source is squorli-server, copy it over after any change.

/** Basic building blocks shared by the chat protocol and the directory service. */
export const Uuid = z.string().uuid();
export const Iso = z.string().datetime();
/** Public key as 64 hex characters (32 bytes). */
export const PublicKey = z.string().regex(/^[0-9a-f]{64}$/, "64 hex chars");
/** Signature as 128 hex characters (64 bytes). */
export const Signature = z.string().regex(/^[0-9a-f]{128}$/, "128 hex chars");

/**
 * Why somebody reports something (26 September 2026): one list for a report on a chat server (reports.ts: a message or a member
 * to the server's moderators) and for one to the directory (directory.ts: a direct message to the directory's operator), so the
 * client's one dialog serves both. `REPORT_TEXT_MAX` is the reporter's free text.
 */
export const REPORT_REASONS = ["spam", "harassment", "hate", "sexual", "violence", "illegal", "other"] as const;
export const ReportReason = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof ReportReason>;
export const REPORT_TEXT_MAX = 1000;

/**
 * One emoji (6 October 2026, docs/features/reactions.md): the rule the web client's `emoji/convert.ts` finds emoji in message
 * text with, kept here so the chat server (reactions on channel messages) and both sides of a direct message (the reaction
 * control in dm.ts) validate with the same rule. One emoji as a user perceives it: a flag, a keycap, a tag sequence (England,
 * Scotland, Wales) or a pictograph with optional variation selector and skin tone, joined by ZWJ into families, professions and
 * the like. Characters whose default is text presentation (©, ™, ↔, ☺ ...) only count with the emoji selector U+FE0F or a skin
 * tone, so plain typography stays text.
 */
const EMOJI_PART = String.raw`(?:\p{Emoji_Presentation}️?|\p{Extended_Pictographic}️|\p{Emoji_Modifier_Base}(?=\p{Emoji_Modifier}))\p{Emoji_Modifier}?`;
const EMOJI_JOINED = String.raw`‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?`;
/** Source of a regular expression (flag `u`) matching exactly one emoji; `convert.ts` uses it with `gu` to cut text into runs. */
export const EMOJI_SOURCE = String.raw`\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|${EMOJI_PART}(?:${EMOJI_JOINED})*`;
const singleEmojiRe = new RegExp(`^(?:${EMOJI_SOURCE})$`, "u");
/** Longest emoji accepted as a reaction, in UTF-16 units (a family of four or a tag flag is under 20). */
export const REACTION_EMOJI_MAX_CHARS = 64;
/** Exactly one emoji and nothing else. */
export const isSingleEmoji = (s: string): boolean => s.length > 0 && s.length <= REACTION_EMOJI_MAX_CHARS && singleEmojiRe.test(s);
/** The identity of a reaction: "❤" and "❤️" are one chip (the selector U+FE0F differs between keyboards); skin tones and ZWJ sequences stay distinct. */
export const emojiKey = (s: string): string => s.normalize("NFC").replace(/️/gu, "");
/**
 * An emoji as a request carries it: normalized, exactly one. A character of text presentation that some keyboards send bare
 * ("❤" without U+FE0F) gets the selector, so it counts as the emoji it was meant as; `emojiKey` makes both forms one anyway.
 */
export const ReactionEmoji = z.string().min(1).max(REACTION_EMOJI_MAX_CHARS)
  .transform((s) => { const n = s.normalize("NFC"); return !isSingleEmoji(n) && isSingleEmoji(`${n}️`) ? `${n}️` : n; })
  .refine(isSingleEmoji, "one emoji");
