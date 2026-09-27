import type { AppearanceState, ControlEvent, CustomProgram, DetectedGame, GameWatchSettings, HotkeyRequest, HotkeyStatus, PlatformOs, RunningGame, ScreenPick, ScreenSource, SystemActivityEvent, UpdateState, WindowAppearance, WindowControl, WindowFrameState, WindowMaterial, BridgeLinkLookup } from "./bridge";
import type { DeepLink } from "./deepLink";

export type { DeepLink } from "./deepLink";
export type { AppearanceState, ControlAction, ControlEvent, CustomProgram, DetectedGame, GameWatchSettings, HotkeyAction, HotkeyBinding, HotkeyBindings, HotkeyRequest, HotkeyStatus, PlatformOs, RunningGame, ScreenCodec, ScreenPick, ScreenSource, SystemActivityEvent, UpdateState, WindowAppearance, WindowControl, WindowFrameState, WindowMaterial } from "./bridge";

/** The chat server that serves the page: its key in the store and the domain a login there signs. */
export type PlatformHome = { host: string; signDomain: string };

/** What the shell offers to share right now; `listing` = it is still finding out what there is (`sources` is empty until then). */
export type ScreenOfferState = { readonly sources: readonly ScreenSource[]; readonly listing: boolean };
/**
 * One question of the shell as it fills up (platform/screenOffer.ts): first nothing, then the list with names and icons,
 * then the thumbnails (`ScreenSource.pending` until a source's one is there).
 */
export type ScreenOffer = {
  /** The same object until something changes (fits `useSyncExternalStore`). */
  current(): ScreenOfferState;
  subscribe(cb: () => void): () => void;
  /** Ask the shell for the thumbnails: the dialog does when it opens, "Quick Share" never. */
  loadPictures(): void;
};
/** Asks the user which screen or window to share; null = cancelled. */
export type ScreenPicker = (offer: ScreenOffer) => Promise<ScreenPick | null>;

/** What the voice core needs from the platform (handed to `VoiceClient`, which imports no platform module). */
export interface PlatformMedia {
  /** A phone or tablet (platform/mobile.ts): its microphone arrives far quieter, so the boost gets wider limits (voice/micBoost.ts). */
  readonly mobile: boolean;
  /** The page may not load http/ws resources (https page, desktop app); only changes what hints say. */
  readonly blocksInsecureMedia: boolean;
  /**
   * Publish options that replace the client's defaults for a screen share; null = none. Asked AFTER the capture (so after the
   * picker) and before publishing: the desktop app answers with the codec the user chose in its picker (H.264, H.265 or none);
   * what follows from the codec is the voice core's business (voice/screenShareOptions.ts).
   */
  screenSharePublishOverrides(): { videoCodec?: "vp8" | "h264" | "h265" } | null;
  /**
   * Right after a screen share started: the audio track the platform captured itself for it (desktop app on Windows: one
   * window's audio, or the system's without the app), or null = none (the share's own audio track, if any, applies).
   */
  takeScreenAudio(): Promise<MediaStreamTrack | null>;
  /** The share ended: end the platform's capture. */
  stopScreenAudio(): void;
  /**
   * Where the embedded players (Twitch, YouTube as the radio's source) play: the output device's LABEL (device ids differ
   * per origin), null = the system's default. Only the desktop app can do that (its shell reaches into the player's frame);
   * a browser page cannot route a foreign iframe's sound, there it is null and the players use the default device.
   */
  readonly setPlayerOutput: ((label: string | null) => void) | null;
  /** Output device (by label) of the players of videos linked in the chat; null = this platform cannot route them (a browser, an older app). */
  readonly setChatPlayerOutput: ((label: string | null) => void) | null;
}

/** Whether this client may show notifications of the operating system (Platform.notifications). */
export type NotifyPermission = "granted" | "default" | "denied" | "unsupported";

/**
 * Where the client runs. One build serves both: the browser (served by a chat server) and the desktop app (the same files
 * from `app://squorli`, recognised by the bridge of its preload script). Everything that differs between the two goes
 * through this interface; components import the singleton from `./platform`, the UI-free cores (`Store`, `VoiceClient`)
 * take what they need as constructor options.
 */
