import { describe, expect, it } from "vitest";
import { notificationBody, notificationFor, parseNotificationTag } from "./notifications";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("notificationBody", () => {
  it("makes one plain line with mentions as names", () => {
    expect(notificationBody(`**Hallo** <@${ID}>,\n\n> zitiert\n- [x] erledigt\n\`code\``, new Map([[ID, "Anna"]]))).toBe("Hallo @Anna, zitiert erledigt code");
    expect(notificationBody("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(notificationBody("[Link](https://example.org) und ![Bild](x.png)")).toBe("Link und Bild");
  });
  it("keeps a token of somebody unknown and cuts long texts", () => {
    expect(notificationBody(`<@${ID}>`)).toBe(`<@${ID}>`);
    const long = notificationBody("a".repeat(500));
    expect(long).toHaveLength(180);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("notificationFor", () => {
  it("names who wrote where and hides the text on request", () => {
    const dm = { kind: "dm", peer: "abc", from: "Anna", text: "Hi" } as const;
    expect(notificationFor(dm, true, "Neue Nachricht")).toEqual({ title: "Anna", body: "Hi", tag: "dm:abc" });
    expect(notificationFor(dm, false, "Neue Nachricht").body).toBe("Neue Nachricht");
    const mention = { kind: "mention", host: "chat.example.org:8443", channelId: ID, server: "Runde", channel: "allgemein", from: "Ben", text: "@Anna schau" } as const;
    expect(notificationFor(mention, true, "x")).toEqual({ title: "Ben · #allgemein (Runde)", body: "@Anna schau", tag: `mention:chat.example.org:8443:${ID}` });
  });
});

describe("parseNotificationTag", () => {
  it("reads back what notificationFor wrote", () => {
    expect(parseNotificationTag("dm:abc")).toEqual({ kind: "dm", peer: "abc" });
    expect(parseNotificationTag(`mention:chat.example.org:8443:${ID}`)).toEqual({ kind: "mention", host: "chat.example.org:8443", channelId: ID });
    expect(parseNotificationTag("dm:")).toBeNull();
    expect(parseNotificationTag("mention:nohost")).toBeNull();
    expect(parseNotificationTag("other")).toBeNull();
  });
});
