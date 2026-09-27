import { describe, expect, it } from "vitest";
import { PickOffer, type ListedSource } from "./pickOffer";

const source = (over: Partial<ListedSource>): ListedSource => ({ id: "window:1:0", kind: "window", name: "x", icon: null, audio: true, fullscreen: false, gameId: null, ...over });
const screen = source({ id: "screen:0:0", kind: "screen", name: "Screen 1" });
const win = source({ id: "window:7:0", name: "Editor" });

describe("PickOffer", () => {
  it("asks with nothing, then names the list", () => {
    const offer = new PickOffer(3);
    expect(offer.listed).toBe(false);
    expect(offer.state()).toEqual({ requestId: 3, listing: true, sources: [] });
    offer.list([screen, win]);
    expect(offer.listed).toBe(true);
    expect(offer.state()).toEqual({ requestId: 3, listing: false, sources: [{ ...screen, thumbnail: "", pending: false }, { ...win, thumbnail: "", pending: false }] });
  });

  it("marks the sources whose pictures are being made, per kind", () => {
    const offer = new PickOffer(1);
    offer.list([screen, win]);
    offer.making("screen");
    offer.making("window");
    expect(offer.state().sources.map((s) => s.pending)).toEqual([true, true]);
    offer.made("screen", new Map([["screen:0:0", "data:image/jpeg;base64,AA"]]));
    expect(offer.state().sources).toEqual([{ ...screen, thumbnail: "data:image/jpeg;base64,AA", pending: false }, { ...win, thumbnail: "", pending: true }]);
    // A window nothing could be captured of keeps its symbol.
    offer.made("window", new Map());
    expect(offer.state().sources[1]).toEqual({ ...win, thumbnail: "", pending: false });
  });

  it("keeps pictures that were done before the list", () => {
    const offer = new PickOffer(1);
    offer.making("screen");
    offer.made("screen", new Map([["screen:0:0", "data:image/jpeg;base64,AA"], ["screen:9:0", "data:image/jpeg;base64,BB"]]));
    expect(offer.state().sources).toEqual([]);
    offer.list([screen]);
    expect(offer.state().sources).toEqual([{ ...screen, thumbnail: "data:image/jpeg;base64,AA", pending: false }]);
  });

  it("a failed listing offers nothing", () => {
    const offer = new PickOffer(1);
    offer.list([]);
    expect(offer.state()).toEqual({ requestId: 1, listing: false, sources: [] });
  });
});
