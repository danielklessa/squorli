import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CrashScreen, ErrorBoundary, describeError } from "./ErrorBoundary";
import { t } from "./i18n";

describe("the notice in place of a failed interface", () => {
  it("names an error in one line", () => {
    expect(describeError(new Error("Rendered more hooks than during the previous render."))).toBe("Error: Rendered more hooks than during the previous render.");
    expect(describeError(new TypeError("x is undefined"))).toBe("TypeError: x is undefined");
    expect(describeError("nur Text")).toBe("nur Text");
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
  });

  it("cuts a long one off and survives what cannot be named", () => {
    const long = describeError(new Error("x".repeat(2000)));
    expect(long.length).toBe(500);
    expect(long.endsWith("…")).toBe(true);
    expect(describeError({ toString() { throw new Error("no"); } })).toBe("?");
  });

  it("offers the reload and shows the error", () => {
    const html = renderToStaticMarkup(<CrashScreen error={new Error("kaputt <b>")} onReload={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(`<h2>${t("crash.title")}</h2>`);
    expect(html).toContain(`>${t("crash.reload")}</button>`);
    expect(html).toContain("<pre>Error: kaputt &lt;b&gt;</pre>");
  });

  it("turns an error into the fallback's state, also a thrown null", () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error("a"))).toMatchObject({ failed: true });
    expect(ErrorBoundary.getDerivedStateFromError(null)).toEqual({ failed: true, error: null });
  });

  it("shows its children while nothing failed", () => {
    expect(renderToStaticMarkup(<ErrorBoundary fallback={() => <i>x</i>}><b>ok</b></ErrorBoundary>)).toBe("<b>ok</b>");
  });
});
