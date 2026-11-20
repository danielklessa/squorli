import { describe, expect, it } from "vitest";
import { SystemWatchLines } from "./systemWatchLines";

describe("SystemWatchLines", () => {
  it("turns the helper's lines into events and skips what it does not know", () => {
    const lines = new SystemWatchLines();
    expect(lines.push("ready\r\ndisplay 0\r\ninput\r\nfuture 7\r\ndisplay 1\r\n")).toEqual([{ type: "display", required: false }, { type: "input" }, { type: "display", required: true }]);
  });

  it("waits for the rest of a line that was cut in two", () => {
    const lines = new SystemWatchLines();
    expect(lines.push("inp")).toEqual([]);
    expect(lines.push("ut\ndisp")).toEqual([{ type: "input" }]);
    expect(lines.push("lay 1\n")).toEqual([{ type: "display", required: true }]);
  });

  it("reads the game lines, paths with spaces included", () => {
    const lines = new SystemWatchLines();
    expect(lines.push("game G:\\Program Files (x86)\\Steam\\steamapps\\common\\Spiel Ä\\game.exe\r\ngame\r\n")).toEqual([{ type: "game", path: "G:\\Program Files (x86)\\Steam\\steamapps\\common\\Spiel Ä\\game.exe" }, { type: "game", path: null }]);
  });

  it("reads the answer about windows, a window without a path included", () => {
    const lines = new SystemWatchLines();
    expect(lines.push("window\t3\t1312345\t1\tRainmeterMeterWindow\tC:/Program Files/Rainmeter/Rainmeter.exe\t0\r\nwindow\t3\t77\t0\tUnrealWindow\t\t1\r\nwindow\t3\t78\t0\tOld\t\r\nwindows\t3\r\n")).toEqual([
      { type: "window", request: 3, info: { hwnd: "1312345", tool: true, className: "RainmeterMeterWindow", path: "C:/Program Files/Rainmeter/Rainmeter.exe", fullscreen: false } },
      { type: "window", request: 3, info: { hwnd: "77", tool: false, className: "UnrealWindow", path: "", fullscreen: true } },
      { type: "window", request: 3, info: { hwnd: "78", tool: false, className: "Old", path: "", fullscreen: false } },
      { type: "windows", request: 3 },
    ]);
    expect(lines.push("window\tx\t1\nwindow\t3\tabc\t0\tA\t\nwindows\n")).toEqual([]);
  });

  it("drops a line that never ends", () => {
    const lines = new SystemWatchLines();
    expect(lines.push("x".repeat(5000))).toEqual([]);
    expect(lines.push("input\n")).toEqual([{ type: "input" }]);
  });
});

describe("SystemWatchLines key lines", () => {
  it("reads a watched key's press and release as hex scan codes", () => {
    const lines = new SystemWatchLines();
    expect(lines.push("key 39 1\r\nkey 11d 0\r\nkey zz 1\r\nkey 39\r\nkey 39 2\r\n")).toEqual([{ type: "key", scan: 0x39, down: true }, { type: "key", scan: 0x11d, down: false }]);
  });
});

describe("SystemWatchLines front lines", () => {
  it("reads the foreground window with its handle, path and full screen mark, and the empty line as none", () => {
    const lines = new SystemWatchLines();
    expect(lines.push("front\t1234\tC:\Games\Some Game\game.exe\t1\nfront\t77\t\t0\nfront\nfront\tabc\tx\t0\n")).toEqual([
      { type: "front", window: { hwnd: "1234", path: "C:\Games\Some Game\game.exe", fullscreen: true } },
      { type: "front", window: { hwnd: "77", path: "", fullscreen: false } },
      { type: "front", window: null },
    ]);
  });
});
