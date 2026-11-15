import { describe, expect, it } from "vitest";
import { readCard } from "./card";

describe("readCard", () => {
  it("splits a card into what is stored and the pictures to fetch", () => {
    const { card, pictures } = readCard({ kicker: " WARDOGS ", title: "Season 03\n Patch\tNotes", url: "https://store.steampowered.com/news/app/1", text: "  **New**\n\n- one\n- two  ", image: "https://clan.akamai.steamstatic.com/images/1/a.jpg", thumbnail: "https://shared.akamai.steamstatic.com/x/capsule.jpg?t=1" });
    expect(card).toEqual({ kicker: "WARDOGS", title: "Season 03 Patch Notes", url: "https://store.steampowered.com/news/app/1", text: "**New**\n\n- one\n- two" });
    expect(pictures).toEqual({ image: "https://clan.akamai.steamstatic.com/images/1/a.jpg", thumbnail: "https://shared.akamai.steamstatic.com/x/capsule.jpg?t=1" });
  });

  it("never stores a picture's address with the card", () => {
    const { card } = readCard({ title: "x", image: "https://example.org/a.png" });
    expect(Object.keys(card)).toEqual(["title"]);
  });

  it("takes a card with a title or a text and nothing else", () => {
    expect(readCard({ text: "only text" }).card).toEqual({ text: "only text" });
    expect(readCard({ title: "only a title", kicker: null, image: "" })).toEqual({ card: { title: "only a title" }, pictures: {} });
    expect(() => readCard({ kicker: "a game" })).toThrow("a title or a text");
    expect(() => readCard({ title: "  ", text: "\n" })).toThrow("a title or a text");
  });

  it("refuses what is no card", () => {
    expect(() => readCard(null)).toThrow("card is an object");
    expect(() => readCard(["x"])).toThrow("card is an object");
    expect(() => readCard("x")).toThrow("card is an object");
    expect(() => readCard({ title: "x", color: "#ff0000" })).toThrow("card.color is not a key");
    expect(() => readCard({ title: 5 })).toThrow("card.title is a text");
    expect(() => readCard({ title: "x", text: {} })).toThrow("card.text is a text");
  });

  it("holds the lengths", () => {
    expect(() => readCard({ title: "x".repeat(201) })).toThrow("at most 200");
    expect(() => readCard({ title: "x", kicker: "k".repeat(81) })).toThrow("at most 80");
    expect(() => readCard({ text: "x".repeat(2001) })).toThrow("at most 2000");
    expect(readCard({ text: "x".repeat(2000) }).card.text).toHaveLength(2000);
  });

  it("takes only https addresses without a user name, a gap or a quote", () => {
    for (const bad of ["http://example.org/a.png", "//example.org/a.png", "javascript:alert(1)", "https://user:pw@example.org/a.png", "https://example.org/a b.png", "https://example.org/\"a.png", "https://", `https://example.org/${"a".repeat(500)}`, 7]) {
      expect(() => readCard({ title: "x", image: bad }), String(bad)).toThrow("card.image");
      expect(() => readCard({ title: "x", url: bad }), String(bad)).toThrow("card.url");
    }
    expect(() => readCard({ title: "x", thumbnail: "ftp://example.org/a.png" })).toThrow("card.thumbnail");
  });

  it("lets the tests' one origin stand in for an https address, and no other", () => {
    expect(readCard({ title: "x", image: "http://127.0.0.1:3198/bild.png" }, "http://127.0.0.1:3198").pictures).toEqual({ image: "http://127.0.0.1:3198/bild.png" });
    expect(() => readCard({ title: "x", image: "http://127.0.0.1:3199/bild.png" }, "http://127.0.0.1:3198")).toThrow("card.image");
    expect(() => readCard({ title: "x", image: "http://127.0.0.1:3198/bild.png" })).toThrow("card.image");
  });
});
