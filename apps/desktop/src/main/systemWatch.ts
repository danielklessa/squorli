import { ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { IPC, type SystemActivityEvent } from "@squorli/web/platform/bridge";
import type { WindowInfo } from "./captureSource";
import { keysLine } from "./keyCodes";
import { SystemWatchLines } from "./systemWatchLines";
import { nativeHelperPath } from "./windowAudio";
import { inFullscreen } from "./notifications";

/**
 * What the client's AFK detection cannot see from inside the window (docs/features/afk.md, 20 September 2026): the native
 * helper `squorli-system-watch.exe` (apps/desktop/native, Windows) reports controller input, which Chromium's Gamepad API only
 * delivers while the window has the focus, and whether some program keeps the display on (a playing video). It runs as long
 * as the app does. Optional like the audio helper: without it (not built, other platform) nothing is reported.
 */
export const systemWatchPath = (): string | null => nativeHelperPath("squorli-system-watch.exe");

const RESTART_MS = 5000;
const MAX_RESTARTS = 5;
const WINDOWS_TIMEOUT_MS = 700;
const BUSY_TIMEOUT_MS = 400;

export type SystemWatch = {
  /** The helper exists on this system (built, Windows); without it nothing below does anything. */
  available(): boolean;
  /** The helper's watch list (its stdin line, games/match.ts); kept and sent again when the helper had to be restarted. */
  setWatch(line: string): void;
  /** A watched program came to the front (its path), or null = it has ended. */
  onGame(cb: (path: string | null) => void): void;
  /** The keys the helper watches across the system (scan codes, keyCodes.ts; the push-to-talk key, hotkeys.ts); empty = none. Kept over a restart. */
  setKeys(scans: readonly number[]): void;
  /** A watched key was pressed or released; null = the helper is gone (whatever was down is up). */
  onKey(cb: (event: { scan: number; down: boolean } | null) => void): void;
  /** What the helper says about these windows (decimal handles); a window it does not answer for is missing, without the helper all are. Never rejects. */
  describeWindows(hwnds: readonly string[]): Promise<WindowInfo[]>;
  /** Whether a game or another application runs in full screen (notifications.ts `inFullscreen`); null = unknown (no helper, an older one, no answer in time). */
  fullscreenBusy(): Promise<boolean | null>;
  stop(): void;
};

export function startSystemWatch(getWindow: () => BrowserWindow | null, isClientFrame: (event: IpcMainEvent) => boolean): SystemWatch {
  let child: ChildProcess | null = null;
  let watch = "watch";
  let keys = keysLine([]);
  let gameListener: (path: string | null) => void = () => {};
  let keyListener: (event: { scan: number; down: boolean } | null) => void = () => {};
  let stopped = false;
  let restarts = 0;
  let display: boolean | null = null;
  let nextRequest = 1;
  const asked = new Map<number, { found: WindowInfo[]; done: (found: WindowInfo[]) => void }>();
  const busyAsked = new Map<number, (busy: boolean) => void>();
  const send = (event: SystemActivityEvent) => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send(IPC.systemActivity, event); };
  // A client that starts listening (a reload too) learns the display state as it is; input only counts from now on.
  ipcMain.on(IPC.systemActivityReady, (event) => { if (isClientFrame(event) && display !== null) send({ type: "display", required: display }); });

  const run = () => {
    const helper = systemWatchPath();
    if (!helper || stopped) return;
    const lines = new SystemWatchLines();
    const decoder = new StringDecoder("utf8");
    const started = spawn(helper, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    child = started;
    started.stdin?.on("error", () => {});
    started.stdin?.write(`${watch}\n`);
    if (keys !== "keys") started.stdin?.write(`${keys}\n`);
    started.stdout?.on("data", (data: Buffer) => {
      for (const event of lines.push(decoder.write(data))) {
        if (event.type === "game") { gameListener(event.path); continue; }
        if (event.type === "key") { keyListener(event); continue; }
        if (event.type === "window") { asked.get(event.request)?.found.push(event.info); continue; }
        if (event.type === "windows") { const open = asked.get(event.request); open?.done(open.found); continue; }
        if (event.type === "busy") { busyAsked.get(event.request)?.(inFullscreen(event.state, event.fullscreen)); continue; }
        if (event.type === "display") display = event.required;
        send(event);
      }
    });
    started.on("error", () => {});
    started.on("exit", () => {
      if (child === started) { child = null; gameListener(null); keyListener(null); }
      if (stopped || restarts >= MAX_RESTARTS) return;
      restarts++;
      setTimeout(run, RESTART_MS);
    });
  };
  run();

  return {
    available: () => systemWatchPath() !== null,
    setWatch: (line) => { watch = line; child?.stdin?.write(`${line}\n`); },
    onGame: (cb) => { gameListener = cb; },
    setKeys: (scans) => { keys = keysLine(scans); child?.stdin?.write(`${keys}\n`); },
    onKey: (cb) => { keyListener = cb; },
    describeWindows: (hwnds) => new Promise((resolve) => {
      const stdin = child?.stdin;
      const ids = hwnds.filter((hwnd) => /^\d{1,20}$/.test(hwnd));
      if (!stdin || ids.length === 0) { resolve([]); return; }
      const request = nextRequest++;
      // A helper from before the question never answers: the picker then shows everything, as it did.
      const timer = setTimeout(() => { asked.delete(request); resolve([]); }, WINDOWS_TIMEOUT_MS);
      asked.set(request, { found: [], done: (found) => { clearTimeout(timer); asked.delete(request); resolve(found); } });
      stdin.write(`windows\t${request}\t${ids.join("\t")}\n`);
    }),
    fullscreenBusy: () => new Promise((resolve) => {
      const stdin = child?.stdin;
      if (!stdin) { resolve(null); return; }
      const request = nextRequest++;
      // A helper from before the question never answers: the notification then shows, as it did.
      const timer = setTimeout(() => { busyAsked.delete(request); resolve(null); }, BUSY_TIMEOUT_MS);
      busyAsked.set(request, (busy) => { clearTimeout(timer); busyAsked.delete(request); resolve(busy); });
      stdin.write(`busy\t${request}\n`);
    }),
    stop: () => {
      stopped = true;
      const running = child;
      child = null;
      if (!running) return;
      // Closing stdin is the helper's signal to end; the kill is the safety net.
      running.stdin?.end();
      setTimeout(() => { if (running.exitCode === null) running.kill(); }, 500);
    },
  };
}
