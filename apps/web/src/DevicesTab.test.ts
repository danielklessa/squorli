import { DESKTOP_APP_ORIGIN } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { deviceLabel, deviceOrigin } from "./DevicesTab";
import { t } from "./i18n";

// Every sign-in says where it came from (the user's decision of 30 September 2026, docs/features/devices.md).
describe("what a device is called in the lists", () => {
  it("names the site a browser signed in from", () => {
    expect(deviceLabel({ label: "Chrome auf Windows", origin: "chat.example.org" })).toBe(`Chrome auf Windows ${t("devices.via", { origin: "chat.example.org" })}`);
  });
  it("names the desktop app by its name, never by its internal address", () => {
    const label = deviceLabel({ label: "Squorli Desktop auf Windows", origin: DESKTOP_APP_ORIGIN });
    expect(label).toBe(`Squorli Desktop auf Windows ${t("devices.viaApp")}`);
    expect(label).not.toContain("app://");
  });
  it("says nothing where the origin is unknown, and has a word for an unknown device", () => {
    expect(deviceOrigin(null)).toBe("");
    expect(deviceLabel({ label: null, origin: null })).toBe(t("profile.unknownDevice"));
  });
});
