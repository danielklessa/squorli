import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { platform } from "./platform";
import { DOWNLOAD_URL, useUpdateState } from "./appUpdates";

/**
 * The desktop app's own title bar (user's wish, 18 September 2026): the window has no system frame, so this slim bar drags the
 * window (`-webkit-app-region: drag` in styles.css; a double click maximizes: Windows does that for a drag region, and for the
 * see-through window, which Windows cannot maximize, the shell does it from the system's command, apps/desktop
 * `systemCommands.ts`) and carries the three window buttons, except on macOS, where the system's own buttons sit over the bar's left end (the shell keeps them,
 * `titleBarStyle: "hidden"`; 21 October 2026). Renders nothing in a browser (`platform.window.frame` is null) and in fullscreen.
 * When an update is downloaded it offers the restart (`onRestartForUpdate`: App.tsx asks first while in a voice channel);
 * a deb installation, which cannot update itself, gets the way to the download page instead.
 * The debug button lives here while the bar is shown (user's wish, 14 October 2026: on the right, with some room left of the
 * three window buttons); App.tsx asks `useTitleBarShown()` and leaves the header's button out meanwhile.
 */
export function TitleBar({ title, onRestartForUpdate, debug }: { title: string; onRestartForUpdate?: () => void; debug?: { on: boolean; toggle: () => void } }) {
  const frame = platform.window.frame;
  const update = useUpdateState();
  const state = useFrameState();
  if (!frame || !state || state.fullscreen) return null;
  return (
    <header className={`titlebar ${state.focused ? "" : "inactive"}`}>
      <img className="titlebar-mark" src="/brand/squorli-icon-small.svg" alt="" width="16" height="16" />
      <span className="titlebar-title">{title}</span>
      {update?.status === "ready" && <button className="titlebar-update" title={t("update.ready", { v: update.version })} onClick={() => (onRestartForUpdate ?? (() => platform.updates?.restartAndInstall()))()}><Icon name="download" /> {t("update.restart")}</button>}
      {update?.status === "available" && update.manual && <button className="titlebar-update" title={t("update.availableManual", { v: update.version })} onClick={() => platform.links.openExternal(DOWNLOAD_URL)}><Icon name="download" /> {t("update.get", { v: update.version })}</button>}
      {debug && <button className={`titlebar-btn titlebar-debug${debug.on ? " on" : ""}`} aria-pressed={debug.on} title={t("app.debug")} aria-label={t("app.debug")} onClick={debug.toggle}><Icon name="bug" /></button>}
      {platform.os !== "macos" && <div className="titlebar-buttons">
        <button className="titlebar-btn" title={t("window.minimize")} aria-label={t("window.minimize")} onClick={() => frame.control("minimize")}><Icon name="minus" /></button>
        <button className="titlebar-btn" title={state.maximized ? t("window.restore") : t("window.maximize")} aria-label={state.maximized ? t("window.restore") : t("window.maximize")} onClick={() => frame.control("toggle-maximize")}><Icon name={state.maximized ? "copy" : "square"} /></button>
        <button className="titlebar-btn close" title={t("common.close")} aria-label={t("common.close")} onClick={() => frame.control("close")}><Icon name="x" /></button>
      </div>}
    </header>
  );
}

function useFrameState() {
  const frame = platform.window.frame;
  const [state, setState] = useState(() => frame?.state() ?? null);
  useEffect(() => frame?.subscribe(setState), [frame]);
  return state;
}

/** The title bar is on screen (the desktop app outside fullscreen): then it carries the debug button instead of the header. */
export function useTitleBarShown(): boolean {
  const state = useFrameState();
  return !!platform.window.frame && !!state && !state.fullscreen;
}
