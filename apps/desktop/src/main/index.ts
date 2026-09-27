import { app, BrowserWindow, ipcMain, nativeImage, Notification, screen, session, type IpcMainEvent, type IpcMainInvokeEvent, type Tray } from "electron";
import { randomBytes } from "node:crypto";
import { release } from "node:os";
import { join } from "node:path";
import { INFO_ARGUMENT, IPC, type AppearanceState, type DesktopInfo, type PlatformOs, type UpdateState, type WindowAppearance, type WindowFrameState } from "@squorli/web/platform/bridge";
import { APP_ORIGIN } from "./appFiles";
import { appearanceState, normalizeAppearance, supportedMaterials } from "./appearance";
import { attentionText, badgeFile, readAttentionCount } from "./attention";
import { readNotification } from "./notifications";
import { readAutostartBackground, startsInBackground } from "./autostart";
import { autostartEnabled, autostartSupported, setAutostart } from "./autostartSystem";
import { loadConfig, saveConfig } from "./config";
import { handleContextMenu } from "./contextMenu";
import { languageOfLocale, readShellLanguage, type ShellLanguage } from "./contextMenuItems";
import { findControl } from "./controlArgs";
import { findDeepLink } from "./deepLinkArgs";
import { handleGames } from "./gameWatch";
import { handleHotkeys, type Hotkeys } from "./hotkeys";
import { handleLinkLookup } from "./linkLookup";
import { handleDeepLinks } from "./deepLinks";
import { handleDisplayMedia } from "./displayMedia";
import { registerAppScheme, serveApp } from "./scheme";
import { PlayerAudioOutput } from "./playerAudio";
import { readPlayerOutputLabel } from "./playerAudioScript";
import { applyPermissions, focusPopout, letPlayersEmbed, lockDownContents, openExternal } from "./security";
import { createSplash, type Splash } from "./splash";
import { createTray, setTrayAttention, setTrayLanguage } from "./tray";
import { startSystemWatch, systemWatchPath } from "./systemWatch";
import { handleUpdates } from "./updates";
import { handleSecrets } from "./secrets";
import { desktopUserAgent } from "./userAgent";
import { helperPath, ScreenAudioCapture } from "./windowAudio";
import { DEFAULT_SIZE, MIN_SIZE, restoreWindowState } from "./windowState";

/**
 * Squorli desktop: an Electron shell around the web client (docs/features/desktop.md). It has no renderer code of its own:
 * the window shows the build of `apps/web` from `app://squorli`, and everything the client needs from the shell goes through
 * the preload bridge (`@squorli/web/platform/bridge`).
 *
 * Development: `--dev-url=http://localhost:5173` shows the Vite server instead (with its own user data folder).
 */
const DIRECTORY_URL = "https://directory.squorli.com";

const argValue = (name: string): string | null => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
// Only an unpackaged app takes these: a packaged one always shows its own files and talks to the public directory.
const devUrl = app.isPackaged ? null : argValue("dev-url");
const directoryUrl = (app.isPackaged ? null : argValue("directory-url")) ?? DIRECTORY_URL;
const originOf = (url: string): string => { const u = new URL(url); return `${u.protocol}//${u.host}`; };
const origins = devUrl ? [APP_ORIGIN, originOf(devUrl)] : [APP_ORIGIN];

app.setName("Squorli");
// Windows groups task bar entries and notifications by this id; it equals the installer's appId. Unpackaged it also makes the
// task bar show the window's icon instead of Electron's.
if (process.platform === "win32") app.setAppUserModelId("com.squorli.desktop");
// A test that drives the app against a dev server passes `--user-data-dir` and keeps its hands off the developer's own data.
if (devUrl && !argValue("user-data-dir")) app.setPath("userData", join(app.getPath("appData"), "Squorli-dev"));
app.userAgentFallback = desktopUserAgent(app.userAgentFallback, app.getVersion());
registerAppScheme();

