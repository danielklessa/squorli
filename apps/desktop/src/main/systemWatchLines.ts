import type { SystemActivityEvent } from "@squorli/web/platform/bridge";
import type { WindowInfo } from "./captureSource";

/**
 * `game`: a watched program came to the front (its executable's path), null = it has ended. `window` / `windows`: the answer
 * to a question about windows (one line per window, then the end of that request). All of them stay in the main process.
 */
export type SystemWatchLine = SystemActivityEvent | { type: "game"; path: string | null } | { type: "window"; request: number; info: WindowInfo } | { type: "windows"; request: number } | { type: "key"; scan: number; down: boolean } | { type: "busy"; request: number; state: number; fullscreen: boolean };

/**
 * The system watch helper's output (apps/desktop/native/system-watch) as events: one line each, "input", "display 0|1",
 * "game <path>" or "game", "key <hex scan code> 1|0" (a watched key pressed or released, hotkeys.ts), and tab separated
 * "window <request> <hwnd> <tool 0|1> <class> <path> <fullscreen 0|1>" and "windows <request>";
 * anything else ("ready", a line of a newer helper) is skipped. Chunks of stdout may end in the middle of a line, and of a
 * UTF-8 character: the caller decodes with a `StringDecoder`.
 */
export class SystemWatchLines {
  private rest = "";

  push(chunk: string): SystemWatchLine[] {
    const lines = (this.rest + chunk).split("\n");
    this.rest = lines.pop() ?? "";
    // A helper gone wild must not grow this without end.
    if (this.rest.length > 4096) this.rest = "";
    return lines.flatMap((line) => { const event = parseLine(line.trim()); return event ? [event] : []; });
  }
}

function parseLine(line: string): SystemWatchLine | null {
  if (line === "input") return { type: "input" };
  if (line === "display 1") return { type: "display", required: true };
  if (line === "display 0") return { type: "display", required: false };
  if (line === "game") return { type: "game", path: null };
  if (line.startsWith("game ")) return { type: "game", path: line.slice(5) };
  if (line.startsWith("key ")) {
    const m = /^key ([0-9a-f]{1,4}) ([01])$/.exec(line);
    return m ? { type: "key", scan: parseInt(m[1]!, 16), down: m[2] === "1" } : null;
  }
  if (line.startsWith("busy\t")) {
    const m = /^busy\t(\d{1,15})\t(\d)\t([01])$/.exec(line);
    return m ? { type: "busy", request: Number(m[1]), state: Number(m[2]), fullscreen: m[3] === "1" } : null;
  }
  if (line.startsWith("window\t") || line.startsWith("windows\t")) {
    const [kind, request, hwnd, tool, className, path, fullscreen] = line.split("\t");
    if (!request || !/^\d{1,15}$/.test(request)) return null;
    if (kind === "windows") return { type: "windows", request: Number(request) };
    // A helper from before the full screen field ends in the path, and an empty one was taken away by the trim.
    if (!hwnd || !/^\d{1,20}$/.test(hwnd) || (tool !== "0" && tool !== "1")) return null;
    return { type: "window", request: Number(request), info: { hwnd, tool: tool === "1", className: className ?? "", path: path ?? "", fullscreen: fullscreen === "1" } };
  }
  return null;
}
