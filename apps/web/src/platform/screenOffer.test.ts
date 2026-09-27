import { describe, expect, it } from "vitest";
import type { ScreenSource } from "./bridge";
import { createScreenOffer } from "./screenOffer";

const source = (over: Partial<ScreenSource>): ScreenSource => ({ id: "window:1:0", kind: "window", name: "x", thumbnail: "", icon: null, audio: true, ...over });

describe("createScreenOffer", () => {
  it("starts with what the request carries and fills up with the shell's updates", () => {
    const { offer, update } = createScreenOffer({ requestId: 4, sources: [], listing: true }, () => {});
    expect(offer.current()).toEqual({ sources: [], listing: true });
    let calls = 0;
    const off = offer.subscribe(() => { calls++; });
    update({ requestId: 4, sources: [source({ pending: true })], listing: false });
    expect(calls).toBe(1);
    expect(offer.current()).toEqual({ sources: [source({ pending: true })], listing: false });
    update({ requestId: 4, sources: [source({ thumbnail: "data:image/jpeg;base64,AA" })] });
    expect(offer.current().sources[0]!.thumbnail).toBe("data:image/jpeg;base64,AA");
    off();
    update({ requestId: 4, sources: [] });
    expect(calls).toBe(2);
  });

  it("keeps the same state object until something changes", () => {
    const { offer, update } = createScreenOffer({ requestId: 1, sources: [source({})] }, null);
    const first = offer.current();
    expect(offer.current()).toBe(first);
    update({ requestId: 1, sources: [source({})] });
    expect(offer.current()).not.toBe(first);
  });

  it("takes a request of a shell from before as complete", () => {
    const { offer } = createScreenOffer({ requestId: 1, sources: [source({ thumbnail: "data:image/jpeg;base64,AA" })] }, null);
    expect(offer.current().listing).toBe(false);
    expect(() => offer.loadPictures()).not.toThrow();
  });

  it("ignores another request's update", () => {
    const { offer, update } = createScreenOffer({ requestId: 2, sources: [], listing: true }, null);
    update({ requestId: 3, sources: [source({})], listing: false });
    expect(offer.current()).toEqual({ sources: [], listing: true });
  });

  it("asks the shell for the pictures once", () => {
    let asked = 0;
    const { offer } = createScreenOffer({ requestId: 1, sources: [], listing: true }, () => { asked++; });
    offer.loadPictures();
    offer.loadPictures();
    expect(asked).toBe(1);
  });
});
