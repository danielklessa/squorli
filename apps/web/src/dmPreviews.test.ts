import { openDmBlob, type DmPreview } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { buildDmPreviews, visibleDms, type LookupRequest, type PreviewDeps } from "./dmPreviews";

const page = { kind: "page" as const, siteName: "Beispiel", title: "Titel", description: "Text", image: { mime: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) } };

function deps(over: Partial<PreviewDeps> = {}) {
  const asked: LookupRequest[] = [];
  // By the blob's id, not in the order of arrival: the pictures of several links are sealed and stored at the same time.
  const stored = new Map<string, Uint8Array>();
  const d: PreviewDeps = {
    lookUp: async (r) => { asked.push(r); return "youtube" in r ? { ...page, kind: "youtube", siteName: "YouTube", title: "Video", description: null } : page; },
    shrink: async (image) => ({ mime: "image/webp", bytes: image.bytes }),
    putBlob: async (ciphertext) => { const id = (stored.size + 1).toString(16).padStart(32, "0"); stored.set(id, ciphertext); return id; },
    ...over,
  };
  return { d, asked, stored };
}

describe("buildDmPreviews", () => {
  it("looks up what the scanner finds, a video by its id, and stores the picture encrypted", async () => {
    const { d, asked, stored } = deps();
    const previews = await buildDmPreviews("schau https://example.org/a und https://youtu.be/aqz-KE-bpKQ?t=42 aber nicht <https://example.com/still>", d);
    expect(asked).toEqual([{ url: "https://example.org/a" }, { youtube: "aqz-KE-bpKQ" }]);
    expect(previews.map((p) => [p.url, p.kind, p.title, p.videoId, p.start])).toEqual([["https://example.org/a", "page", "Titel", undefined, undefined], ["https://youtu.be/aqz-KE-bpKQ?t=42", "youtube", "Video", "aqz-KE-bpKQ", 42]]);
    // What went to the store is ciphertext that only the key inside the message opens.
    expect(stored.size).toBe(2);
    for (const preview of previews) {
      const ciphertext = stored.get(preview.image!.blob)!;
      expect([...ciphertext.subarray(0, 4)]).not.toEqual([1, 2, 3, 4]);
      expect([...(await openDmBlob(preview.image!, ciphertext))]).toEqual([1, 2, 3, 4]);
      expect(preview.image).toMatchObject({ mime: "image/webp" });
    }
    expect(previews[0]!.image!.blob).not.toBe(previews[1]!.image!.blob);
  });

  it("keeps preview and picture together when the second link's picture reaches the store first", async () => {
    // The first link's picture takes longer to make small (this order failed a CI run once, when the test took the
    // store's first entry for the first preview's picture).
    let calls = 0;
    const { d, stored } = deps({ shrink: async (image) => { if (++calls === 1) await new Promise((r) => setTimeout(r, 30)); return { mime: "image/webp", bytes: image.bytes }; } });
    const previews = await buildDmPreviews("https://example.org/a https://example.org/b", d);
    expect(previews.map((p) => p.url)).toEqual(["https://example.org/a", "https://example.org/b"]);
    // Stored second, still the first preview's
    expect(previews[0]!.image!.blob).toBe((2).toString(16).padStart(32, "0"));
    for (const preview of previews) expect([...(await openDmBlob(preview.image!, stored.get(preview.image!.blob)!))]).toEqual([1, 2, 3, 4]);
  });

  it("goes without a picture when there is no store, the picture is none or the upload fails", async () => {
    for (const over of [{ putBlob: null }, { shrink: async () => null }, { putBlob: async () => { throw new Error("offline"); } }] as Partial<PreviewDeps>[]) {
      const [p] = await buildDmPreviews("https://example.org/a", deps(over).d);
      expect(p).toMatchObject({ title: "Titel", image: null });
    }
  });

  it("no links, nothing found, a failing or a slow lookup: no previews and no error", async () => {
    expect(await buildDmPreviews("nur Text", deps().d)).toEqual([]);
    expect(await buildDmPreviews("https://example.org/a", deps({ lookUp: async () => null }).d)).toEqual([]);
    expect(await buildDmPreviews("https://example.org/a", deps({ lookUp: async () => { throw new Error("x"); } }).d)).toEqual([]);
    expect(await buildDmPreviews("https://example.org/a", deps({ lookUp: () => new Promise(() => {}) }).d, 30)).toEqual([]);
  });
});

describe("visibleDms", () => {
  const preview = (url: string): DmPreview => ({ url, kind: "page", siteName: null, title: "t", description: null, image: null });
  const ID1 = "11111111-1111-4111-8111-111111111111", ID2 = "22222222-2222-4222-8222-222222222222";

  it("hides instructions and the previews their author removed", () => {
    const list = [
      { id: ID1, from: "A", previews: [preview("https://a.example"), preview("https://b.example")] },
      { id: ID2, from: "B", previews: [preview("https://c.example")] },
      { id: "c1", from: "A", control: { type: "preview.remove" as const, id: ID1, url: "https://a.example" } },
    ];
    const shown = visibleDms(list);
    expect(shown.map((m) => m.id)).toEqual([ID1, ID2]);
    expect(shown[0]!.shown.map((p) => p.url)).toEqual(["https://b.example"]);
    expect(shown[1]!.shown.map((p) => p.url)).toEqual(["https://c.example"]);
  });

  it("ignores an instruction that does not come from the message's author", () => {
    const list = [
      { id: ID1, from: "A", previews: [preview("https://a.example")] },
      { id: "c1", from: "B", control: { type: "preview.remove" as const, id: ID1, url: "https://a.example" } },
      { id: "c2", from: "A", control: { type: "preview.remove" as const, id: ID2, url: "https://a.example" } },
    ];
    expect(visibleDms(list)[0]!.shown).toHaveLength(1);
  });
});