export interface Platform {
  readonly kind: "web" | "desktop";
  readonly os: PlatformOs;
  /** A phone or tablet, told by the device and not by the window's width (platform/mobile.ts); the desktop app never is one. */
  readonly mobile: boolean;
  /** Desktop: versions for the settings; web: null (the server's version is shown). */
  readonly app: { version: string; electron: string; chrome: string } | null;
  /** The server that serves the page; null = none (desktop app: the client starts from the directory account). */
  readonly home: PlatformHome | null;
  /** Directory to use when there is no home server to name one. */
  readonly defaultDirectoryUrl: string | null;
  /** Tell the shell the client's language for what the shell draws itself (the window's context menu, the tray's menu); null = nothing to tell (browser, older app). */
  readonly setLanguage: ((language: "de" | "en") => void) | null;
  /**
   * AFK detection across the whole system (idleDetection.ts). "permission": a browser grants it only inside a click, so it is
   * a switch in the settings; "always": the desktop shell grants it by itself, it simply runs and there is no switch.
   */
  readonly systemIdle: "permission" | "always";
  /**
   * Storage for the client's secrets that the operating system encrypts (desktop app: `safeStorage`); null = none, the
   * client keeps them in localStorage (browser, an older app, Linux without a keyring). identity.ts.
   */
  readonly secretStore: null | { get(key: string): string | null; set(key: string, value: string | null): boolean };
  /**
   * What only the desktop app's shell sees (its native helper, Windows): controller input, which the browser's Gamepad API
   * delivers only while the window has the focus, and whether some program keeps the display on (a playing video);
   * systemActivity.ts. null = nothing of the kind (browser, an app without the helper or older than it).
   */
  readonly systemActivity: null | { subscribe(cb: (event: SystemActivityEvent) => void): () => void };
  /**
   * Game detection (gameDetection.ts, docs/features/games.md): the desktop app's shell reads the launchers' installed games
   * and says which one is in front; null = not available (browser, an app without the helper or older than the feature).
   */
  readonly games: null | {
    scan(): Promise<DetectedGame[]>;
    setWatch(settings: GameWatchSettings): void;
    /** The system's file dialog for a program to add; null = cancelled. */
    pickProgram(): Promise<CustomProgram | null>;
    subscribe(cb: (game: RunningGame | null) => void): () => void;
  };
  /**
   * Global shortcuts, the push-to-talk key across the system and commands from outside (docs/features/hotkeys.md): the
   * desktop app's shell registers the bindings system-wide and reports every command; null = a browser or an older app.
   */
  readonly hotkeys: null | {
    /** The shell can watch the push-to-talk key outside the window (Windows with the system watch helper). */
    readonly globalPtt: boolean;
    /** The app's program file for a command line that controls it; null = unpackaged. */
    readonly executable: string | null;
    /** The key the control links carry (`controlLink`); null = an app from before it. */
    readonly controlKey: string | null;
    set(request: HotkeyRequest): Promise<HotkeyStatus>;
    /** While the settings capture a new key: nothing is registered or watched meanwhile. */
    suspend(on: boolean): void;
    onControl(cb: (event: ControlEvent) => void): () => void;
  };
  /**
   * Notifications of the operating system for direct messages and mentions (docs/features/notifications.md). The desktop app
   * shows them through its shell ("granted" at once); a browser through the Notification API after asking inside a click.
   */
  readonly notifications: {
    /** "granted" = can show; "default" = must ask first (`request`, inside a click); "denied" = the user or the system refused; "unsupported" = no way here (an older app, a browser without the API or an insecure page). */
    permission(): NotifyPermission;
    request(): Promise<NotifyPermission>;
    /** `inFullscreen`: show it also while something runs in full screen (the desktop app on Windows holds it back otherwise). */
    show(notification: { title: string; body: string; tag: string; inFullscreen?: boolean }): void;
    /** The shell can tell whether a game or another application runs in full screen (Windows with the system watch helper). */
    readonly knowsFullscreen: boolean;
    /** A notification was clicked (the window is in front again); `tag` as shown. */
    onClick(cb: (tag: string) => void): () => void;
  };
  readonly media: PlatformMedia;
  readonly links: {
    /** Open an address outside the client (desktop: the system's browser). */
    openExternal(url: string): void;
    /** `squorli://` links aimed at this app; the first subscription also delivers the one the app was started with. */
    onDeepLink(cb: (link: DeepLink) => void): () => void;
    /** Look a link up from this computer for the preview of a direct message; null = this platform cannot (a browser, an older app): ask the directory. */
    readonly lookUp: ((request: { url: string } | { youtube: string }) => Promise<BridgeLinkLookup>) | null;
  };
  readonly screen: {
    /** Desktop: the shell has no picker of its own and asks this one; web: ignored (the browser brings its own). */
    setPicker(picker: ScreenPicker | null): void;
  };
  readonly window: {
    /** Feature string for `window.open` of a video pop-out. */
    popoutFeatures(size: { width: number; height: number }): string;
    /** Window background (desktop); null = not available. `state()` also says what the running window shows and whether a restart is pending. */
    readonly appearance: null | { readonly materials: readonly WindowMaterial[]; state(): AppearanceState; set(appearance: WindowAppearance): Promise<AppearanceState>; restart(): void };
    /** Tray icon of the desktop app: whether closing the window only hides it there; null = no tray. */
    readonly tray: null | { closeToTray(): boolean; setCloseToTray(on: boolean): Promise<boolean> };
    /** Start the desktop app with the system; null = not available (browser, unpackaged app, an app older than the setting). */
    readonly autostart: null | {
      enabled(): boolean; set(on: boolean): Promise<boolean>;
      /** How a start by the system looks: in the background (tray, or minimized where closing quits) or with the window opened; null = this app cannot be told (it always starts in the background). */
      readonly background: null | { get(): boolean; set(on: boolean): Promise<boolean> };
    };
    /** The first screen is decided (login, or the servers are known): the desktop app's start window makes way. Nothing to do in a browser. */
    ready(): void;
    /** Mark on the app's task bar and tray icon: how many direct messages and mentions wait; null = no such mark (browser, older app). */
    readonly attention: null | { set(count: number): void };
    /** Bring a window opened with this name to the front (desktop shell); null = the page tries itself (StageWindow.tsx). */
    readonly focusPopout: ((name: string) => void) | null;
    /** The window has no system title bar and the client draws its own (desktop); null = the browser's or system's frame. */
    readonly frame: null | { state(): WindowFrameState; subscribe(cb: (state: WindowFrameState) => void): () => void; control(action: WindowControl): void };
  };
  /** App updates (desktop); null = the page is updated by its server. */
  readonly updates: null | { get(): UpdateState; subscribe(cb: (state: UpdateState) => void): () => void; check(): void; restartAndInstall(): void };
}
