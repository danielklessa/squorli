/**
 * Contract between the desktop shell (Electron, `apps/desktop`) and the client. The preload script exposes one
 * `DesktopBridge` as `window.squorliDesktop`; `desktop.ts` turns it into the client's `Platform`.
 * DOM-free: the Electron main process and the preload script import these types (package export `./platform/bridge`).
 * Everything that crosses the bridge is plain data (structured clone); no functions except the bridge's own members.
 */

export type PlatformOs = "windows" | "linux" | "macos" | "other";

/**
 * Window background of the desktop app (user's decision, 18 September 2026): "none" = opaque, "mica" = Windows 11's material
 * behind the whole window (Windows turns it solid while the window is inactive), "clear" = a really see-through window: the gaps
 * between the client's areas show the desktop, the areas are tinted surfaces. `opacity` = how opaque those surfaces are.
 * A window is created see-through or not, so changing to or from "clear" takes effect after a restart of the app.
 */
export type WindowMaterial = "none" | "mica" | "clear";
export type WindowAppearance = { material: WindowMaterial; opacity: number };
export const WINDOW_OPACITY_MIN = 0.4;
/** What is stored, what the running window actually shows, and whether a restart is pending to get there. */
export type AppearanceState = { appearance: WindowAppearance; effective: WindowMaterial; needsRestart: boolean };

/** The window has no system title bar; the client draws its own (TitleBar.tsx) and needs to know this much. */
export type WindowFrameState = { maximized: boolean; focused: boolean; fullscreen: boolean };
export type WindowControl = "minimize" | "toggle-maximize" | "close";

export type UpdateState =
  | { status: "unsupported" }
  | { status: "idle"; checkedAt: number | null }
  | { status: "checking" }
  /** manual = this package cannot update itself (deb); the client links to the download page instead. */
  | { status: "available"; version: string; manual: boolean }
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };

/**
 * One thing the desktop app can share (a screen or a window); thumbnail and icon are data URLs. `audio` = audio can go with
 * it: for a window what its application plays, for a screen what the system plays (without the app itself where the shell
 * has its native capture helper; the app's own windows never carry audio). `gameId` = the window belongs to a detected game
 * (its id as in `RunningGame`; shell from 21 September 2026, only while game detection is on). `fullscreen` = the window
 * covers its whole monitor without being maximized (a game or a player in full screen).
 */
export type ScreenSource = { id: string; kind: "screen" | "window"; name: string; thumbnail: string; icon: string | null; audio: boolean; gameId?: string | null; fullscreen?: boolean };
export type ScreenPickRequest = { requestId: number; sources: ScreenSource[] };
/** The video codec a share is sent with: "vp8" = the client's standing codec; "h265" (where the computer's graphics unit encodes it) or else "h264" = the user's choice for moving pictures (games). */
export type ScreenCodec = "vp8" | "h264" | "h265";
/** `codec` stays in the client (the publish options of the share); the shell reads `sourceId` and `audio` only. */
export type ScreenPick = { sourceId: string; audio: boolean; codec?: ScreenCodec };
/** Audio the shell captures itself for a screen share (Windows, native helper): PCM 48 kHz, 16 bit signed, interleaved stereo. */
export type ScreenAudioEvent = { type: "start" } | { type: "data"; pcm: Uint8Array } | { type: "end" };

/**
 * What the shell's native system watch helper sees outside the window (Windows): `input` = a game controller was used (at most
 * once a second; Chromium's Gamepad API only delivers while the window has the focus), `display` = whether some program asks
 * the system to keep the display on, which browsers and players do while a video plays. docs/features/afk.md.
 */
export type SystemActivityEvent = { type: "input" } | { type: "display"; required: boolean };

/**
 * Game detection of the desktop app (docs/features/games.md): the shell reads which games the launchers installed and its
 * native helper tells when a program from one of those folders, or one the user added, is in front. Everything stays on
 * this computer so far. An id is the launcher's own ("steam:730", "epic:<app name>", "gog:<id>", "xbox:<store id>") or
 * "custom:<path>" for an added program; install paths stay in the shell.
 */
