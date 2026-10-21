import { describe, expect, it } from "vitest";
import { labelFromUserAgent } from "./useragent";

describe("labelFromUserAgent (M6c)", () => {
  const cases: [string, string | null][] = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", "Chrome auf Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0", "Edge auf Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox auf Linux"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "Safari auf iOS"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari auf macOS"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36", "Chrome auf Android"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Squorli-Desktop/0.1.0 Chrome/152.0.7977.130 Electron/44.4.2 Safari/537.36", "Squorli Desktop auf Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Squorli-Desktop/1.2.3 Chrome/152.0.0.0 Electron/44.4.2 Safari/537.36", "Squorli Desktop auf Linux"],
    // The mobile app: Android's WebView (as the emulator sent it on 20 October 2026) and iOS's WKWebView, each with the app's token appended.
    ["Mozilla/5.0 (Linux; Android 17; sdk_gphone64_x86_64 Build/CE2A.260420.019; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/145.0.7632.218 Mobile Safari/537.36 Squorli-Mobile/0.1.0", "Squorli App auf Android"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Squorli-Mobile/0.1.0", "Squorli App auf iOS"],
    ["node", "Browser"],
    ["", null],
  ];
  for (const [ua, expected] of cases) it(`${ua.slice(0, 40)} -> ${expected}`, () => expect(labelFromUserAgent(ua)).toBe(expected));
  it("undefined -> null", () => expect(labelFromUserAgent(undefined)).toBeNull());
});
