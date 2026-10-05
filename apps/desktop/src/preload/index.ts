import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { BackupKdfName } from "@squorli/protocol";
import { BRIDGE_GLOBAL, INFO_ARGUMENT, IPC, type ControlEvent, type CustomProgram, type DesktopBridge, type DesktopInfo, type DetectedGame, type GameWatchSettings, type HotkeyRequest, type HotkeyStatus, type RunningGame, type AppearanceState, type ScreenAudioEvent, type ScreenPick, type ScreenPickRequest, type ScreenPickUpdate, type SystemActivityEvent, type UpdateState, type WindowAppearance, type WindowControl, type WindowFrameState, type BridgeBackup, type BridgeLinkLookup, type BridgeNotification } from "@squorli/web/platform/bridge";

/**
 * Preload script (sandboxed, context-isolated): the only thing the page gets from the shell is this bridge. Plain data in
 * both directions; the page never sees `ipcRenderer` or an event object.
 */
const raw = process.argv.find((a) => a.startsWith(INFO_ARGUMENT))?.slice(INFO_ARGUMENT.length) ?? "";
const info = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as DesktopInfo;

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

const bridge: DesktopBridge = {
  info,
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
  onDeepLink: (cb) => { const off = subscribe<string>(IPC.deepLink, cb); ipcRenderer.send(IPC.deepLinkReady); return off; },
  onScreenPickRequest: (cb) => subscribe<ScreenPickRequest>(IPC.screenPickRequest, cb),
  answerScreenPick: (requestId: number, pick: ScreenPick | null) => ipcRenderer.send(IPC.screenPickAnswer, requestId, pick),
  onScreenPickUpdate: (cb) => subscribe<ScreenPickUpdate>(IPC.screenPickUpdate, cb),
  loadScreenPictures: (requestId: number) => ipcRenderer.send(IPC.screenPickPictures, requestId),
  onScreenAudio: (cb) => subscribe<ScreenAudioEvent>(IPC.screenAudio, cb),
  stopScreenAudio: () => ipcRenderer.send(IPC.screenAudioStop),
  setPlayerOutput: (label: string | null) => ipcRenderer.send(IPC.playerOutput, label),
  setChatPlayerOutput: (label: string | null) => ipcRenderer.send(IPC.chatPlayerOutput, label),
  onSystemActivity: (cb) => { const off = subscribe<SystemActivityEvent>(IPC.systemActivity, cb); ipcRenderer.send(IPC.systemActivityReady); return off; },
  scanGames: () => ipcRenderer.invoke(IPC.gamesScan) as Promise<DetectedGame[]>,
  lookUpLink: (request: { url: string } | { youtube: string }) => ipcRenderer.invoke(IPC.linkLookup, request) as Promise<BridgeLinkLookup>,
  setGameWatch: (settings: GameWatchSettings) => ipcRenderer.send(IPC.gamesWatch, settings),
  pickGameProgram: () => ipcRenderer.invoke(IPC.gamesPick) as Promise<CustomProgram | null>,
  onRunningGame: (cb) => { const off = subscribe<RunningGame | null>(IPC.gameRunning, cb); ipcRenderer.send(IPC.gameRunningReady); return off; },
  setAppearance: (appearance: WindowAppearance) => ipcRenderer.invoke(IPC.setAppearance, appearance) as Promise<AppearanceState>,
  relaunch: () => ipcRenderer.send(IPC.relaunch),
  windowControl: (action: WindowControl) => ipcRenderer.send(IPC.windowControl, action),
  setCloseToTray: (on: boolean) => ipcRenderer.invoke(IPC.setCloseToTray, on) as Promise<boolean>,
  setAutostart: (on: boolean) => ipcRenderer.invoke(IPC.setAutostart, on) as Promise<boolean>,
  setAutostartBackground: (on: boolean) => ipcRenderer.invoke(IPC.setAutostartBackground, on) as Promise<boolean>,
  clientReady: () => ipcRenderer.send(IPC.clientReady),
  setAttention: (count: number) => ipcRenderer.send(IPC.attention, count),
  notify: (notification: BridgeNotification) => ipcRenderer.send(IPC.notify, notification),
  onNotificationClick: (cb) => subscribe<string>(IPC.notificationClick, cb),
  focusPopout: (name: string) => ipcRenderer.send(IPC.focusPopout, name),
  setLanguage: (language: string) => ipcRenderer.send(IPC.language, language),
  setHotkeys: (request: HotkeyRequest) => ipcRenderer.invoke(IPC.hotkeysSet, request) as Promise<HotkeyStatus>,
  suspendHotkeys: (on: boolean) => ipcRenderer.send(IPC.hotkeysSuspend, on),
  onControl: (cb) => subscribe<ControlEvent>(IPC.control, cb),
  onWindowFrame: (cb) => subscribe<WindowFrameState>(IPC.windowFrame, cb),
  onUpdateState: (cb) => subscribe<UpdateState>(IPC.updateState, cb),
  checkForUpdates: () => ipcRenderer.send(IPC.updateCheck),
  restartAndInstall: () => ipcRenderer.send(IPC.updateInstall),
  onQuitRequest: (cb) => subscribe<number>(IPC.quitRequest, cb),
  quitReady: (requestId) => ipcRenderer.send(IPC.quitReady, requestId),
  secrets: {
    available: ipcRenderer.sendSync(IPC.secretsAvailable) === true,
    get: (key: string) => { const v: unknown = ipcRenderer.sendSync(IPC.secretsGet, key); return typeof v === "string" ? v : null; },
    set: (key: string, value: string | null) => ipcRenderer.sendSync(IPC.secretsSet, key, value) === true,
  },
  // The account keys' seeds stay in the main process (keyVault.ts): the page asks for signatures and derived keys by the public half.
  keys: {
    sign: (publicKey: string, message: string) => ipcRenderer.invoke(IPC.keysSign, publicKey, message) as Promise<string | null>,
    dmKey: (publicKey: string, peerPublicKey: string) => ipcRenderer.invoke(IPC.keysDm, publicKey, peerPublicKey) as Promise<string | null>,
    settingsKey: (publicKey: string) => ipcRenderer.invoke(IPC.keysSettings, publicKey) as Promise<string | null>,
    backup: (publicKey: string, password: string, context?: string, kdf?: BackupKdfName) => ipcRenderer.invoke(IPC.keysBackup, publicKey, password, context, kdf) as Promise<BridgeBackup | null>,
    generate: () => ipcRenderer.invoke(IPC.keysGenerate) as Promise<string | null>,
    import: (privateKey: string) => ipcRenderer.invoke(IPC.keysImport, privateKey) as Promise<string | null>,
    forget: (publicKey: string) => ipcRenderer.invoke(IPC.keysForget, publicKey) as Promise<void>,
  },
};

contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, bridge);