const os: PlatformOs = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "other";
// Window background (opaque, mica, or a see-through window, plus the opacity of the client's surfaces): per device, read
// before the window exists. Whether the window is see-through is fixed when it is created (appearance.ts).
const materials = supportedMaterials(process.platform, release());
let appearance: WindowAppearance = normalizeAppearance(loadConfig(app.getPath("userData")).appearance, materials);
const transparentWindow = appearance.material === "clear";
let look: AppearanceState = appearanceState(appearance, transparentWindow, transparentWindow ? "clear" : appearance.material);
const SOLID = "#0a0f1e";
/** Mica and opaque switch while the app runs; with mica the window's own colour must let the material through. */
function applyAppearance(win: BrowserWindow): void {
  if (transparentWindow || !materials.includes("mica")) return;
  win.setBackgroundMaterial(look.effective === "mica" ? "mica" : "none");
  win.setBackgroundColor(look.effective === "mica" ? "#00000000" : SOLID);
}
const frameOf = (win: BrowserWindow): WindowFrameState => ({ maximized: win.isMaximized(), focused: win.isFocused(), fullscreen: win.isFullScreen() });
/** App updates (updates.ts); set up once the app is ready. */
let updateState: () => UpdateState = () => ({ status: "unsupported" });

let mainWindow: BrowserWindow | null = null;
// The language of what the shell draws itself (the window's context menu, the tray's menu): the system's until the client says its own.
let language: ShellLanguage = "en";
// Global shortcuts and commands from outside (hotkeys.ts); set up once the app is ready.
let hotkeys: Hotkeys | null = null;
// Tray icon; with `closeToTray` the window's close button only hides the window. Quitting then goes through the tray's menu.
let tray: Tray | null = null;
let closeToTray = loadConfig(app.getPath("userData")).closeToTray === true;
let quitting = false;
// Started by the system (autostart.ts): the first window stays in the background, unless the user wants it opened.
let autostartBackground = readAutostartBackground(loadConfig(app.getPath("userData")).autostartBackground);
let backgroundStart = startsInBackground(process.argv, autostartBackground);
// The start window (splash.ts) stays until the client says its first screen is there; then the main window takes its place.
// A client that never says so (a page that failed to load) is shown after this long anyway.
const REVEAL_AFTER_MS = 12_000;
let reveal: (() => void) | null = null;
/** Development: how often the shell asks the Vite dev server of `--dev-url` again while it does not answer. */
const DEV_SERVER_RETRY_MS = 2000;
// Direct messages and mentions that wait, as the client counts them: a mark on the task bar icon and the tray icon.
let attention = 0;
function showAttention(): void {
  const text = attentionText(attention, app.getLocale().toLowerCase().startsWith("de"));
  setTrayAttention(tray, attention > 0, text);
  const win = mainWindow;
  if (process.platform === "win32") {
    if (!win || win.isDestroyed()) return;
    const file = badgeFile(attention);
    const image = file ? nativeImage.createFromPath(join(__dirname, "..", "build", file)) : null;
    win.setOverlayIcon(image && !image.isEmpty() ? image : null, attention > 0 ? text : "");
  } else app.setBadgeCount(attention); // the dock on macOS, the launcher of some Linux desktops; nothing elsewhere
}

// Notifications of the operating system (docs/features/notifications.md). Kept referenced until they are gone: a
// notification the garbage collector takes loses its click handler on Windows.
const notifications = new Set<Notification>();
function showNotification(value: unknown): void {
  const n = readNotification(value);
  if (!n || !Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body, silent: true, ...(process.platform === "win32" ? {} : { icon: join(__dirname, "..", "build", "icon.png") }) });
  const forget = () => { notifications.delete(note); };
  note.on("click", () => {
    forget();
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    win.webContents.send(IPC.notificationClick, n.tag);
  });
  note.on("close", forget);
  note.on("failed", forget);
  notifications.add(note);
  note.show();
}

/** The key of control links that could open the microphone (controlArgs.ts), made once per installation. */
let controlKeyValue: string | null = null;
function controlKey(): string {
  if (controlKeyValue) return controlKeyValue;
  const userData = app.getPath("userData");
  const config = loadConfig(userData);
  if (typeof config.controlKey === "string" && /^[A-Za-z0-9_-]{22,64}$/.test(config.controlKey)) return (controlKeyValue = config.controlKey);
  controlKeyValue = randomBytes(16).toString("base64url");
  saveConfig(userData, { ...config, controlKey: controlKeyValue });
  return controlKeyValue;
}

/** Messages count only when they come from the client's own main frame, never from an embedded player or a foreign page. */
const isClientFrame = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  try { return origins.includes(originOf(frame.url)); } catch { return false; }
};

