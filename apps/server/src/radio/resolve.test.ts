import { describe, expect, it } from "vitest";
import { resolveStreamUrl } from "./resolve";

describe("resolveStreamUrl: a plain stream address", () => {
  it("is refused when its host is an internal address, so no listener is sent to the router or a LAN machine", async () => {
    for (const url of ["http://127.0.0.1:8000/stream", "http://192.168.1.1/live.mp3", "http://10.0.0.5:8000/", "http://[::1]:8000/stream", "http://169.254.169.254/latest/meta-data/", "http://localhost/stream"]) {
      expect(await resolveStreamUrl(url), url).toEqual({ ok: false, error: "forbidden_host" });
    }
  });
  it("is returned as it is when its host is public (an address typed as a number needs no lookup)", async () => {
    expect(await resolveStreamUrl("http://93.184.216.34:8000/stream")).toEqual({ ok: true, streamUrl: "http://93.184.216.34:8000/stream" });
  });
  it("keeps the twitch and youtube spellings out of the host check", async () => {
    expect(await resolveStreamUrl("https://www.twitch.tv/squorli_test")).toMatchObject({ ok: true });
  });
});
