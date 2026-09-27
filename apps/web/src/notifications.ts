/**
 * Notifications of the operating system for direct messages and mentions (docs/features/notifications.md, 27 September
 * 2026): they come with the sound (attention.ts, store.ts `incoming`), so exactly when the user does not see the message.
 * A choice per device, like the output device: the desktop app shows them unless switched off, a browser only after the
 * user switched them on (the browser asks for the permission inside that click). Pure apart from localStorage.
 */

export type NotificationSettings = {
  /** Show notifications on this device. */
  on: boolean;
  /** Put the message's text into the notification; false = only who wrote where (for a screen others see). */
  preview: boolean;
};

const KEY = "chat.notifications.v1";

export function defaultNotificationSettings(desktop: boolean): NotificationSettings {
  return { on: desktop, preview: true };
}

export function loadNotificationSettings(desktop: boolean): NotificationSettings {
  const fallback = defaultNotificationSettings(desktop);
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<NotificationSettings> | null;
    if (!raw || typeof raw !== "object") return fallback;
    return { on: typeof raw.on === "boolean" ? raw.on : fallback.on, preview: typeof raw.preview === "boolean" ? raw.preview : fallback.preview };
  } catch { return fallback; }
}

export function saveNotificationSettings(settings: NotificationSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage full or blocked: the choice lasts this session */ }
}

/** What arrived, as the store knows it; App.tsx turns it into a notification. `tag` names the conversation (a click opens it). */
export type IncomingNote =
  | { kind: "dm"; peer: string; from: string; text: string }
  | { kind: "mention"; host: string; channelId: string; server: string; channel: string; from: string; text: string };

const BODY_MAX = 180;

/**
 * Message text for a notification: one line, mention tokens as @Name (`names` = userId -> name), Markdown's marks and code
 * fences dropped, cut at BODY_MAX characters.
 */
export function notificationBody(content: string, names: ReadonlyMap<string, string> = new Map()): string {
  const text = content
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    .replace(/<@([0-9a-f-]{36})>/gi, (token, id: string) => { const n = names.get(id.toLowerCase()); return n ? `@${n.replace(/^@+/, "")}` : token; })
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1).trimEnd()}…` : text;
}

/** Title, body and tag of the notification; `hidden` = the text the body shows when previews are off. */
export function notificationFor(note: IncomingNote, preview: boolean, hidden: string): { title: string; body: string; tag: string } {
  const body = preview && note.text ? note.text : hidden;
  if (note.kind === "dm") return { title: note.from, body, tag: `dm:${note.peer}` };
  return { title: `${note.from} · #${note.channel} (${note.server})`, body, tag: `mention:${note.host}:${note.channelId}` };
}

/** The conversation a clicked notification names; null = not one of ours. Hosts never contain ":" before a port, so split once from the end. */
export function parseNotificationTag(tag: string): { kind: "dm"; peer: string } | { kind: "mention"; host: string; channelId: string } | null {
  if (tag.startsWith("dm:")) return tag.length > 3 ? { kind: "dm", peer: tag.slice(3) } : null;
  if (!tag.startsWith("mention:")) return null;
  const rest = tag.slice("mention:".length);
  const cut = rest.lastIndexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { kind: "mention", host: rest.slice(0, cut), channelId: rest.slice(cut + 1) };
}