function createWindow(splash: Splash | null = null): BrowserWindow {
  const info: DesktopInfo = { version: app.getVersion(), electron: process.versions.electron ?? "", chrome: process.versions.chrome ?? "", os, directoryUrl, materials, nativeScreenAudio: helperPath() !== null, systemWatch: systemWatchPath() !== null, gameDetection: systemWatchPath() !== null, appearance: look, frame: { maximized: false, focused: true, fullscreen: false }, tray: tray ? { closeToTray } : null, autostart: autostartSupported() ? { enabled: autostartEnabled(), background: autostartBackground } : null,
    // Global shortcuts everywhere; the push-to-talk key across the system only where the system watch helper runs (Windows).
    hotkeys: { globalPtt: systemWatchPath() !== null, executable: app.isPackaged ? process.execPath : null, controlKey: controlKey() }, update: updateState() };
  // The window reopens where it was closed, as long as that place still lies on a display (windowState.ts).
  const userData = app.getPath("userData");
  const state = restoreWindowState(loadConfig(userData).window, screen.getAllDisplays().map((d) => d.workArea));
  info.frame.maximized = state?.maximized === true;
  const win = new BrowserWindow({
    // No system title bar: the client draws its own (TitleBar.tsx). A see-through window must be frameless anyway.
    frame: false, transparent: transparentWindow,
    ...(state ? state.bounds : DEFAULT_SIZE), minWidth: MIN_SIZE.width, minHeight: MIN_SIZE.height, show: false,
    // A packaged app carries its icon in the executable; unpackaged the window names it, or Electron's icon shows.
    ...(app.isPackaged ? {} : { icon: join(__dirname, "..", "build", "icon.png") }), backgroundColor: look.effective === "none" ? SOLID : "#00000000", ...(look.effective === "mica" ? { backgroundMaterial: "mica" as const } : {}), autoHideMenuBar: true, title: "Squorli",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true,
      // Voice keeps running while the window is minimized or covered.
      backgroundThrottling: false,
      additionalArguments: [`${INFO_ARGUMENT}${Buffer.from(JSON.stringify(info)).toString("base64")}`],
    },
  });
  win.removeMenu();
  // The ordinary context menu (cut, copy, paste, spelling, a link, a picture), in the client's language (contextMenu.ts).
  handleContextMenu(win, () => language);
  if (state?.maximized) win.maximize();
  win.once("ready-to-show", () => {
    const background = backgroundStart;
    backgroundStart = false;
    // A start by the system does not put a window in front of the user: it waits in the tray, or minimized where closing quits.
    if (background) { if (!(closeToTray && tray)) win.minimize(); return; }
    // Behind the start window the client first finds out what to show (login, or the account's servers): no half-ready screen.
    if (!splash) { win.show(); return; }
    reveal = () => { reveal = null; clearRevealTimer(); if (!win.isDestroyed()) { win.show(); win.focus(); } splash.close(); };
    if (!waitingForDevServer) startRevealTimer();
  });
  // The client says its first screen is there (platform.window.ready) or this timer runs out: the window is shown either way.
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  const clearRevealTimer = () => { if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; } };
  const startRevealTimer = () => { clearRevealTimer(); revealTimer = setTimeout(() => reveal?.(), REVEAL_AFTER_MS); };
  // Development: the Vite dev server of `--dev-url` does not answer (`pnpm dev` stopped, which also runs the web client; the
  // user's report of 26 September 2026, an empty window without even a title bar). The start window says so and the page is
  // loaded again as soon as the server answers; the empty window is not shown meanwhile (docs/features/desktop.md).
  let waitingForDevServer = false;
  let devRetry: ReturnType<typeof setTimeout> | null = null;
  const askDevServer = () => {
    devRetry = null;
    if (!devUrl || win.isDestroyed()) return;
    fetch(devUrl, { method: "HEAD" }).then((r) => {
      if (win.isDestroyed()) return;
      if (!r.ok) throw new Error(String(r.status));
      waitingForDevServer = false;
      splash?.show({ step: "starting" });
      if (reveal) startRevealTimer();
      void win.loadURL(devUrl);
    }).catch(() => { devRetry = setTimeout(askDevServer, DEV_SERVER_RETRY_MS); });
  };
  win.webContents.on("did-fail-load", (_event, errorCode, _description, url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = aborted: a newer load replaced this one
    if (devUrl && url.startsWith(devUrl)) {
      waitingForDevServer = true;
      clearRevealTimer();
      splash?.show({ step: "devServer", url: devUrl });
      if (!devRetry) devRetry = setTimeout(askDevServer, DEV_SERVER_RETRY_MS);
      return;
    }
    reveal?.();
  });
  // The task bar button is new whenever the window was hidden: put the mark back.
  win.on("show", () => showAttention());
  // The own title bar shows the window's state (maximize or restore, dimmed while inactive).
  const tellFrame = () => { if (!win.isDestroyed()) win.webContents.send(IPC.windowFrame, frameOf(win)); };
  win.on("maximize", tellFrame); win.on("unmaximize", tellFrame); win.on("focus", tellFrame); win.on("blur", tellFrame);
  win.on("enter-full-screen", tellFrame); win.on("leave-full-screen", tellFrame); win.on("restore", tellFrame);
  win.webContents.on("did-finish-load", tellFrame);
  // Remembered when it closes, and a moment after every move or resize (a crash or a shutdown skips "close").
  let rememberTimer: ReturnType<typeof setTimeout> | null = null;
  const remember = () => {
    if (rememberTimer) { clearTimeout(rememberTimer); rememberTimer = null; }
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    saveConfig(userData, { ...loadConfig(userData), window: { bounds: win.getNormalBounds(), maximized: win.isMaximized() } });
  };
  const rememberSoon = () => { if (rememberTimer) clearTimeout(rememberTimer); rememberTimer = setTimeout(remember, 800); };
  win.on("resize", rememberSoon); win.on("move", rememberSoon); win.on("close", remember);
  win.on("close", (event) => { if (closeToTray && tray && !quitting) { event.preventDefault(); win.hide(); } });
  win.on("closed", () => { if (rememberTimer) clearTimeout(rememberTimer); if (devRetry) clearTimeout(devRetry); clearRevealTimer(); if (mainWindow === win) mainWindow = null; });
  void win.loadURL(devUrl ?? `${APP_ORIGIN}/`);
  return win;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  const links = handleDeepLinks(() => mainWindow, isClientFrame);
  // A second start (the system opening a `squorli://` link while the app runs) hands its arguments over and quits.
  app.on("second-instance", (_event, argv) => {
    // A command from outside (`squorli://control/<action>`, `--control=<action>`: a Stream Deck, G Hub, a macro) is carried
    // out without bringing the window to the front; whoever pressed it is in a game or elsewhere (hotkeys.ts).
    const control = findControl(argv, controlKey());
    if (control) { hotkeys?.control(control); return; }
    links.deliver(findDeepLink(argv));
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  lockDownContents(origins);
  void app.whenReady().then(() => {
    // Windows knows the locale only from here on; the client says its own language once it runs (`IPC.language`).
    language = languageOfLocale(app.getLocale());
    // Unpackaged: the build of the sibling package; packaged: electron-builder copies it next to the app (extraResources).
    const rendererRoot = app.isPackaged ? join(process.resourcesPath, "renderer") : join(__dirname, "..", "..", "web", "dist");
    serveApp(rendererRoot);
    // The client's keys, encrypted by the system (secrets.ts); before the window: its preload asks at once.
    handleSecrets(app.getPath("userData"), isClientFrame);
    // The embedded players' sound on the output device chosen for the web radio (the client names it by its label).
    const playerAudio = new PlayerAudioOutput(app.isPackaged ? undefined : (text) => console.log(text));
    applyPermissions(session.defaultSession, origins, () => playerAudio.granting());
    ipcMain.on(IPC.playerOutput, (event, label: unknown) => { if (isClientFrame(event)) playerAudio.setLabel("radio", readPlayerOutputLabel(label)); });
    ipcMain.on(IPC.chatPlayerOutput, (event, label: unknown) => { if (isClientFrame(event)) playerAudio.setLabel("chat", readPlayerOutputLabel(label)); });
    if (app.isPackaged || !process.argv.includes("--no-player-fix")) letPlayersEmbed(session.defaultSession);
    const screenAudio = new ScreenAudioCapture();
    ipcMain.on(IPC.screenAudioStop, (event) => { if (isClientFrame(event)) screenAudio.stop(); });
    // Controller input and "display required" for the client's AFK detection (native helper, Windows).
    const systemWatch = startSystemWatch(() => mainWindow, isClientFrame);
    // Link previews of direct messages: the sender's app asks the linked host itself (linkLookup.ts).
    handleLinkLookup(isClientFrame);
    // Game detection: the launchers' installed games, and the helper says when one of them is in front (gameWatch.ts).
    const games = handleGames(() => mainWindow, isClientFrame, systemWatch);
    handleDisplayMedia(session.defaultSession, isClientFrame, screenAudio, systemWatch, games);
    // Global shortcuts, the push-to-talk key across the system, commands from outside (hotkeys.ts).
    hotkeys = handleHotkeys(() => mainWindow, isClientFrame, systemWatch, app.isPackaged ? undefined : (text) => console.log(text));
    app.on("before-quit", () => { quitting = true; screenAudio.stop(); playerAudio.stop(); systemWatch.stop(); hotkeys?.stop(); });
    ipcMain.handle(IPC.setAppearance, (event, next: unknown) => {
      if (!isClientFrame(event)) return look;
      appearance = normalizeAppearance(next, materials);
      saveConfig(app.getPath("userData"), { ...loadConfig(app.getPath("userData")), appearance });
      look = appearanceState(appearance, transparentWindow, look.effective);
      if (mainWindow) applyAppearance(mainWindow);
      return look;
    });
    ipcMain.on(IPC.relaunch, (event) => { if (isClientFrame(event)) { app.relaunch(); app.quit(); } });
    ipcMain.on(IPC.windowControl, (event, action: unknown) => {
      const win = mainWindow;
      if (!isClientFrame(event) || !win) return;
      if (action === "minimize") win.minimize();
      else if (action === "toggle-maximize") { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
      else if (action === "close") win.close();
    });
    ipcMain.handle(IPC.setCloseToTray, (event, on: unknown) => {
      if (!isClientFrame(event)) return closeToTray;
      closeToTray = on === true;
      saveConfig(app.getPath("userData"), { ...loadConfig(app.getPath("userData")), closeToTray });
      return closeToTray;
    });
    ipcMain.handle(IPC.setAutostart, (event, on: unknown) => isClientFrame(event) ? setAutostart(on === true) : autostartEnabled());
    ipcMain.handle(IPC.setAutostartBackground, (event, on: unknown) => {
      if (!isClientFrame(event)) return autostartBackground;
      autostartBackground = on === true;
      saveConfig(app.getPath("userData"), { ...loadConfig(app.getPath("userData")), autostartBackground });
      return autostartBackground;
    });
    ipcMain.on(IPC.attention, (event, count: unknown) => { if (isClientFrame(event)) { attention = readAttentionCount(count); showAttention(); } });
    ipcMain.on(IPC.notify, (event, value: unknown) => { if (isClientFrame(event)) showNotification(value); });
    ipcMain.on(IPC.focusPopout, (event, name: unknown) => { if (isClientFrame(event)) focusPopout(name); });
    ipcMain.on(IPC.language, (event, value: unknown) => { if (isClientFrame(event)) { language = readShellLanguage(value, language); setTrayLanguage(tray, language); } });
    ipcMain.on(IPC.openExternal, (event, url: unknown) => { if (isClientFrame(event) && typeof url === "string") openExternal(url); });
    tray = createTray(() => mainWindow, () => { quitting = true; app.quit(); }, language);
    const updates = handleUpdates(() => mainWindow, isClientFrame, () => { quitting = true; screenAudio.stop(); systemWatch.stop(); });
    updateState = updates.state;
    ipcMain.on(IPC.clientReady, (event) => { if (isClientFrame(event)) reveal?.(); });
    // `--no-splash` (unpackaged only): the main window at once, to look at what the client itself shows while it starts.
    if (backgroundStart || (!app.isPackaged && process.argv.includes("--no-splash"))) { updates.checkSoon(); mainWindow = createWindow(); }
    else {
      // The start window first: it shows the update check, and an update is installed there before the client opens.
      const splash = createSplash(rendererRoot);
      splash.show({ step: "checking" });
      void updates.checkAtStart(splash).catch(() => "continue" as const).then((result) => {
        if (result === "installing") return;
        splash.show({ step: "starting" });
        mainWindow = createWindow(splash);
      });
    }
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
