import { describe, expect, it } from "vitest";
import { shareInFront, type SharedSource } from "./shareFront";

const own = { windows: new Set(["500"]), path: "C:\\Apps\\Squorli\\Squorli.exe" };
const game: SharedSource = { kind: "window", hwnd: "1234", path: "C:\\Games\\Game\\game.exe" };
const screen: SharedSource = { kind: "screen", hwnd: null, path: "" };

describe("shareInFront", () => {
  it("knows nothing without a share or without a foreground window", () => {
    expect(shareInFront(null, { hwnd: "1234", path: game.path, fullscreen: true }, own)).toBe(false);
    expect(shareInFront(game, null, own)).toBe(false);
  });

  it("a shared window is in front as itself or as another window of its program, whatever the case of the path", () => {
    expect(shareInFront(game, { hwnd: "1234", path: game.path, fullscreen: false }, own)).toBe(true);
    expect(shareInFront(game, { hwnd: "99", path: "c:\\games\\game\\GAME.EXE", fullscreen: false }, own)).toBe(true);
    expect(shareInFront(game, { hwnd: "99", path: "C:\\Other\\other.exe", fullscreen: true }, own)).toBe(false);
    // A window whose program is unknown counts by its handle only.
    expect(shareInFront({ ...game, path: "" }, { hwnd: "99", path: "", fullscreen: false }, own)).toBe(false);
    expect(shareInFront({ ...game, path: "" }, { hwnd: "1234", path: "", fullscreen: false }, own)).toBe(true);
  });

  it("a shared screen is in front while some other program covers its monitor", () => {
    expect(shareInFront(screen, { hwnd: "99", path: "C:\\Games\\Game\\game.exe", fullscreen: true }, own)).toBe(true);
    expect(shareInFront(screen, { hwnd: "99", path: "C:\\Games\\Game\\game.exe", fullscreen: false }, own)).toBe(false);
  });

  it("Squorli's own windows in front never count", () => {
    expect(shareInFront(screen, { hwnd: "500", path: own.path, fullscreen: true }, own)).toBe(false);
    expect(shareInFront(screen, { hwnd: "501", path: own.path.toUpperCase(), fullscreen: true }, own)).toBe(false);
    expect(shareInFront({ kind: "window", hwnd: "500", path: own.path }, { hwnd: "500", path: own.path, fullscreen: false }, own)).toBe(false);
  });
});
