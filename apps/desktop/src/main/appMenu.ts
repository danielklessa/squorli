import { app, Menu } from "electron";
import type { ShellLanguage } from "./contextMenuItems";

/**
 * The application menu on macOS (21 October 2026, docs/features/desktop.md "macOS build"). Windows and Linux have none
 * (`win.removeMenu()`, the client draws the title bar). On a Mac the menu bar belongs to the app, and without a menu of its
 * own Electron shows its default one (Reload, Toggle Developer Tools, "Learn More"); with none at all Cmd+C/V/X/A/Q/W/M/H stop
 * working, because those shortcuts live in the menu. So the shell sets the three standard menus with Electron's roles
 * (the system's actions and shortcuts; "quit" goes through `app.quit()` and so through the quit hand-off) in the client's
 * language (`IPC.language`, like the tray), and nothing else: no View menu (it would carry Reload and the DevTools), the
 * fullscreen stays with the green window button.
 */
const LABELS: Record<ShellLanguage, { edit: string; window: string }> = { de: { edit: "Bearbeiten", window: "Fenster" }, en: { edit: "Edit", window: "Window" } };

export function applyAppMenu(language: ShellLanguage): void {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu", label: app.name },
    { role: "editMenu", label: LABELS[language].edit },
    { role: "windowMenu", label: LABELS[language].window },
  ]));
}