export type GameSource = "steam" | "epic" | "gog" | "xbox" | "custom";
export type DetectedGame = { id: string; name: string; source: GameSource; /** The game's icon as the computer itself has it, a small PNG as a data URL (shell from 21 September 2026); null or left out = none. */ icon?: string | null };
export type RunningGame = { id: string; name: string };
/** A program the user added by hand: the full path of its executable and the name to show. */
export type CustomProgram = { path: string; name: string };
/** What the shell needs from the client's settings: whether to detect at all, and the added programs. */
export type GameWatchSettings = { enabled: boolean; custom: CustomProgram[] };

/**
 * Global shortcuts and control from outside the window (docs/features/hotkeys.md, 22 September 2026). A binding is the key
 * as `KeyboardEvent.code` (the same form as the push-to-talk key) plus the modifiers held with it; the shell turns it into
 * Electron's accelerator (platform/hotkeys.ts) and registers it system-wide, which keeps the combination from every other
 * program. Push-to-talk is not a binding: the shell's system watch helper watches the push-to-talk key itself (Windows),
 * without taking it from anyone, because a shortcut has no key-up. `vk` (Windows, 24 September 2026): the virtual key the
 * keyboard layout gave a letter, digit or punctuation key at the capture (`KeyboardEvent.keyCode`); Windows registers a
 * shortcut by virtual key, so a German Ö (code `Semicolon`, VK_OEM_3) must become Electron's "`", not ";" (= Ü there).
 */
