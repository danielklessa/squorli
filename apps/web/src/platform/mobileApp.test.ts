import { describe, expect, it } from "vitest";
import { MOBILE_DIRECTORY_URL, inMobileApp, mobileDirectoryUrl } from "./mobileApp";

describe("inMobileApp", () => {
  it("is the app only where Capacitor's native bridge says so", () => {
    expect(inMobileApp(undefined)).toBe(false);
    expect(inMobileApp({})).toBe(false);
    // @capacitor/core in a browser answers "web" and false.
    expect(inMobileApp({ isNativePlatform: () => false, getPlatform: () => "web" })).toBe(false);
    expect(inMobileApp({ isNativePlatform: () => true, getPlatform: () => "ios" })).toBe(true);
    expect(inMobileApp({ isNativePlatform: (() => "yes") as unknown as () => boolean })).toBe(false);
  });
});

describe("mobileDirectoryUrl", () => {
  it("is the fixed directory in a built app and the local one from the dev server", () => {
    expect(mobileDirectoryUrl({ DEV: false, VITE_DIRECTORY_URL: "http://localhost:9999" })).toBe(MOBILE_DIRECTORY_URL);
    expect(mobileDirectoryUrl({ DEV: true })).toBe("http://localhost:3100");
    expect(mobileDirectoryUrl({ DEV: true, VITE_DIRECTORY_URL: "http://localhost:3101" })).toBe("http://localhost:3101");
  });
});
