import { describe, expect, it } from "vitest";
import { buildNumber, withIosVersion } from "./versions.mjs";

describe("buildNumber", () => {
  it("grows with the version", () => {
    expect(buildNumber("0.1.0")).toBe(1000);
    expect(buildNumber("1.2.3")).toBe(1002003);
    expect(buildNumber("0.10.0")).toBeGreaterThan(buildNumber("0.9.999"));
    expect(buildNumber("2.0.0-beta.1")).toBe(2000000);
  });
  it("refuses what it cannot count", () => {
    expect(() => buildNumber("1.0")).toThrow();
    expect(() => buildNumber("1.1000.0")).toThrow();
  });
});

describe("withIosVersion", () => {
  const project = "\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 1.0;\n\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 1.0;\n";
  it("sets every build configuration", () => {
    const out = withIosVersion(project, "0.2.1");
    expect(out.match(/MARKETING_VERSION = 0\.2\.1;/g)).toHaveLength(2);
    expect(out.match(/CURRENT_PROJECT_VERSION = 2001;/g)).toHaveLength(2);
  });
  it("stops on a project without the settings", () => {
    expect(() => withIosVersion("nothing", "0.1.0")).toThrow();
  });
});