export type HotkeyBinding = { code: string; vk?: number; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
export type HotkeyAction = "micToggle" | "deafenToggle";
export type HotkeyBindings = Record<HotkeyAction, HotkeyBinding | null>;
/** Per binding: none set, registered, refused by the system (another program holds it), or not a key the shell can register. */
export type HotkeyState = "off" | "ok" | "taken" | "invalid";
/** The push-to-talk key: not asked for (no channel, or not push-to-talk), watched, not a key the helper knows, or this app cannot watch keys (no helper, other system). */
export type PttWatchState = "off" | "ok" | "invalid" | "unsupported";
export type HotkeyStatus = Record<HotkeyAction, HotkeyState> & { ptt: PttWatchState };
/** What the client asks the shell to do: the bindings, and the push-to-talk key to watch (null = none: no channel, or voice activation). */
export type HotkeyRequest = { bindings: HotkeyBindings; pttKey: string | null };
/**
 * A command from outside the window: a global shortcut, or a link `squorli://control/<action>` or the argument
 * `--control=<action>` of a second start (a Stream Deck's "open" action, G Hub, any macro tool). The running app carries it
 * out without bringing its window to the front.
 */
export type ControlAction = "mic-toggle" | "mic-on" | "mic-off" | "deafen-toggle" | "deafen-on" | "deafen-off";
export type ControlEvent = { kind: "action"; action: ControlAction; source: "hotkey" | "external" } | { kind: "ptt"; down: boolean };

/** Fixed facts about the running app, handed to the preload script at window creation. */
export type DesktopInfo = {
  version: string;
  electron: string;
  chrome: string;
  os: PlatformOs;
  /** Directory the app uses (https://directory.squorli.com; development builds may override it). */
  directoryUrl: string;
  /** Materials this system offers besides "none"; empty = the appearance setting is not shown. */
  materials: WindowMaterial[];
  /** The shell captures a share's audio itself (native helper present); then a picked source with audio arrives through `onScreenAudio`. */
  nativeScreenAudio: boolean;
  /** The shell runs its system watch helper (`onSystemActivity`); missing = an app older than it. */
  systemWatch?: boolean;
  /** The shell can detect running games (system watch helper present, a platform whose launchers it reads); missing = an app older than it. */
  gameDetection?: boolean;
  appearance: AppearanceState;
  frame: WindowFrameState;
  /** The app has a tray icon; `closeToTray` = the window's close button hides the window instead of quitting (user's setting). null = no tray. */
  tray: { closeToTray: boolean } | null;
  /**
   * Start with the system (user's setting, off by default). null = this app cannot (unpackaged, or a system without a known
   * way); missing = an app older than the setting.
   */
  autostart?: { enabled: boolean; /** A start by the system stays in the background (tray or minimized) instead of opening the window; missing = an app that always does. */ background?: boolean } | null;
  /**
   * Global shortcuts and control from outside (`setHotkeys`, `onControl`); missing = an app older than them. `globalPtt` =
   * the shell can watch the push-to-talk key across the system (its system watch helper is present, Windows). `executable` =
   * the app's own program file for a command line that controls it (`"<executable>" --control=<action>`); null unpackaged.
   * `controlKey` = the key control links need when they could open the microphone (platform/hotkeys.ts `controlLink`);
   * missing = an app from before it, whose links need none.
   */
  hotkeys?: { globalPtt: boolean; executable: string | null; controlKey?: string };
  update: UpdateState;
};

export interface DesktopBridge {
  readonly info: DesktopInfo;
  openExternal(url: string): void;
  /** Raw `squorli://` links; the first subscription also delivers the link the app was started with. */
  onDeepLink(cb: (raw: string) => void): () => void;
  /** The shell asks which screen or window to share; answer with `answerScreenPick` (null = cancelled). */
  onScreenPickRequest(cb: (request: ScreenPickRequest) => void): () => void;
  answerScreenPick(requestId: number, pick: ScreenPick | null): void;
  onScreenAudio(cb: (event: ScreenAudioEvent) => void): () => void;
  stopScreenAudio(): void;
  /** Output device of the embedded players (Twitch, YouTube), named by its label because device ids differ per origin; null = the system's default. */
  setPlayerOutput(label: string | null): void;
  /**
   * The same for the players of videos linked in the chat (LinkPreviews.tsx), which follow the output device of screen share
   * audio, not the radio's. The shell tells the two kinds of player frames apart by CHAT_PLAYER_MARK. An app from before it
   * has no such member and puts every player on the radio's device.
   */
  setChatPlayerOutput(label: string | null): void;
  /** Controller input and the "display required" state; the first subscription also gets the current display state. */
  onSystemActivity(cb: (event: SystemActivityEvent) => void): () => void;
  /** Read the launchers' installed games again; answers with them and the added programs, by name. */
  scanGames(): Promise<DetectedGame[]>;
  /**
   * Look a link up for the preview of a direct message: the app asks the linked host itself (public hosts only), so no
   * server learns the link. An app from before it has no such member; the client then asks the directory like a browser.
   */
  lookUpLink(request: { url: string } | { youtube: string }): Promise<BridgeLinkLookup>;
  setGameWatch(settings: GameWatchSettings): void;
  /** Ask the user for a program to add (the system's file dialog); null = cancelled. */
  pickGameProgram(): Promise<CustomProgram | null>;
  /** The game in front last that still runs, null = none; the first subscription gets the current one. */
  onRunningGame(cb: (game: RunningGame | null) => void): () => void;
  setAppearance(appearance: WindowAppearance): Promise<AppearanceState>;
  /** Restart the app (a pending change of the window background). */
  relaunch(): void;
  windowControl(action: WindowControl): void;
  setCloseToTray(on: boolean): Promise<boolean>;
  /** Start the app when the user signs in to the system; answers with what is set now. */
  setAutostart(on: boolean): Promise<boolean>;
  /** Whether a start by the system stays in the background (true) or opens the window (false); answers with what is set now. */
  setAutostartBackground(on: boolean): Promise<boolean>;
  /** The client knows what its first screen is: the shell's start window makes way for the main window. */
  clientReady(): void;
  /** How many direct messages and mentions wait (0 = none): the mark on the task bar icon and the tray icon. */
  setAttention(count: number): void;
  /** Show a notification of the operating system (docs/features/notifications.md); the shell plays no sound, the client has its own. An app from before it has no such member. */
  notify(notification: BridgeNotification): void;
  /** A notification was clicked: the shell brought the window to the front and names the notification's tag. */
  onNotificationClick(cb: (tag: string) => void): () => void;
  /** Bring a window the client opened with this name (`window.open(url, name)`) to the front; a page cannot do that itself on every system. An app from before it has no such member. */
  focusPopout(name: string): void;
  /** The client's language ("de" or "en") for what the shell draws itself: the window's context menu, the tray's menu. An app from before it has no such member. */
  setLanguage(language: string): void;
  /** Register the global shortcuts and watch the push-to-talk key; answers with what the shell could do. Replaces the previous request. */
  setHotkeys(request: HotkeyRequest): Promise<HotkeyStatus>;
  /** While the client captures a new key: the shortcuts are let go (a registered one never reaches the window) and no key is watched. */
  suspendHotkeys(on: boolean): void;
  /** Commands from outside the window: the shortcuts, the push-to-talk key, links and arguments of a second start. */
  onControl(cb: (event: ControlEvent) => void): () => void;
  onWindowFrame(cb: (state: WindowFrameState) => void): () => void;
  onUpdateState(cb: (state: UpdateState) => void): () => void;
  checkForUpdates(): void;
  restartAndInstall(): void;
  /**
   * The client's secrets encrypted by the operating system (`safeStorage`, shell from 25 September 2026; missing = an older
   * shell). Synchronous. `available` false = no real encryption here (Linux without a keyring): keep localStorage.
   * Only the keys of SECRET_KEYS are accepted.
   */
  readonly secrets?: { readonly available: boolean; get(key: string): string | null; set(key: string, value: string | null): boolean };
}

/** What the shell keeps encrypted for the client (identity.ts): the identity key, and the server accounts' keys and tokens. */
export const SECRET_KEYS = ["chat.identity.v1", "chat.serverAccounts.v1"] as const;

/** A notification the client asks the shell to show; `tag` comes back when it is clicked. */
/** `inFullscreen`: show it also while a game or another application runs in full screen (Windows; the setting in Einstellungen > Töne). */
export type BridgeNotification = { title: string; body: string; tag: string; inFullscreen?: boolean };

/** IPC channel names, shared by main and preload. */
export const IPC = {
  openExternal: "squorli:open-external",
  deepLinkReady: "squorli:deep-link-ready",
  deepLink: "squorli:deep-link",
  screenPickRequest: "squorli:screen-pick-request",
  screenPickAnswer: "squorli:screen-pick-answer",
  screenAudio: "squorli:screen-audio",
  screenAudioStop: "squorli:screen-audio-stop",
  playerOutput: "squorli:player-output",
  chatPlayerOutput: "squorli:chat-player-output",
  systemActivity: "squorli:system-activity",
  systemActivityReady: "squorli:system-activity-ready",
  gamesScan: "squorli:games-scan",
  linkLookup: "squorli:link-lookup",
  gamesWatch: "squorli:games-watch",
  gamesPick: "squorli:games-pick",
  gameRunning: "squorli:game-running",
  gameRunningReady: "squorli:game-running-ready",
  setAppearance: "squorli:set-appearance",
  relaunch: "squorli:relaunch",
  windowControl: "squorli:window-control",
  windowFrame: "squorli:window-frame",
  setCloseToTray: "squorli:set-close-to-tray",
  setAutostart: "squorli:set-autostart",
  setAutostartBackground: "squorli:set-autostart-background",
  attention: "squorli:attention",
  notify: "squorli:notify",
  focusPopout: "squorli:focus-popout",
  notificationClick: "squorli:notification-click",
  language: "squorli:language",
  hotkeysSet: "squorli:hotkeys-set",
  hotkeysSuspend: "squorli:hotkeys-suspend",
  control: "squorli:control",
  clientReady: "squorli:client-ready",
  updateState: "squorli:update-state",
  updateCheck: "squorli:update-check",
  updateInstall: "squorli:update-install",
  secretsAvailable: "squorli:secrets-available",
  secretsGet: "squorli:secrets-get",
  secretsSet: "squorli:secrets-set",
} as const;

/** Name of the global the preload script exposes, and of the argument that carries `DesktopInfo` (base64 JSON). */
export const BRIDGE_GLOBAL = "squorliDesktop";
export const INFO_ARGUMENT = "--squorli-info=";

/** What a link lookup found: the fields of a preview and the picture as it came from the host (the client makes it small). */
export type BridgeLinkLookup =
  | { found: false }
  | { found: true; kind: "page" | "youtube"; siteName: string | null; title: string | null; description: string | null; image: { mime: string; data: Uint8Array } | null };

/**
 * Fragment of a chat video's player address (`https://www.youtube-nocookie.com/embed/<id>?...#squorli-chat`). A fragment
 * never reaches YouTube; the desktop shell reads it from the frame's address to give that player the chat's output device.
 */
export const CHAT_PLAYER_MARK = "#squorli-chat";
