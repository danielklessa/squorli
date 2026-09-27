import type { AppearanceState, DesktopBridge, ScreenCodec, UpdateState, WindowFrameState } from "./bridge";
import { parseDeepLink } from "./deepLink";
import { screenAudio } from "./screenAudio";
import type { Platform, ScreenPicker } from "./types";
import { popoutFeatures } from "./web";

/** The desktop app: no home server, the directory is fixed, and the shell (Electron main process) does what a browser would. */
export function desktopPlatform(bridge: DesktopBridge): Platform {
  const info = bridge.info;

  const audio = screenAudio(bridge);
  let picker: ScreenPicker | null = null;
  // The codec chosen with the last pick; the voice client asks for it after the capture and before it publishes the share.
  let pickedCodec: ScreenCodec = "vp8";
  bridge.onScreenPickRequest((request) => {
    const answer = picker ? picker(request.sources).catch(() => null) : Promise.resolve(null);
    void answer.then((pick) => {
      pickedCodec = pick?.codec === "h264" || pick?.codec === "h265" ? pick.codec : "vp8";
      // With the native helper the shell captures the audio itself and sends it over; the voice client takes it after the share started.
      audio.expect(!!pick?.audio && info.nativeScreenAudio);
      bridge.answerScreenPick(request.requestId, pick);
    });
  });

  let look: AppearanceState = info.appearance;
  // The page follows the window as it really is (`effective`): with mica or a see-through window the body lets it through and
  // the surfaces take the chosen opacity (styles.css). The own title bar needs its height reserved (modals start below it).
  const paint = () => {
    const root = document.documentElement;
    if (look.effective === "none") { delete root.dataset.material; root.style.removeProperty("--win-alpha"); }
    else { root.dataset.material = look.effective; root.style.setProperty("--win-alpha", String(look.appearance.opacity)); }
  };
  paint();
  document.documentElement.dataset.desktop = info.os;

  let closeToTray = info.tray?.closeToTray ?? false;
  let autostart = info.autostart?.enabled ?? false;
  let autostartBackground = info.autostart?.background ?? true;
  let frame: WindowFrameState = info.frame;
  const frameListeners = new Set<(state: WindowFrameState) => void>();
  // The page knows the window's state too (styles.css: a see-through window shows its outline while it has the focus).
  const markFrame = () => { document.documentElement.dataset.winFrame = frame.fullscreen ? "fullscreen" : frame.maximized ? "maximized" : frame.focused ? "focused" : "inactive"; };
  markFrame();
  bridge.onWindowFrame((state) => { frame = state; markFrame(); for (const fn of frameListeners) fn(state); });

  let update: UpdateState = info.update;
  const updateListeners = new Set<(state: UpdateState) => void>();
  bridge.onUpdateState((state) => { update = state; for (const fn of updateListeners) fn(state); });

  return {
    kind: "desktop",
    os: info.os,
    mobile: false,
    app: { version: info.version, electron: info.electron, chrome: info.chrome },
    home: null,
    defaultDirectoryUrl: info.directoryUrl,
    systemIdle: "always",
    secretStore: bridge.secrets?.available ? { get: (key) => bridge.secrets!.get(key), set: (key, value) => bridge.secrets!.set(key, value) } : null,
    // An app older than this client has no such member; one without the helper reports nothing.
    systemActivity: info.systemWatch === true && typeof bridge.onSystemActivity === "function" ? { subscribe: (cb) => bridge.onSystemActivity(cb) } : null,
    games: info.gameDetection === true && typeof bridge.scanGames === "function" ? {
      scan: () => bridge.scanGames(), setWatch: (settings) => bridge.setGameWatch(settings), pickProgram: () => bridge.pickGameProgram(), subscribe: (cb) => bridge.onRunningGame(cb),
    } : null,
    // An app older than this client has no such member: then there are no global shortcuts, as before.
    hotkeys: info.hotkeys && typeof bridge.setHotkeys === "function" ? {
      globalPtt: info.hotkeys.globalPtt, executable: info.hotkeys.executable, controlKey: info.hotkeys.controlKey ?? null,
      set: (request) => bridge.setHotkeys(request), suspend: (on) => bridge.suspendHotkeys(on), onControl: (cb) => bridge.onControl(cb),
    } : null,
    // app:// is a secure scheme; only the development window (Vite over http) may load http resources.
    // An app older than this client has no notify member: then no notifications (its shell refuses the browser's API too).
    notifications: typeof bridge.notify === "function" ? {
      permission: () => "granted",
      request: async () => "granted",
      show: (notification) => bridge.notify(notification),
      onClick: (cb) => bridge.onNotificationClick(cb),
      knowsFullscreen: info.os === "windows" && info.systemWatch === true,
    } : { permission: () => "unsupported", request: async () => "unsupported", show: () => {}, onClick: () => () => {}, knowsFullscreen: false },
    media: { mobile: false, blocksInsecureMedia: window.location.protocol !== "http:", screenSharePublishOverrides: () => (pickedCodec === "vp8" ? null : { videoCodec: pickedCodec }), takeScreenAudio: () => audio.take(), stopScreenAudio: () => audio.stop(),
      // An app older than this client has no such member.
      setPlayerOutput: typeof bridge.setPlayerOutput === "function" ? (label) => bridge.setPlayerOutput(label) : null,
      setChatPlayerOutput: typeof bridge.setChatPlayerOutput === "function" ? (label) => bridge.setChatPlayerOutput(label) : null },
    setLanguage: typeof bridge.setLanguage === "function" ? (language) => bridge.setLanguage(language) : null,
    links: {
      openExternal: (url) => bridge.openExternal(url),
      onDeepLink: (cb) => bridge.onDeepLink((raw) => { const link = parseDeepLink(raw); if (link) cb(link); }),
      lookUp: typeof bridge.lookUpLink === "function" ? (request) => bridge.lookUpLink(request) : null,
    },
    screen: { setPicker: (next) => { picker = next; } },
    window: {
      popoutFeatures,
      appearance: info.materials.length === 0 ? null : {
        materials: info.materials,
        state: () => look,
        set: async (next) => { look = await bridge.setAppearance(next); paint(); return look; },
        restart: () => bridge.relaunch(),
      },
      tray: info.tray === null ? null : { closeToTray: () => closeToTray, setCloseToTray: async (on) => (closeToTray = await bridge.setCloseToTray(on)) },
      // An app older than this client has neither member.
      autostart: info.autostart && typeof bridge.setAutostart === "function" ? {
        enabled: () => autostart, set: async (on) => (autostart = await bridge.setAutostart(on)),
        background: typeof bridge.setAutostartBackground === "function" ? { get: () => autostartBackground, set: async (on) => (autostartBackground = await bridge.setAutostartBackground(on)) } : null,
      } : null,
      ready: () => { if (typeof bridge.clientReady === "function") bridge.clientReady(); },
      attention: typeof bridge.setAttention === "function" ? { set: (count) => bridge.setAttention(count) } : null,
      focusPopout: typeof bridge.focusPopout === "function" ? (name) => bridge.focusPopout(name) : null,
      frame: {
        state: () => frame,
        subscribe: (cb) => { frameListeners.add(cb); cb(frame); return () => { frameListeners.delete(cb); }; },
        control: (action) => bridge.windowControl(action),
      },
    },
    updates: info.update.status === "unsupported" ? null : {
      get: () => update,
      subscribe: (cb) => { updateListeners.add(cb); cb(update); return () => { updateListeners.delete(cb); }; },
      check: () => bridge.checkForUpdates(),
      restartAndInstall: () => bridge.restartAndInstall(),
    },
  };
}
