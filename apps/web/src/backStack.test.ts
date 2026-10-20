import { describe, expect, it } from "vitest";
import { createBackStack } from "./backStack";

describe("back stack", () => {
  it("closes the newest overlay first, pages after all overlays, and says when nothing is open", () => {
    const stack = createBackStack(), closed: string[] = [];
    const page = stack.push(() => closed.push("chat"), "page");
    stack.push(() => closed.push("settings"));
    const menu = stack.push(() => closed.push("menu"));
    // A page that comes up while a dialog is open still waits for the dialog.
    stack.push(() => closed.push("stage"), "page");
    expect(stack.back()).toBe(true);
    expect(closed).toEqual(["menu"]);
    menu();
    stack.back();
    expect(closed).toEqual(["menu", "settings"]);
  });

  it("forgets what unregistered, also out of order", () => {
    const stack = createBackStack(), closed: string[] = [];
    const a = stack.push(() => closed.push("a"));
    const b = stack.push(() => closed.push("b"));
    a(); a();
    stack.back();
    b();
    expect(stack.back()).toBe(false);
    expect(closed).toEqual(["b"]);
  });

  it("goes back one page at a time once no overlay is left", () => {
    const stack = createBackStack(), closed: string[] = [];
    stack.push(() => closed.push("list"), "page");
    const chat = stack.push(() => { closed.push("chat"); chat(); }, "page");
    stack.back(); stack.back();
    expect(closed).toEqual(["chat", "list"]);
  });
});
