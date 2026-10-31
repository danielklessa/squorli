/**
 * Maximizing the see-through window from Windows' own commands (31 October 2026, user: "Ein Doppelklick auf die Titelleiste in
 * der App soll das Fenster maximieren"). Electron takes `WS_CAPTION` and `WS_THICKFRAME` from every transparent window
 * (`native_window_views.cc`: "Transparent window must not have thick frame"; the thick frame would end the transparency).
 * Windows still answers a double click on the drag region with `WM_SYSCOMMAND` `SC_MAXIMIZE` (the taskbar's menu and the
 * keyboard send it too), but it cannot maximize a window without the thick frame, so nothing happened. The shell reads that
 * command (`BrowserWindow.hookWindowMessage`) and calls `maximize()`, which Electron emulates for such a window with the
 * display's work area. Checked on 31 October 2026 with a minimal window: of the mouse messages only `WM_SYSCOMMAND` reaches
 * the hook, `WM_NCLBUTTONDBLCLK` does not; the opaque and the mica window carry the styles and Windows maximizes them itself
 * (a hook there would toggle twice). The same missing styles cost the see-through window every snap gesture of Windows
 * (dragging to an edge, Win+arrows, the snap layouts), which nothing in the shell can give back (docs/features/desktop.md).
 * Pure; `index.ts` installs the hook.
 */
export const WM_SYSCOMMAND = 0x0112;
export const SC_MAXIMIZE = 0xf030;
/** The hit-test code of the caption: Windows puts it into the command's four low bits when the mouse on the caption caused it. */
export const HTCAPTION = 2;

/** Whether the shell maximizes from the system command itself: on Windows, for the window without the thick frame. */
export function ownsMaximizeCommand(platform: NodeJS.Platform, transparent: boolean): boolean {
  return platform === "win32" && transparent;
}

/** The value of a `wParam` as Electron hands it over: a little-endian Buffer of the pointer's size. -1 = unreadable. */
export function wParamOf(wParam: Buffer): number {
  if (wParam.length >= 4) return wParam.readUInt32LE(0);
  return wParam.length > 0 ? wParam.readUInt8(0) : -1;
}

/**
 * What a `WM_SYSCOMMAND` asks of the window: "toggle" for `SC_MAXIMIZE` from a double click on the caption (Windows would
 * restore a window it knows as maximized, but it never knows this one as maximized), "maximize" for `SC_MAXIMIZE` from the
 * taskbar's menu or the keyboard, null for every other command (move, size, minimize, close, the menu: Windows does those).
 */
export function maximizeCommandOf(wParam: Buffer): "toggle" | "maximize" | null {
  const value = wParamOf(wParam);
  if (value < 0 || (value & 0xfff0) !== SC_MAXIMIZE) return null;
  return (value & 0x000f) === HTCAPTION ? "toggle" : "maximize";
}
