import { Message } from "@squorli/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginCard } from "./PluginCard";

const html = (card: Parameters<typeof PluginCard>[0]["card"], image: string | null = null, thumbnail: string | null = null) => renderToStaticMarkup(<PluginCard card={card} image={image} thumbnail={thumbnail} />);

describe("PluginCard", () => {
  it("draws kicker, a linked title, the text as Markdown and both pictures", () => {
    const out = html({ kicker: "WARDOGS", title: "Season 03 Patch Notes", url: "https://store.steampowered.com/news/app/1", text: "**New Map**\n\n> maintenance\n\n- one" }, "/api/previews/a.jpg", "/api/previews/b.jpg");
    expect(out).toContain('<span class="plugin-card-kicker">WARDOGS</span>');
    expect(out).toContain('<a class="plugin-card-title" href="https://store.steampowered.com/news/app/1"');
    expect(out).toContain('rel="noreferrer noopener"');
    expect(out).toContain("<strong>New Map</strong>");
    expect(out).toContain("<blockquote>");
    expect(out).toContain("<li>");
    expect(out).toContain('<img class="plugin-card-thumb" src="/api/previews/b.jpg"');
    expect(out).toContain('<img src="/api/previews/a.jpg"');
  });

  it("shows a plugin's texts as text, never as markup", () => {
    const out = html({ kicker: "<b>k</b>", title: "<img src=x onerror=alert(1)>", text: "<script>alert(1)</script>" });
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;b&gt;k&lt;/b&gt;");
  });

  it("makes no link of an address that is none for the web", () => {
    const out = html({ title: "A title", url: "javascript:alert(1)" }, "/api/previews/a.jpg");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('<strong class="plugin-card-title">A title</strong>');
    expect(out).toContain('<span class="plugin-card-image">');
  });

  it("draws a card of only a text, and nothing for an empty one", () => {
    expect(html({ text: "just this" })).toContain("just this");
    expect(html({ text: "just this" })).not.toContain("plugin-card-head");
    expect(html({ kicker: "only a kicker" })).toBe("");
    expect(html({})).toBe("");
  });
});

describe("a message's card on the wire", () => {
  const message = (plugin: unknown) => Message.safeParse({
    id: "11111111-1111-4111-8111-111111111111", seq: 1, channelId: "22222222-2222-4222-8222-222222222222", authorId: "33333333-3333-4333-8333-333333333333",
    content: "the text an older app shows", createdAt: "2026-11-15T10:00:00.000Z", editedAt: null, attachments: [], plugin,
  });

  it("is read with the message", () => {
    const m = message({ id: "game-news", name: { en: "Game news" }, card: { kicker: "WARDOGS", title: "T", image: "/api/previews/a.jpg", later: "ignored" } });
    expect(m.success).toBe(true);
    expect(m.data?.plugin?.card).toEqual({ kicker: "WARDOGS", title: "T", image: "/api/previews/a.jpg" });
  });

  it("costs the card, not the message, when a later server sends a shape this app cannot read", () => {
    const m = message({ id: "game-news", name: { en: "Game news" }, card: { title: 5, text: ["x"] } });
    expect(m.success).toBe(true);
    expect(m.data?.plugin?.card).toBeUndefined();
    expect(m.data?.content).toBe("the text an older app shows");
  });
});
