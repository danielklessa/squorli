import { describe, expect, it } from "vitest";
import type { ScreenSource } from "./platform/bridge";
import { createScreenOffer } from "./platform/screenOffer";
import { defaultAudio, defaultCodec, movingCodec, quickSharePick, sortWindows, whenListed } from "./screenPick";

const source = (over: Partial<ScreenSource>): ScreenSource => ({ id: "window:1:0", kind: "window", name: "x", thumbnail: "", icon: null, audio: true, ...over });

describe("screenPick", () => {
  it("ticks a window's audio, never the app's own and not a screen's", () => {
    expect(defaultAudio(source({}))).toBe(true);
    expect(defaultAudio(source({ audio: false }))).toBe(false);
    expect(defaultAudio(source({ id: "screen:0:0", kind: "screen" }))).toBe(false);
    expect(defaultAudio(null)).toBe(false);
  });

  it("preselects the codec for moving pictures for a game's window and the standing codec for everything else", () => {
    expect(movingCodec(true)).toBe("h265");
    expect(movingCodec(false)).toBe("h264");
    expect(defaultCodec(source({ gameId: "steam:730" }), false)).toBe("h264");
    expect(defaultCodec(source({ gameId: "steam:730" }), true)).toBe("h265");
    for (const h265 of [true, false]) {
      expect(defaultCodec(source({}), h265)).toBe("vp8");
      expect(defaultCodec(source({ gameId: null }), h265)).toBe("vp8");
      expect(defaultCodec(source({ id: "screen:0:0", kind: "screen" }), h265)).toBe("vp8");
      expect(defaultCodec(null, h265)).toBe("vp8");
    }
  });

  it("lists games first, then full screen windows, then the rest, each by name", () => {
    const list = [source({ name: "zeta" }), source({ name: "Video", fullscreen: true }), source({ name: "Alpha" }), source({ name: "Witcher", gameId: "gog:1" }), source({ name: "apex", gameId: "steam:1", fullscreen: true }), source({ name: "Browser", fullscreen: true })];
    expect(sortWindows(list, "de").map((s) => s.name)).toEqual(["apex", "Witcher", "Browser", "Video", "Alpha", "zeta"]);
    expect(list[0]!.name).toBe("zeta");
  });

  it("quick share takes the game's topmost window with audio and the codec for moving pictures", () => {
    const sources = [source({ id: "screen:0:0", kind: "screen" }), source({ id: "window:5:0" }), source({ id: "window:7:0", gameId: "steam:730" }), source({ id: "window:9:0", gameId: "steam:730" })];
    expect(quickSharePick(sources, "steam:730", false)).toEqual({ sourceId: "window:7:0", audio: true, codec: "h264" });
    expect(quickSharePick(sources, "steam:730", true)).toEqual({ sourceId: "window:7:0", audio: true, codec: "h265" });
    expect(quickSharePick([source({ id: "window:7:0", gameId: "steam:730", audio: false })], "steam:730", false)).toEqual({ sourceId: "window:7:0", audio: false, codec: "h264" });
    expect(quickSharePick(sources, "epic:Fortnite", true)).toBeNull();
  });

  it("waits for the list and not for the pictures", async () => {
    const { offer, update } = createScreenOffer({ requestId: 1, sources: [], listing: true }, null);
    let listed: readonly ScreenSource[] | null = null;
    const waiting = whenListed(offer).then((sources) => { listed = sources; });
    await Promise.resolve();
    expect(listed).toBeNull();
    update({ requestId: 1, sources: [source({ pending: true })], listing: false });
    await waiting;
    expect(listed).toEqual([source({ pending: true })]);
    // A later update (the pictures) changes nothing about what was handed out.
    update({ requestId: 1, sources: [source({ thumbnail: "data:image/jpeg;base64,AA" })], listing: false });
    expect(listed).toEqual([source({ pending: true })]);
    // A shell from before: everything is there with the request.
    const old = createScreenOffer({ requestId: 2, sources: [source({ id: "window:2:0" })] }, null);
    expect(await whenListed(old.offer)).toEqual([source({ id: "window:2:0" })]);
  });
});
