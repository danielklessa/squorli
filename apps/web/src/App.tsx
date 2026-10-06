import { useVideoWindows } from "./VideoWindows";
import { viewersOf } from "./voice/shareViewers";
import { useStageWindow } from "./StageWindow";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AdminPanel } from "./AdminPanel";
import { ChatView } from "./ChatView";
import { DebugPanel } from "./DebugPanel";
import { HomeMain, HomeSidebar } from "./Home";
import { NoticesDialog } from "./AccountNotices";
import { ReportDialog, type DirectoryReportTarget } from "./ReportDialog";
import { DesktopLogin } from "./DesktopLogin";
import { LoginScreen } from "./LoginScreen";
import { ServerOffline } from "./ServerOffline";
import { ServerUnreachable } from "./ServerUnreachable";
import { reachableServers } from "./otherServers";
import { ClaimAccount, CreateAccount, LocalRegisterForm, SignInForm } from "./AccountForms";
import { MemberList } from "./MemberList";
import { VoteKickModal, VoteKickPanel } from "./VoteKickPanel";
import { blockMinutes, voteKickChannel, voteKickPerson } from "./voteKick";
import { Sidebar } from "./Sidebar";
import { MobileVoicePreview } from "./MobileVoicePreview";
import { voiceElsewhere } from "./voice/elsewhere";
import { VoiceDock } from "./VoiceDock";
import { VoiceStage } from "./VoiceStage";
import { CameraPicker } from "./CameraPicker";
import { Icon } from "./Icon";
import { attentionCount } from "./attention";
import { askConfirm, askInput, showNotice } from "./dialogs";
import type { MenuAnchor } from "./ContextMenu";
import { MiniProfile } from "./MiniProfile";
import { SettingsDialog, type SettingsTab } from "./SettingsDialog";
import { applyBranding, applyHomeScreenName, rememberHomeName } from "./branding";
import { ServerBrowser } from "./ServerBrowser";
import { ServerRail, type RailServer } from "./ServerRail";
import { buildRailServers, voiceActivity } from "./railServers";
import { ColumnHandle } from "./ColumnHandle";
import { loadLayout, saveLayout, type ColumnId, type Layout } from "./layout";
import { NoServers } from "./NoServers";
import { ScreenPicker } from "./ScreenPicker";
import { quickSharePick, whenListed } from "./screenPick";
import { TitleBar } from "./TitleBar";
import { loadVoiceSettings, saveVoiceSettings } from "./voice/settings";
import { loadNotificationSettings, notificationFor, parseNotificationTag } from "./notifications";
import { useVoiceSettings } from "./voice/useVoiceSettings";
import { Permission, directoryAvatarUrl, directoryServerIconUrl, directoryServerUrl, displayNameOf, handleLabel, hasPermission, type Member, type ServerState } from "@squorli/protocol";
import { joinErrorText, voteKickErrorText } from "./apiErrorText";
import { ChannelDialog, type ChannelDialogTarget } from "./ChannelDialog";
import { Store, activeState, homeState, type ServerConnState, type State } from "./store";
import { VoiceClient, type VoiceState } from "./voice/voiceClient";
import { RadioPlayer, type RadioState } from "./voice/radioPlayer";
import { EmbedPlayer, embedKeyOf, usePlayerWindow, type EmbedSource } from "./EmbedPlayer";
import { channelVideoAccess, mayViewIn } from "./voice/videoAccess";
import { videoActive } from "./voice/videoWatch";
import { activity, watchActivity } from "./activity";
import { resumeIdleDetection } from "./idleDetection";
import { setOwnVideo, watchSystemActivity } from "./systemActivity";
import { GameDetection, syncedHidden } from "./gameDetection";
import { directoryGameLookup, presenceOf } from "./gamePresence";
import { GameLibraryContext } from "./GameLine";
import { t } from "./i18n";
import { platform, type ControlEvent, type HotkeyStatus, type ScreenOffer, type ScreenPick } from "./platform";
import { formatDeepLink } from "./platform/deepLink";
import { setSquorliLinkHandler } from "./squorliLinks";
import { isTypingTarget } from "./usePushToTalk";
import { askBlockPerson, askRemoveFriend } from "./friendActions";
import { loadBlockedNames, type BlockControls } from "./blocked";

/**
 * A command from outside the window (docs/features/hotkeys.md): a global shortcut, the push-to-talk key watched by the
 * shell, or a `squorli://control/<action>` link from a Stream Deck or a macro. Mute and deafen follow the buttons' rules
 * (voice/AGENTS.md); a short tone says what the command left behind, because whoever pressed it may not see the window.
 * A push-to-talk press while this window has the focus and a text field is being typed in is left to the window's own
 * listener, which ignores it (usePushToTalk.ts); a release always counts.
 */
function applyControl(client: VoiceClient, event: ControlEvent): void {
  if (event.kind === "ptt") {
    if (event.down && document.hasFocus() && isTypingTarget(document.activeElement)) return;
    client.setPttHeld(event.down);
    return;
  }
  const s = client.state;
  if (s.status === "disconnected" || s.afkRoom) return;
  const action = event.action;
  if (action.startsWith("mic-")) {
    const mute = action === "mic-off" || (action === "mic-toggle" && !s.micMuted);
    if (mute !== s.micMuted) void client.setMuted(mute);
    client.playFeedback(!mute);
  } else {
    const deafen = action === "deafen-on" || (action === "deafen-toggle" && !s.deafened);
    if (deafen !== s.deafened) void client.setDeafened(deafen);
    client.playFeedback(!deafen);
  }
}

/**
 * Tells the desktop shell on which output device a kind of embedded player should play, by the device's label (ids differ
 * per origin), and again when devices come and go: the chosen one may be back. Returns the effect's cleanup.
 */
function tellPlayerOutput(setOutput: ((label: string | null) => void) | null, sink: string | null): (() => void) | undefined {
  if (!setOutput) return undefined;
  let stale = false;
  const tell = () => {
    if (!sink) { setOutput(null); return; }
    void navigator.mediaDevices.enumerateDevices().then((devices) => { if (!stale) setOutput(devices.find((d) => d.kind === "audiooutput" && d.deviceId === sink)?.label || null); }).catch(() => {});
  };
  tell();
  navigator.mediaDevices.addEventListener("devicechange", tell);
  return () => { stale = true; navigator.mediaDevices.removeEventListener("devicechange", tell); };
}

const peerKeysOf = (members: Member[]): Record<string, string> => Object.fromEntries(members.map((m) => [m.userId, m.publicKey]));

export function App() {
  // The browser has a home server (the one serving the page); the desktop app has none and starts from the directory account.
  const store = useMemo(() => new Store({ home: platform.home, defaultDirectoryUrl: platform.defaultDirectoryUrl }), []);
  const client = useMemo(() => new VoiceClient(undefined, platform.media), []);
  const radio = useMemo(() => new RadioPlayer(), []);
  // Desktop app: detection of running games, off until the user switches it on (gameDetection.ts); what goes out: further down.
  const games = useMemo(() => (platform.games ? new GameDetection(platform.games, window.localStorage) : null), []);
  useEffect(() => games?.start(), [games]);
  const [state, setState] = useState<State>(store.state);
  const [voice, setVoice] = useState<VoiceState>(client.state);
  const [showAdmin, setShowAdmin] = useState(false);
  /** The channel dialog (docs/features/channel-permissions.md): a channel or category of the active server, or none. */
  const [channelEdit, setChannelEdit] = useState<ChannelDialogTarget | null>(null);
  /** Vote kick (docs/features/votekick.md): the vote whose question has been answered or waved away; the box keeps offering it. */
  const [voteAsked, setVoteAsked] = useState<string | null>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  const [mobileContent, setMobileContent] = useState(false);
  const [voicePreview, setVoicePreview] = useState<string | null>(null);
  /** Phone: the member list slid in from the right over the navigation (button in the server head, 22 September 2026). */
  const [mobileMembers, setMobileMembers] = useState(false);
  // It closes whenever the page moves on: content opens over it, the home view toggles, another server is shown.
  useEffect(() => { setMobileMembers(false); }, [mobileContent, state.homeOpen, state.activeHost]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const update = () => { setMobile(query.matches); setVoicePreview(null); setMobileContent(false); setMobileMembers(false); };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  // Notices and errors of the voice connection (a moderator moved or removed you, the account joined elsewhere, a camera
  // that failed, a lost connection) are a modal with one close button, closed as well by a click beside it or Escape, not
  // a line in the dock or on the stage (user's wish, 22 September 2026). Closing clears the client's text when it is still
  // the one shown, so a later text, even the same one, shows again; a text that changed meanwhile gets its own modal.
  useEffect(() => {
    const text = voice.notice;
    if (text) void showNotice({ title: t("voice.noticeTitle"), text }).then(() => { if (client.state.notice === text) client.setNotice(null); });
  }, [client, voice.notice]);
  useEffect(() => {
    const text = voice.error;
    if (text) void showNotice({ title: t("voice.errorTitle"), text }).then(() => { if (client.state.error === text) client.clearError(); });
  }, [client, voice.error]);
  /** Mini profile (click on your own name), anchored at the name in the dock. */
  const [miniProfile, setMiniProfile] = useState<MenuAnchor | null>(null);
  /** Settings dialog (gear): the category to open, null = closed. */
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  /** The settings dialog is capturing a new push-to-talk key; the dock's listener stays quiet meanwhile. */
  const [capturingPttKey, setCapturingPttKey] = useState(false);
  const [showDebug, setShowDebug] = useState(() => new URLSearchParams(window.location.search).has("debug"));
  /** Stage (tiles/screen) instead of chat in the main area; voice keeps running independently. */
  const [stageOpen, setStageOpen] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  // Reports to the directory's operator (an account, a chat server) and the notices about its measures (docs/features/reports.md).
  const [directoryReport, setDirectoryReport] = useState<DirectoryReportTarget | null>(null);
  const [noticesLater, setNoticesLater] = useState(false);
  /** Widths of the two side columns, dragged by the user; kept per device (layout.ts). */
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const resizeColumn = (column: ColumnId, width: number, keep: boolean) => setLayout((prev) => { const next = { ...prev, [column]: width }; if (keep) saveLayout(next); return next; });
  const voiceSettings = useVoiceSettings();
  // Game display: the account's switch turns the detection on; the game others may see goes to the directory (friends) and,
  // unless the user keeps it to friends, to the chat servers. The directory's game library says what is a game at all
  // (gamePresence.ts). A client that cannot detect (browser) reports nothing.
  useEffect(() => games?.setEnabled(voiceSettings.games.enabled), [games, voiceSettings.games.enabled]);
  const shownGame = useSyncExternalStore(useMemo(() => games?.subscribe ?? (() => () => {}), [games]), () => games?.state.shown ?? null);
  const gameLookup = useMemo(() => (state.directoryUrl && state.directoryGameLibrary ? directoryGameLookup(state.directoryUrl) : null), [state.directoryUrl, state.directoryGameLibrary]);
  const gameOnServers = voiceSettings.games.servers;
  /** The detected game, hidden from others or not: what "Quick Share" in the dock shares. */
  const runningGame = useSyncExternalStore(useMemo(() => games?.subscribe ?? (() => () => {}), [games]), () => games?.state.running ?? null);
  // The viewing side (GameLine.tsx) asks the same library, in every client, the browser too.
  const gameLibrary = useMemo(() => ({ directoryUrl: state.directoryUrl, lookup: gameLookup }), [state.directoryUrl, gameLookup]);
  useEffect(() => {
    if (!games) return;
    let stale = false;
    void presenceOf(shownGame, gameLookup).then((presence) => { if (!stale) store.setGame(presence, gameOnServers); });
    return () => { stale = true; };
  }, [games, store, shownGame, gameLookup, gameOnServers]);
  // The hide list follows the account inside the sealed settings (store.ts): the account's list goes to the detection, which
  // merges it with this device's, and the device's list goes to the store, which pushes it when it differs.
  const hiddenGames = useSyncExternalStore(useMemo(() => games?.subscribe ?? (() => () => {}), [games]), () => games?.state.settings.hidden ?? null);
  useEffect(() => { if (games && state.accountHiddenGames) games.adoptHidden(state.accountHiddenGames); }, [games, state.accountHiddenGames]);
  useEffect(() => { if (games) store.setLocalHiddenGames(hiddenGames ? syncedHidden(hiddenGames) : null); }, [games, store, hiddenGames]);
  /** Camera picker open (list of cameras) when there is more than one at switch-on time. */
  const [cameraPick, setCameraPick] = useState<MediaDeviceInfo[] | null>(null);
  /**
   * The stage's own window (StageWindow.tsx) when the camera or screen dialog was asked for from there: the dialog is
   * shown in that window instead of in the main one, which may be on another monitor. `stageFocus` is filled further down.
   */
  const [pickWindow, setPickWindow] = useState<Window | null>(null);
  const stageFocus = useRef<() => Window | null>(() => null);
  /**
   * Server the voice connection belongs to (multi-server client): it survives switching the displayed server;
   * only joining a voice channel on another server ends it (as the user specified).
   */
  /** Desktop app: the shell asks which screen or window to share (ScreenPicker.tsx); a browser has its own picker. */
  const [screenPick, setScreenPick] = useState<{ offer: ScreenOffer; resolve: (pick: ScreenPick | null) => void } | null>(null);
  /** "Quick Share" in the dock: the id of the game whose window the next request of the shell is answered with, without the dialog. */
  const quickShare = useRef<string | null>(null);
  useEffect(() => {
    // The shell asks at once and fills its offer afterwards: the dialog opens right away and shows the list and the pictures
    // as they come; "Quick Share" needs the list only.
    platform.screen.setPicker(async (offer) => {
      const game = quickShare.current;
      quickShare.current = null;
      const quick = game ? quickSharePick(await whenListed(offer), game, VoiceClient.supportsH265()) : null;
      if (quick) return quick;
      offer.loadPictures();
      return new Promise((resolve) => { setPickWindow(stageFocus.current()); setScreenPick((open) => { open?.resolve(null); return { offer, resolve }; }); });
    });
    return () => platform.screen.setPicker(null);
  }, []);
  // Desktop app: a `squorli://` link from a browser. The store shows the server (or keeps the link until after the login).
  useEffect(() => platform.links.onDeepLink((link) => { setStageOpen(false); setShowBrowser(false); store.openLink(formatDeepLink(link)); }), [store]);
  // A squorli:// link clicked in a chat message: the same path; a client with a home server leaves it to the browser (squorliLinks.ts).
  useEffect(() => { setSquorliLinkHandler((href) => { const taken = store.openLink(href); if (taken) { setStageOpen(false); setShowBrowser(false); } return taken; }); return () => setSquorliLinkHandler(null); }, [store]);
  const [voiceHost, setVoiceHost] = useState<string | null>(null);
  const voiceHostRef = useRef<string | null>(null);
  voiceHostRef.current = voiceHost;
  /** The server the last voice connection belonged to: its removal notice may come after the connection is already gone. */
  const lastVoiceHostRef = useRef<string | null>(null);
  if (voiceHost) lastVoiceHostRef.current = voiceHost;
  // Blocked people (docs/features/reports.md, stage 3): the voice client silences those of the identity we sit on the voice server with.
  useEffect(() => { client.setBlocked(voiceHost ? store.blockedFor(voiceHost) : []); }, [client, store, voiceHost, state.blocked]);
  /** The join under way, if any (joinVoice): the same host and channel asked again waits for it instead of starting over. */
  const joinInFlight = useRef<{ host: string; channelId: string; promise: Promise<void> } | null>(null);
  /** Moved to the AFK channel for inactivity: the voice channel the dock offers the way back to (user's decision: never automatically). */
  const [afkReturn, setAfkReturn] = useState<{ host: string; channelId: string } | null>(null);

  // AFK detection: input in this window, speaking (open gate of an unmuted microphone) and, where the user allowed it,
  // input anywhere in the system keep the user present (activity.ts); the store reports the state to servers and directory.
  useEffect(() => { void resumeIdleDetection(activity, platform.systemIdle === "always"); return watchActivity(activity); }, []);
  // A controller is input too, and the system's idle detection does not see it: the desktop app's shell reports it (systemActivity.ts).
  useEffect(() => watchSystemActivity(activity, platform.systemActivity), []);
  useEffect(() => client.subscribe((s) => { if (s.gateOpen && !s.micMuted) activity.touch(); }), [client]);

  // Camera on/off. With several cameras always ask first (as the user specified), with one switch on directly.
  const toggleCamera = useCallback(async () => {
    if (voice.cameraOn) { await client.setCameraEnabled(false); return; }
    const { cameras } = await VoiceClient.listDevices(true).catch(() => ({ cameras: [] as MediaDeviceInfo[] }));
    // Dialog as soon as there is something to choose: several cameras or a selectable background.
    if (cameras.length > 1 || (cameras.length === 1 && VoiceClient.supportsBlur())) { setPickWindow(stageFocus.current()); setCameraPick(cameras); }
    else await client.setCameraEnabled(true, cameras[0]?.deviceId ?? null, voiceSettings.cameraQuality, voiceSettings.cameraBlur);
  }, [client, voice.cameraOn, voiceSettings.cameraQuality, voiceSettings.cameraBlur]);

  // Background blur on/off (strength from the settings, default light).
  const toggleBlur = useCallback(async () => {
    const next = voice.cameraBlur > 0 ? 0 : (voiceSettings.cameraBlur || 10);
    const s = { ...voiceSettings, cameraBlur: next };
    saveVoiceSettings(s);
    await client.setCameraBlur(next);
  }, [client, voice.cameraBlur, voiceSettings]);

  const pickCamera = useCallback(async (deviceId: string, blur: number) => {
    setCameraPick(null);
    const next = { ...voiceSettings, cameraDeviceId: deviceId, cameraBlur: blur };
    saveVoiceSettings(next);
    await client.setCameraEnabled(true, deviceId, next.cameraQuality, next.cameraBlur);
  }, [client, voiceSettings]);

  useEffect(() => store.subscribe(setState), [store]);
  useEffect(() => client.subscribe(setVoice), [client]);
  // Global shortcuts and the push-to-talk key across the system (desktop app, docs/features/hotkeys.md): the shell gets the
  // bindings of this device and, while in a voice channel with push-to-talk, the key to watch; it answers what it could do.
  const hotkeys = platform.hotkeys;
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const watchedPttKey = voice.status !== "disconnected" && !voice.afkRoom && voiceSettings.mode === "ptt" ? voiceSettings.pttKey : null;
  useEffect(() => {
    if (!hotkeys) return;
    let stale = false;
    void hotkeys.set({ bindings: voiceSettings.hotkeys, pttKey: watchedPttKey }).then((status) => { if (!stale) setHotkeyStatus(status); }).catch(() => {});
    return () => { stale = true; };
  }, [hotkeys, voiceSettings.hotkeys, watchedPttKey]);
  useEffect(() => hotkeys?.onControl((event) => applyControl(client, event)), [hotkeys, client]);
  // Cue settings reach the voice client from here, whether the user changed them or the directory account supplied them.
  useEffect(() => client.setSoundSettings(voiceSettings.sounds), [client, voiceSettings.sounds]);
  useEffect(() => client.setCueOutput(voiceSettings.outputDeviceId), [client, voiceSettings.outputDeviceId]);
  // A new direct message or a mention the user does not see right now (store.ts `incoming`): the cue, in every client, and a
  // notification of the operating system where this device allows it (docs/features/notifications.md).
  useEffect(() => {
    store.onIncoming = (note) => {
      client.playSound("message");
      const settings = loadNotificationSettings(platform.kind === "desktop");
      if (settings.on && platform.notifications.permission() === "granted") platform.notifications.show({ ...notificationFor(note, note.kind === "dm" ? settings.dmPreview : settings.preview, t("notify.hidden")), inFullscreen: settings.fullscreen });
    };
    return () => { store.onIncoming = null; };
  }, [store, client]);
  // A click on such a notification opens the conversation or the channel.
  useEffect(() => platform.notifications.onClick((tag) => {
    const target = parseNotificationTag(tag);
    if (!target) return;
    if (target.kind === "dm") store.selectPeer(target.peer);
    else { store.openServer(target.host); store.connection(target.host)?.selectChannel(target.channelId); }
    setStageOpen(false); setMobileContent(true);
  }), [store]);
  useEffect(() => {
    const clear = () => { if (document.visibilityState === "visible" && document.hasFocus()) store.clearMissed(); };
    window.addEventListener("focus", clear);
    document.addEventListener("visibilitychange", clear);
    return () => { window.removeEventListener("focus", clear); document.removeEventListener("visibilitychange", clear); };
  }, [store]);
  // Desktop app: the task bar icon (and the tray's) shows that something waits (attention.ts).
  const attention = attentionCount(Object.values(state.conversations).map((c) => c.unread), Object.values(state.servers).flatMap((s) => Object.values(s.mentions)), state.missed);
  useEffect(() => platform.window.attention?.set(attention), [attention]);
  useEffect(() => { if (!state.starting) platform.window.ready(); }, [state.starting]);
  // The same for the speech gate: the settings dialog only stores, a running connection follows from here.
  useEffect(() => client.setMode(voiceSettings.mode), [client, voiceSettings.mode]);
  useEffect(() => client.setThreshold(voiceSettings.vadThreshold), [client, voiceSettings.vadThreshold]);
  useEffect(() => client.setHangover(voiceSettings.vadHangoverMs), [client, voiceSettings.vadHangoverMs]);
  useEffect(() => client.setMicBoost(voiceSettings.micBoost), [client, voiceSettings.micBoost]);
  useEffect(() => {
    // A kick, ban or session loss on the voice connection's server ends it.
    store.voiceActive = () => client.state.status !== "disconnected";
    store.onRemoved = (host) => { if (host === voiceHostRef.current) { void client.leave(); setVoiceHost(null); } };
    void store.init();
  }, [store, client]);

  // Unexpected disconnect from LiveKit: also withdraw the channel presence at the app server.
  const [wasInVoice, setWasInVoice] = useState(false);
  useEffect(() => {
    const now = voice.status !== "disconnected";
    if (wasInVoice && !now) {
      if (voiceHostRef.current) store.connection(voiceHostRef.current)?.send({ type: "voice.leave" });
      setVoiceHost(null); setStageOpen(false); setAfkReturn(null);
      store.applyPendingLocale(); // a language change waited for this (store.ts reloadForLocale)
    }
    setWasInVoice(now);
  }, [voice.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Let typing indicators age out (re-render every 2 s)
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((t) => t + 1), 2000); return () => clearInterval(id); }, []);

  const leaveVoice = useCallback(async () => {
    if (voiceHostRef.current) store.connection(voiceHostRef.current)?.send({ type: "voice.leave" });
    setVoiceHost(null); setAfkReturn(null);
    await client.leave();
  }, [client, store]);

  /**
   * The app is about to go away (the desktop shell closes the window, quits or installs an update): leave the voice
   * channel now and give the leave cue the moment it needs to sound; nothing to wait for when it would stay silent.
   */
  const leaveVoiceBeforeQuit = useCallback(async () => {
    if (client.state.status === "disconnected") return;
    const ms = client.leaveCueMs();
    void leaveVoice();
    if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }, [client, leaveVoice]);
  useEffect(() => platform.window.beforeQuit?.(leaveVoiceBeforeQuit), [leaveVoiceBeforeQuit]);

  /**
   * Join a voice channel on `host`; if voice is running on another server, it is ended there first. `auto` = not the user's
   * own step (moved to the AFK channel, the channel's AFK role changed): the view stays as it is and the way back is kept.
   * `force` joins again although already there (a fresh token with the grants that fit the channel now).
   */
  const joinVoice = useCallback(async (host: string, channelId: string, opts: { auto?: boolean; force?: boolean } = {}) => {
    // The same join is already under way (between the token request and the connection nothing of it shows in `voice`
    // yet): a second client.join() would disconnect the room that is still connecting, and its connect() fails with
    // "Client initiated disconnect" (seen on a reload into a sticky channel, user's report of 23 September 2026).
    const flying = joinInFlight.current;
    if (flying && flying.host === host && flying.channelId === channelId && !opts.force) { if (!opts.auto) setStageOpen(true); return flying.promise; }
    const conn = store.connection(host);
    const srv = conn?.state.server;
    const ch = srv?.channels.find((c) => c.id === channelId);
    const afk = !!srv && srv.settings.afkChannelId === channelId;
    const settings = loadVoiceSettings();
    const joinsNow = !!conn && (voiceHostRef.current !== host || voice.channelId !== channelId || !!opts.force);
    // Inside the user gesture, before the first await, and the microphone FIRST: WebKit shows its microphone prompt only
    // while the tap counts, and the capture itself starts seconds later, after the token and the connection (an iPhone's
    // home screen app could join no channel). Nothing that starts audio comes before the request.
    // Not for the AFK channel (no microphone there). A join without a gesture loses nothing: the request is the same one, only earlier.
    if (joinsNow && !afk) client.prepareMic(settings.inputDeviceId, ch?.audioStereo ?? false);
    client.prepareAudio(); // the same gesture (browsers' autoplay/AudioContext rules)
    if (!conn) return;
    if (!opts.auto) { setStageOpen(true); setAfkReturn(null); }
    if (!joinsNow) return;
    const promise = (async () => {
      try {
        const { url, token } = await conn.api.rtcToken(channelId);
        // Voice on another server: withdraw the presence there; the room itself is switched by client.join(), never left
        // through leaveVoice(), whose "disconnected" would close the stage just opened (the effect on voice.status above).
        const previous = voiceHostRef.current;
        if (previous && previous !== host) { store.connection(previous)?.send({ type: "voice.leave" }); setVoiceHost(null); }
        const ice = new URLSearchParams(window.location.search).get("ice");
        await client.join(channelId, url, token, settings, {
          ...(ice === "relay" ? { iceTransportPolicy: "relay" as const } : {}),
          audio: { bitrate: ch?.audioBitrate ?? 64, stereo: ch?.audioStereo ?? false },
          ...(srv ? { video: { access: channelVideoAccess(srv, conn?.state.voice[channelId]), mayView: mayViewIn(srv, channelId) }, peerKeys: peerKeysOf(srv.members) } : {}),
          afk,
        });
      } catch (err) {
        client.releasePreparedMic(); // the token or the connection failed before the capture was taken over
        throw err;
      }
      setVoiceHost(host);
      // The mute state travels with the join (the AFK channel shows as muted and deafened); changes follow as voice.status below.
      conn.send({ type: "voice.join", channelId, micMuted: client.state.micMuted, deafened: client.state.deafened, cameraOn: client.state.cameraOn, screenOn: client.state.screenOn });
    })();
    joinInFlight.current = { host, channelId, promise };
    try { await promise; } finally { if (joinInFlight.current?.promise === promise) joinInFlight.current = null; }
  }, [client, store, voice.channelId, leaveVoice]);

  // Mute, sound off, camera and screen share reach everybody's sidebar and the status API through the server
  // (docs/features/status-api.md), not only the people in the same LiveKit room. The connection sends it only to a server that knows the event.
  useEffect(() => {
    if (!voiceHost || voice.status !== "connected") return;
    store.connection(voiceHost)?.send({ type: "voice.status", micMuted: voice.micMuted, deafened: voice.deafened, cameraOn: voice.cameraOn, screenOn: voice.screenOn });
  }, [store, voiceHost, voice.status, voice.micMuted, voice.deafened, voice.cameraOn, voice.screenOn]);

  const voiceServer = voiceHost ? state.servers[voiceHost] ?? null : null;
  // Who watches the own screen share (voice/shareViewers.ts), for its pop-out window; the stage works it out itself.
  const localIdentity = voice.participants.find((p) => p.isLocal)?.identity ?? null;
  const shareViewers = localIdentity ? viewersOf(voice.participants, localIdentity).map((p) => {
    const member = voiceServer?.server?.members.find((m) => m.userId === p.identity);
    return { identity: p.identity, name: member ? displayNameOf(member) : p.name, avatarUrl: member?.avatarUrl ?? null };
  }) : [];
  const videoWindows = useVideoWindows(voice.tiles.map((tile) => {
    const member = voiceServer?.server?.members.find((member) => member.userId === tile.identity);
    return member ? { ...tile, name: displayNameOf(member) } : tile;
  }), client, shareViewers);
  const voiceChannel = voiceServer?.server?.channels.find((c) => c.id === voice.channelId) ?? null;
  // The whole stage in a window of its own; the main window then shows no stage (`showStage` below).
  const stageWindow = useStageWindow(client, voiceChannel !== null, `${voiceChannel?.name ?? ""} | Squorli`);
  stageFocus.current = stageWindow.focusedWindow;
  // That window went while a dialog was open in it: the dialog goes with it.
  useEffect(() => {
    if (stageWindow.popped || !pickWindow) return;
    setPickWindow(null); setCameraPick(null);
    setScreenPick((open) => { open?.resolve(null); return null; });
  }, [stageWindow.popped, pickWindow]);

  // The channel's voice profile changed (admin) -> switch the microphone over live.
  useEffect(() => {
    if (voiceChannel) void client.setAudioProfile({ bitrate: voiceChannel.audioBitrate, stereo: voiceChannel.audioStereo });
  }, [client, voiceChannel?.audioBitrate, voiceChannel?.audioStereo]); // eslint-disable-line react-hooks/exhaustive-deps

  // The admin made this channel the AFK channel (or an ordinary one again): join once more, because the token decides what
  // may be sent and heard there. LiveKit has already enforced it for this connection (server, routes/settings.ts).
  const voiceChannelIsAfk = !!voiceChannel && voiceServer?.server?.settings.afkChannelId === voiceChannel.id;
  useEffect(() => {
    if (voice.status === "connected" && voiceHost && voiceChannel && voiceChannelIsAfk !== voice.afkRoom) void joinVoice(voiceHost, voiceChannel.id, { auto: true, force: true }).catch(() => {});
  }, [voiceChannelIsAfk, voice.afkRoom, voice.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Web radio of the voice channel: played locally, only while connected there; follows deafen.
  const channelRadio = voice.status === "connected" || voice.status === "reconnecting" ? voiceChannel?.radio ?? null : null;
  // A Twitch or YouTube source is no audio stream: the official player shows it (below), the radio player stays off.
  const radioUrl = channelRadio && !channelRadio.twitchChannel && !channelRadio.youtubeVideo ? channelRadio.streamUrl : null;
  const [radioState, setRadioState] = useState<RadioState>(radio.state);
  useEffect(() => radio.subscribe(setRadioState), [radio]);
  // Turned off for me = no player at all: no tile, no sound, no connection to Twitch or YouTube (user's requirement).
  const embedTwitch = !radioState.muted ? channelRadio?.twitchChannel ?? null : null;
  const embedYoutube = !radioState.muted ? channelRadio?.youtubeVideo ?? null : null;
  // Still no player then, but the stage says in a tile that a video runs and turns the radio back on (user's wish, 20 September 2026).
  // The tile can be dismissed; it is back with the next video: another source, or the same one started again after the radio
  // stopped. Kept here and not in the stage, which goes away whenever a text channel is shown; never stored.
  // A playlist counts as one: the tile does not come back with every video of it.
  const videoKey = channelRadio?.twitchChannel ? `twitch:${channelRadio.twitchChannel}` : channelRadio?.youtubeVideo ? (channelRadio.queue ? `youtube-queue:${channelRadio.queue.listId}` : `youtube:${channelRadio.youtubeVideo}`) : null;
  const [playerOffDismissed, setPlayerOffDismissed] = useState<string | null>(null);
  useEffect(() => { if (videoKey === null) setPlayerOffDismissed(null); }, [videoKey]);
  const playerOff = radioState.muted && channelRadio && videoKey !== playerOffDismissed ? (channelRadio.twitchChannel ? "twitch" : channelRadio.youtubeVideo ? "youtube" : null) : null;
  const embedQueue = channelRadio?.queue?.listId ?? null;
  const embedSource = useMemo<EmbedSource | null>(() => embedTwitch ? { kind: "twitch", channel: embedTwitch } : embedYoutube ? { kind: "youtube", videoId: embedYoutube, queue: embedQueue } : null, [embedTwitch, embedYoutube, embedQueue]);
  const playerWindow = usePlayerWindow(embedKeyOf(embedSource));
  // AFK: a video in another program keeps the user present, told by a system state that Squorli sets itself while it shows
  // video. So while a camera, a screen share or the radio's player is on, that state is ignored (systemActivity.ts).
  const ownVideo = videoActive(voice.participants, embedSource !== null);
  useEffect(() => setOwnVideo(activity, ownVideo), [ownVideo]);
  // A video plays in step for everyone; members with CONTROL_RADIO steer it through their own player (EmbedPlayer.tsx).
  const embedSync = useMemo(() => {
    const playback = channelRadio?.playback, channelId = voiceChannel?.id, api = voiceHost ? store.connection(voiceHost)?.api : null;
    if (!embedYoutube || !playback || !channelId || !api) return null;
    return { playback, clockOffset: voiceServer?.clockOffset ?? 0, canControl: hasPermission(voiceServer?.server?.myPermissions ?? 0, Permission.CONTROL_RADIO), publish: (p: { playing: boolean; position: number; rate: number }) => api.setRadioPlayback(channelId, p),
      // Over: a queue moves on, and a single video or a queue's last one turns the radio off (the server decides; one that predates that answers 409 for a single video).
      ended: (videoId: string) => { void api.advanceRadio(channelId, { from: videoId, ended: true }).catch(() => {}); } };
  }, [embedYoutube, embedQueue, channelRadio?.playback, voiceChannel?.id, voiceHost, store, voiceServer?.clockOffset, voiceServer?.server?.myPermissions]);
  useEffect(() => radio.setStream(radioUrl), [radio, radioUrl]);
  useEffect(() => radio.setDeafened(voice.deafened), [radio, voice.deafened]);
  // Its own output device when one is chosen (settings > audio devices), otherwise where the voices play.
  const radioSink = voiceSettings.radioOutputDeviceId ?? voiceSettings.outputDeviceId;
  useEffect(() => radio.setOutputDevice(radioSink), [radio, radioSink]);
  // The players of a Twitch or YouTube source are foreign iframes no page can route; the desktop app's shell can, and is
  // told the device by its label (ids differ per origin). Again when devices come and go: the chosen one may be back.
  useEffect(() => tellPlayerOutput(platform.media.setPlayerOutput, radioSink), [radioSink]);
  // Videos linked in the chat play where screen share audio plays (user's wish): "something I watch", not the radio.
  const chatVideoSink = voiceSettings.screenOutputDeviceId ?? voiceSettings.outputDeviceId;
  useEffect(() => tellPlayerOutput(platform.media.setChatPlayerOutput, chatVideoSink), [chatVideoSink]);

  // Permission VIEW_VIDEO: roles or members changed -> the running connection restricts its camera/screen to the members
  // who may watch (enforced by LiveKit), and stops receiving others' feeds when we lost the permission ourselves.
  const voiceState = voiceServer?.server ?? null;
  // Who sits in my voice channel, each with `viewVideo` as the server resolved it for this channel (videoAccess.ts).
  const voiceSeated = voice.channelId ? voiceServer?.voice[voice.channelId] : undefined;
  const afkReturnChannel = afkReturn && voice.afkRoom ? state.servers[afkReturn.host]?.server?.channels.find((c) => c.id === afkReturn.channelId) ?? null : null;
  useEffect(() => {
    if (voiceState) client.setVideoAccess(channelVideoAccess(voiceState, voiceSeated), mayViewIn(voiceState, voice.channelId));
  }, [client, voiceState?.roles, voiceState?.members, voiceState?.settings.ownerId, voiceState?.myPermissions, voiceState?.myChannelPermissions, voiceSeated, voice.channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-person playback volume is stored by public key; the voice client only sees LiveKit identities (user ids of this server).
  useEffect(() => { if (voiceState) client.setPeerKeys(peerKeysOf(voiceState.members)); }, [client, voiceState?.members]); // eslint-disable-line react-hooks/exhaustive-deps

  // Moderation (M3): carry out a moderator's move or stop and tell the user what happened.
  useEffect(() => {
    store.onVoiceMoved = (host, channelId, by, reason, until) => {
      // A removal (channelId null) may arrive after LiveKit already dropped us (PARTICIPANT_REMOVED): it still explains why.
      const late = channelId === null && host === lastVoiceHostRef.current && client.state.status === "disconnected";
      if (host !== voiceHostRef.current && !late) return;
      if (channelId && reason === "afk") {
        // Inactivity: into the AFK channel; the dock explains it and offers the way back to where the user was.
        const from = client.state.channelId;
        if (from === channelId) return;
        if (from) setAfkReturn({ host, channelId: from });
        void joinVoice(host, channelId, { auto: true }).catch(() => {});
      } else if (channelId) {
        const name = store.connection(host)?.state.server?.channels.find((c) => c.id === channelId)?.name ?? t("app.otherChannel");
        client.setNotice(t("app.movedNotice", { by, name }));
        void joinVoice(host, channelId).catch(() => {});
      } else if (reason === "elsewhere") {
        // The same account joined a voice channel of this server from another device or tab: that one takes over.
        client.setNotice(t("app.voiceElsewhereNotice"));
        void leaveVoice();
      } else if (reason === "blocked") {
        // A moderator removed and blocked us (docs/features/channel-blocks.md); `until` null = for good.
        client.setNotice(until ? t("app.blockedNotice", { by, minutes: blockMinutes(until, Date.now()) }) : t("app.blockedForeverNotice", { by }));
        void leaveVoice();
      } else if (reason === "votekick") {
        // Voted out (docs/features/votekick.md): the result came just before this event and carries how long the channel stays closed.
        const res = store.connection(host)?.state.voteKickResult ?? null;
        client.setNotice(t("votekick.kickedNotice", { minutes: blockMinutes(res?.blockedUntil ?? null, Date.now()) }));
        void leaveVoice();
      } else {
        client.setNotice(t("app.removedNotice", { by }));
        void leaveVoice();
      }
    };
    store.onVoiceStop = (host, what, by) => {
      if (host !== voiceHostRef.current) return;
      const parts = [what.camera && voice.cameraOn ? t("app.camera") : "", what.screen && voice.screenOn ? t("app.screenShare") : ""].filter(Boolean);
      if (what.camera) void client.setCameraEnabled(false);
      if (what.screen) void client.setScreenShareEnabled(false);
      if (parts.length) client.setNotice(t("app.stoppedNotice", { by, what: parts.join(t("app.and")) }));
    };
    // The channel one sits in is no longer visible (the access went away; the server dropped the room too).
    store.onVoiceGone = (host) => {
      if (host !== voiceHostRef.current) return;
      client.setNotice(t("voice.channelGone"));
      void leaveVoice();
    };
    return () => { store.onVoiceMoved = null; store.onVoiceStop = null; store.onVoiceGone = null; };
  }, [store, client, joinVoice, leaveVoice, voice.cameraOn, voice.screenOn]);

  // A sticky channel that holds the user beyond a reload (docs/features/channel-permissions.md): the server says so with
  // the welcome (`myVoiceLock`), the client goes back in and says why. Without a gesture the microphone may have to be
  // asked for later; the join itself loses nothing (see joinVoice).
  const lockOf = (s: { server: ServerState | null } | null | undefined) => s?.server?.myVoiceLock ?? null;
  // One attempt per lock: the effect runs on every server state change (presence, structure), and a second joinVoice()
  // while the first still connects, or after the server refused, must not start over. A new lock (other channel, or the
  // lock gone and back) is tried again; the user can always click the channel.
  const stickyTried = useRef<string | null>(null);
  useEffect(() => {
    const host = state.activeHost;
    const conn = host ? store.connection(host) : null;
    const lock = lockOf(conn?.state);
    if (!lock) { stickyTried.current = null; return; }
    const key = `${host}\n${lock.channelId}`;
    if (!host || !conn || voice.status !== "disconnected" || voiceHostRef.current || stickyTried.current === key) return;
    stickyTried.current = key;
    const name = conn.state.server?.channels.find((c) => c.id === lock.channelId)?.name ?? t("app.otherChannel");
    client.setNotice(t("voice.stickyReturn", { name }));
    void joinVoice(host, lock.channelId, { auto: true }).catch(() => {});
  }, [state.activeHost, store, client, joinVoice, voice.status, state.servers]); // eslint-disable-line react-hooks/exhaustive-deps

  const home = homeState(state);
  const active = activeState(state);
  const activeHost = state.activeHost;
  const conn = store.connection(activeHost) ?? store.home;

  // Page title = name of the displayed server, favicon = its icon (admin) or the Squorli mark; also applies to the login screen.
  const title = active?.server?.settings.name ?? active?.serverName ?? "Squorli";
  const iconUrl = active?.server && conn ? (active.server.settings.iconUrl ? conn.api.abs(active.server.settings.iconUrl) : null) : active?.iconUrl ?? null;
  useEffect(() => applyBranding(title, iconUrl), [title, iconUrl]);
  const homeName = home?.server?.settings.name ?? home?.serverName ?? null;
  useEffect(() => { applyHomeScreenName(homeName); rememberHomeName(homeName); }, [homeName]);

  // Einstellungen > Geräte (docs/features/devices.md): the devices of the account in use, the server account's of the server
  // shown or the directory account's. The functions keep their identity while nothing about the account changes: the tab
  // loads its list whenever `load` is another one.
  const deviceScope = store.deviceScope();
  const deviceAccount = deviceScope === "local" ? `~${activeState(state)?.me?.localHandle ?? ""}` : `@${state.directoryAccount?.handle ?? ""}`;
  const deviceHost = state.activeHost;
  const canRevokeDevices = deviceScope === "local" || state.deviceRevoke;
  const devicesHavePassword = deviceScope === "local" || state.directoryAccount?.hasBackup === true;
  const deviceList = useMemo(() => (deviceScope === null ? null : {
    scope: deviceScope, account: deviceAccount, canRevoke: canRevokeDevices, hasPassword: devicesHavePassword,
    load: deviceScope === "local" ? () => store.localDevices() : async () => { await store.refreshAccountServers(); return store.state.devices; },
    revoke: (target: string, password: string, code?: string) => store.revokeDevices(target, password, code),
  }), [store, deviceScope, deviceAccount, deviceHost, canRevokeDevices, devicesHavePassword]);

  // With a home server the client hangs off the session there; without one (desktop app) it has a login of its own.
  const homeless = state.homeHost === null;
  // Still finding out what the first screen is (store.ts `starting`): the desktop app's start window covers that time.
  if (state.starting) return <><TitleBar title="Squorli" /><div className="app-starting" role="status"><div className="app-starting-card"><img src="/brand/squorli-icon.svg" alt="" /><span>{t("app.starting")}</span></div></div></>;
  // Signed in on the own server, but it does not answer (docs/features/offline.md): a notice with retries, never the login.
  if (!homeless && home && !home.server && home.waiting) return <><TitleBar title={homeName ?? "Squorli"} /><ServerOffline s={home} onRetry={() => store.home?.retryByUser()} onLogout={() => { void signOut(store); }} /></>;
  if (homeless ? !state.signedIn : !home?.server || !home.me || !home.userId) return <><TitleBar title="Squorli" />{homeless ? <DesktopLogin store={store} state={state} /> : <LoginScreen store={store} state={state} />}</>;

  const server = active?.server ?? null;
  /** The server on screen with its connection; null = none is shown (connecting, join view, or no server at all). */
  const view = active && conn && server ? { active, conn, server } : null;
  const current = view?.server.channels.find((c) => c.id === view.active.currentChannelId && c.kind === "text") ?? null;
  const me = view?.server.members.find((m) => m.userId === view.active.userId);
  // Own avatar: the directory account knows it first (an upload from the settings updates it at once, the member list follows
  // with the directory's push); without an account whatever the open server says.
  // A server signed in with a server account shows that account's picture (kept by the server), not the directory's.
  const onServerAccount = !!active && !!state.serverAccounts[active.host];
  const myAvatarUrl = onServerAccount ? active?.me?.avatarUrl ?? null : state.directoryUrl && state.directoryAccount
    ? directoryAvatarUrl(state.directoryUrl, state.directoryAccount.publicKey, state.directoryAccount.avatarUpdatedAt)
    : me ? me.avatarUrl : active?.me?.avatarUrl ?? null;
  const canStream = !!server && hasPermission(server.myPermissions, Permission.STREAM_VIDEO);
  // M7: home view with friends and direct messages as soon as the directory socket exists (an account at the directory).
  // A suspended account has no socket, but the view is where the suspension is explained.
  const homeAvailable = state.friends !== null || state.directoryLink !== "idle" || state.suspendedUntil !== null;
  const homeOpen = homeAvailable && state.homeOpen;
  // The stage belongs to the voice connection's server; on another server or in the home view the dock shows "view" and switches there.
  const showStage = stageOpen && voiceChannel !== null && voiceHost === activeHost && !homeOpen && !stageWindow.popped && (!mobile || mobileContent);
  // The stage is in its own window: where it would be, the main window keeps a place holder that brings it back with a click
  // (user's wish, 27 September 2026). A text channel chosen in the sidebar shows the chat as before.
  const stageAway = stageOpen && voiceChannel !== null && voiceHost === activeHost && !homeOpen && stageWindow.popped && (!mobile || mobileContent);
  // The stage shows the voice connection's server, which in its own window need not be the one on screen.
  const voiceApi = voiceHost ? store.connection(voiceHost)?.api ?? null : null;
  // Hanging up on a phone's stage goes back to the channel list (user's wish, 22 September 2026), not to the text channel
  // that would otherwise appear under the vanished stage. The list slides in first, so the leave's wait is never seen.
  // A plain function, not a hook: this point is below the early returns (login screen), where no hook may sit.
  /** A sticky channel holds the user: hanging up is refused with the reason (the server would refuse every other channel anyway). */
  const voiceLock = lockOf(voiceServer);
  const hangUp = async () => {
    if (voiceLock) { void showNotice({ title: t("voice.noticeTitle"), text: t("voice.stickyNotice") }); return; }
    if (mobile) { setMobileContent(false); setStageOpen(false); }
    await leaveVoice();
  };
  /** My permissions in a channel of a server: the channel-resolved mask, or on a server from before the server-wide one. */
  const permsIn = (s: ServerState, channelId: string | null) => (channelId ? s.myChannelPermissions?.[channelId] : undefined) ?? s.myPermissions;
  // The account already sits in a voice channel of that server from another device or tab: joining from here ends that
  // connection (the server does it at voice.join), so the user confirms first (user's wish, 22 September 2026). A seat of
  // this client is not "elsewhere". Without anything to confirm the join starts synchronously in the click, as the
  // microphone request needs (voice/AGENTS.md); after the confirm the dialog's own click is that gesture.
  const elsewhereName = (host: string): string | null => {
    const conn = store.connection(host);
    if (!conn?.state.userId || (voiceHostRef.current === host && client.state.status !== "disconnected")) return null;
    const channelId = voiceElsewhere(conn.state.voice, conn.state.userId);
    return channelId ? conn.state.server?.channels.find((c) => c.id === channelId)?.name ?? t("app.otherChannel") : null;
  };
  const confirmElsewhere = (name: string) => askConfirm({ title: t("voice.elsewhereTitle"), text: t("voice.elsewhereText", { channel: name }), confirmLabel: t("voice.elsewhereJoin") });
  const joinVoiceAsked = (host: string, channelId: string): Promise<void> => {
    const lock = lockOf(store.connection(host)?.state);
    if (lock && lock.channelId !== channelId) { void showNotice({ title: t("voice.noticeTitle"), text: t("voice.stickyBlocked") }); return Promise.resolve(); }
    const name = elsewhereName(host);
    return name ? confirmElsewhere(name).then((ok) => (ok ? joinVoice(host, channelId) : undefined)) : joinVoice(host, channelId);
  };
  // A join that failed before the voice client had a say (the token, the server) has no text in the client's state, which
  // the modal above would show: it gets the same modal with the bare error.
  // Vote kick (docs/features/votekick.md): the box belongs to the voice connection's channel, whatever server is on screen.
  const voteKick = voiceServer?.voteKick && voiceServer.voteKick.vote.channelId === voice.channelId ? voiceServer.voteKick : null;
  const voteKickResult = voiceServer?.voteKickResult && voiceServer.voteKickResult.channelId === voice.channelId ? voiceServer.voteKickResult : null;
  // The member the vote is about, drawn like members are drawn everywhere else (user's wish, 23 September 2026).
  const votePerson = (() => {
    const s = voiceServer?.server, about = voteKick?.vote ?? voteKickResult;
    return s && about ? voteKickPerson({ userId: about.targetId, fallbackName: about.targetName, members: s.members, roles: s.roles }) : null;
  })();
  const voteKickFailed = (err: unknown) => { void showNotice({ title: t("votekick.title"), text: voteKickErrorText(err) }); };
  const castVote = (yes: boolean) => {
    if (!voteKick || !voiceApi) return;
    setVoteAsked(voteKick.vote.id);
    voiceApi.castVoteKick(voteKick.vote.channelId, yes).catch(voteKickFailed);
  };
  /** The menu entry of the member list, the sidebar and the stage; the server checks all the rules again. */
  const startVoteKick = (host: string, channelId: string, userId: string) => {
    store.connection(host)?.api.startVoteKick(channelId, userId).catch(voteKickFailed);
  };
  const reportJoinError = (err: unknown) => { if (!client.state.error) void showNotice({ title: t("voice.errorTitle"), text: joinErrorText(err) }); };
  const stage = (detached: boolean) => voiceChannel && voiceServer?.server && voiceApi ? (
    <VoiceStage client={client} voice={voice} channel={voiceChannel} members={voiceServer.server.members} myPermissions={permsIn(voiceServer.server, voiceChannel.id)} locked={!!voiceLock}
      myUserId={voiceServer.userId ?? ""} roster={voiceServer.voice} channels={voiceServer.server.channels} channelPermissions={(id) => permsIn(voiceServer.server!, id)}
      voteKickAllowed={voiceServer.voteKickAllowed} onVoteKick={(userId, channelId) => { if (voiceHost) startVoteKick(voiceHost, channelId, userId); }}
      api={voiceApi} radio={radio} radioStations={voiceServer.server.radioStations} radioTitle={voiceServer.radioTitles[voiceChannel.id] ?? null} playerTile={embedKeyOf(embedSource)} playerOff={playerOff} onDismissPlayerOff={() => setPlayerOffDismissed(videoKey)} playerPopped={playerWindow.win !== null} onRestorePlayer={playerWindow.restore}
      onToggleCamera={toggleCamera} onToggleBlur={toggleBlur} onLeave={hangUp} onPopout={videoWindows.open} poppedIds={videoWindows.poppedIds} onRestore={videoWindows.restore}
      detached={detached} onToggleWindow={detached ? stageWindow.close : stageWindow.open} />
  ) : null;
  /** A dialog the stage asked for from its own window is shown there. */
  const inPickWindow = (dialog: ReactNode) => pickWindow && stageWindow.popped ? createPortal(dialog, pickWindow.document.body) : dialog;
  const homeBadge = (state.friends ?? []).filter((f) => f.state === "pending_in").length + Object.values(state.conversations).reduce((n, c) => n + c.unread, 0);
  const friendsMenu = homeAvailable ? {
    stateOf: (pk: string) => store.friendState(pk) ?? null,
    onRequest: (pk: string) => { store.requestFriend(pk); store.openHome(true); },
    onMessage: (pk: string) => { const st = store.friendState(pk); if (st === "accepted") { store.selectPeer(pk); setMobileContent(true); } else store.openHome(true); },
    onRemove: (pk: string, name: string) => askRemoveFriend(store, pk, name),
    onAccept: (pk: string) => store.acceptFriend(pk),
    // The member list's small profile: send, then show the conversation in the friends view (user's wish, 24 September 2026).
    onSend: async (pk: string, text: string) => { await store.sendDm(pk, text); store.selectPeer(pk); setMobileContent(true); },
  } : null;
  // Reports to the directory's operator (docs/features/reports.md): only with the directory account, never with a server
  // account's key (it has no account there), and only for the kinds the directory takes.
  const directoryHost = (() => { try { return state.directoryUrl ? new URL(state.directoryUrl).host : null; } catch { return null; } })();
  const mayReport = (kind: "account" | "server", host: string | null) => !!state.directoryAccount && !!directoryHost && state.suspendedUntil === null && state.reportKinds.includes(kind) && !(host !== null && state.serverAccounts[host]);
  const reportAccount = (host: string | null) => (mayReport("account", host) ? (publicKey: string, name: string) => setDirectoryReport({ kind: "account", publicKey, name }) : null);
  const reportServer = mayReport("server", null) ? (host: string, name: string) => setDirectoryReport({ kind: "server", host, name }) : null;
  // Blocking people (docs/features/reports.md, stage 3): per server the identity used there decides whose list applies (store.ts).
  const blockControlsFor = (host: string): BlockControls => ({
    has: (pk) => store.blockedFor(host).includes(pk),
    onBlock: (pk, name, directory) => askBlockPerson(store, host, pk, name, directory),
    onUnblock: (pk) => store.setBlocked(host, pk, false, { directory: true }),
  });
  // The settings' list of the identity used on the server shown: names from any open server, from the friends, else the name
  // remembered when blocking (this device), else the key.
  const blockedList = (() => {
    const known = new Map<string, string>();
    for (const s of Object.values(state.servers)) for (const m of s.server?.members ?? []) known.set(m.publicKey, m.displayName);
    for (const f of state.friends ?? []) if (!known.has(f.publicKey)) known.set(f.publicKey, `@${f.handle}`);
    const remembered = loadBlockedNames();
    return store.blockedFor(activeHost).map((pk) => ({ publicKey: pk, name: known.get(pk) ?? remembered[pk] ?? `${pk.slice(0, 16)}…` }));
  })();
  const blockedInAccount = !!state.directoryAccount && state.settingsSealed && !(activeHost && state.serverAccounts[activeHost]);

  // Server rail: own server first, then the account's servers from the directory (without duplicating our own).
  // Without a home server: the account's servers, then the ones added by address, and the one being looked at before joining.
  const homeDirHost = home?.serverDomain ?? window.location.hostname;
  const nameOf = (host: string) => state.servers[host]?.server?.settings.name ?? state.servers[host]?.serverName ?? null;
  const railServers = buildRailServers({
    home: home?.server && state.homeHost !== null ? { key: state.homeHost, host: homeDirHost, name: home.server.settings.name, sub: null, iconUrl: home.server.settings.iconUrl } : null,
    accountServers: state.accountServers ?? [],
    localHosts: homeless ? [...state.localHosts, ...(activeHost !== null ? [activeHost] : [])].map((host) => ({ host, name: nameOf(host) })) : [],
    keyOf: (host) => store.hostFor(host),
    iconOf: (s) => (state.directoryUrl ? directoryServerIconUrl(state.directoryUrl, s.host, s.iconUpdatedAt) : null),
    subOf: (name) => t("app.asName", { name }),
    order: voiceSettings.serverOrder,
  });
  const showRail = !!state.directoryUrl || homeless || mobile;
  const addServer = async (initial = "") => {
    const input = await askInput({ title: t("add.title"), text: t("add.text"), label: t("add.label"), placeholder: t("add.placeholder"), initial, maxLength: 400, confirmLabel: t("add.confirm") });
    if (input === null) return;
    const error = await store.addServer(input);
    if (error) { await askConfirm({ title: t("add.title"), text: error, confirmLabel: t("common.ok") }); void addServer(input); return; }
    setStageOpen(false);
  };
  const railState = Object.fromEntries(Object.entries(state.servers).map(([k, s]) => [k, {
    // Muted channels and a muted server give no unread mark; mentions always count.
    unread: !s.serverMuted && Object.entries(s.unread).some(([id, u]) => u && !s.muted[id]), muted: s.serverMuted, canMute: s.readSync && s.connection === "connected", mentions: Object.values(s.mentions).reduce((n, c) => n + c, 0), voice: k === voiceHost && voice.status !== "disconnected", connection: s.connection,
    people: voiceActivity(s.voice, s.server?.settings.afkChannelId ?? null),
    reports: s.server?.openReports ?? 0,
    unreachable: s.waiting === "unreachable",
    refused: s.refused,
  }]));
  // Rail context menu: delete your account on that server, requested through the directory (own confirmation dialog, no browser dialogs).
  const leaveServer = async (host: string, name: string) => {
    // A server account is deleted on its server with its password (Einstellungen > Konto), not through the directory.
    const key = store.hostFor(host);
    if (state.serverAccounts[key]) { store.openServer(host); setSettingsTab("account"); return; }
    const ok = await askConfirm({ title: t("rail.leaveTitle", { name }), text: t("rail.leaveText"), confirmLabel: t("common.delete"), danger: true });
    if (!ok) return;
    try {
      const r = await store.leaveServer(host);
      if (!r.delivered) await askConfirm({ title: t("rail.leaveTitle", { name }), text: r.registered ? t("rail.leaveQueued") : t("rail.leaveUnregistered"), confirmLabel: t("common.ok") });
    } catch (err) {
      await askConfirm({ title: t("rail.leaveFailed"), text: err instanceof Error ? err.message : String(err), confirmLabel: t("common.ok") });
    }
  };

  return (
    <GameLibraryContext.Provider value={gameLibrary}>
    <TitleBar title={title} onRestartForUpdate={() => { void (async () => {
      // Restarting ends a voice connection: ask first while in one.
      if (voice.status !== "disconnected" && !await askConfirm({ title: t("update.restartTitle"), text: t("update.restartInVoice"), confirmLabel: t("update.restart") })) return;
      await leaveVoiceBeforeQuit(); // the install quits without asking again (the shell skips its hand-off there)
      platform.updates?.restartAndInstall();
    })(); }} />
    <div className={`app ${showRail ? "with-rail" : ""} ${homeOpen ? "home" : ""} ${mobileContent ? "mobile-content" : ""} ${showStage ? "mobile-stage" : ""} ${mobile && mobileMembers && !homeOpen && view ? "mobile-members" : ""} ${!homeOpen && !view ? "no-members" : ""}`} style={{ "--left-w": `${layout.left}px`, "--members-w": `${layout.members}px` } as CSSProperties}>
      <ColumnHandle column="left" width={layout.left} label={t("layout.resizeLeft")} onChange={(w) => resizeColumn("left", w, false)} onCommit={(w) => resizeColumn("left", w, true)} />
      {!homeOpen && view && <ColumnHandle column="members" width={layout.members} label={t("layout.resizeMembers")} onChange={(w) => resizeColumn("members", w, false)} onCommit={(w) => resizeColumn("members", w, true)} />}
      {videoWindows.windows}
      {stageWindow.render(stage(true))}
      {embedSource && channelRadio && <EmbedPlayer source={embedSource} name={channelRadio.name} volume={radioState.volume} muted={voice.deafened} popout={playerWindow} sync={embedSync} onNotice={(text) => client.setNotice(text)} onTurnOff={() => radio.setMuted(true)}
        onStreamOver={() => { const api = voiceHost ? store.connection(voiceHost)?.api : null; if (api && voiceChannel && embedTwitch) void api.radioOffline(voiceChannel.id, embedTwitch).catch(() => {}); }} />}
      {showRail && <ServerRail servers={railServers} serverState={railState} activeKey={homeOpen ? null : activeHost} onAdd={homeless ? () => { void addServer(); } : null}
        onSelect={(key, host) => { setMobileContent(false); setVoicePreview(null); if (key === state.homeHost) { store.openServer(homeDirHost); } else store.openServer(host); setStageOpen(key === voiceHost && stageOpen); }}
        onDiscover={state.directoryUrl ? () => setShowBrowser(true) : null} onLeave={(host, name) => { void leaveServer(host, name); }}
        onMute={(key, muted) => { void store.connection(key)?.setServerMuted(muted).catch(() => {}); }}
        onReorder={(hosts) => { saveVoiceSettings({ ...loadVoiceSettings(), serverOrder: hosts }); }}
        home={homeAvailable ? { open: homeOpen, badge: homeBadge, onToggle: () => { setMobileContent(false); store.openHome(!homeOpen); } } : null}
        serverAccounts={state.serverAccounts} onSignOutAccount={(key) => { if (key === voiceHost) void client.leave(); store.logoutServerAccount(key); }} onReport={reportServer}
        onRemoveRefused={(key) => store.removeRefused(key)} />}
      {showBrowser && state.directoryUrl && <ServerBrowser directoryUrl={state.directoryUrl} currentHost={homeless ? active?.serverDomain ?? null : home?.serverDomain ?? null} onClose={() => setShowBrowser(false)}
        onOpen={homeless ? (host) => { setShowBrowser(false); setStageOpen(false); void store.addServer(host); } : null}
        onReport={reportServer ? (host, name) => { setShowBrowser(false); reportServer(host, name); } : null} />}
      <div className="left" id="app-navigation">
        {homeOpen ? <HomeSidebar state={state} store={store} members={server?.members ?? []} onOpenChat={() => setMobileContent(true)} onReportAccount={reportAccount(null)} /> : view ? <Sidebar
          server={view.server} api={view.conn.api} host={view.active.host} currentChannelId={(showStage || stageAway) && voiceChannel ? voiceChannel.id : view.active.currentChannelId} voice={view.active.voice}
          voiceState={voiceHost === activeHost ? voice : null} client={client} radioTitles={view.active.radioTitles} unread={view.active.unread} unreadCount={view.active.unreadCount} mentions={view.active.mentions} muted={view.active.muted} canMute={view.active.readSync}
          onMuteChannel={(id, muted) => { void view.conn.setChannelMuted(id, muted).catch(() => {}); }} onOpenChannelDialog={setChannelEdit}
          connection={view.active.connection} onSelect={(id) => { view.conn.selectChannel(id); setStageOpen(false); setMobileContent(true); }}
          onJoinVoice={(id) => { if (mobile) setVoicePreview(id); else void joinVoiceAsked(view.active.host, id).catch(reportJoinError); }} onOpenAdmin={() => setShowAdmin(true)} myUserId={view.active.userId ?? ""}
          voteKickAllowed={view.active.voteKickAllowed} onVoteKick={(userId, channelId) => startVoteKick(view.active.host, channelId, userId)}
          onOpenMembers={mobile ? () => setMobileMembers(true) : null}
        /> : <nav className="sidebar"><header className="server-head"><img className="brand-mark" src="/brand/squorli-icon-small.svg" alt="" width="22" height="22" /><strong>{active ? active.serverName ?? (state.accountServers ?? []).find((a) => store.hostFor(a.host) === active.host)?.name ?? active.host : "Squorli"}</strong></header></nav>}
        <VoiceDock client={client} voice={voice} channel={voiceChannel} serverName={voiceHost && voiceHost !== activeHost ? voiceServer?.server?.settings.name ?? voiceHost : null}
          displayName={me?.displayName ?? active?.me?.displayName ?? home?.me?.displayName ?? state.directoryAccount?.displayName ?? (active?.me ? handleLabel(active.me) : null) ?? (state.directoryAccount ? `@${state.directoryAccount.handle}` : "…")} avatarUrl={myAvatarUrl} onLeave={leaveVoice} onOpenProfile={setMiniProfile} onOpenSettings={() => setSettingsTab("profile")} pttSuspended={capturingPttKey}
          onOpenStage={stageWindow.popped ? () => { if (voiceHost) store.openServer(voiceHost === state.homeHost ? homeDirHost : voiceHost); setStageOpen(true); setMobileContent(true); stageWindow.focus(); } : voiceChannel && !showStage && voiceHost ? () => { store.openServer(voiceHost === state.homeHost ? homeDirHost : voiceHost); setStageOpen(true); setMobileContent(true); } : null}
          canStream={!!voiceServer?.server && hasPermission(permsIn(voiceServer.server, voice.channelId), Permission.STREAM_VIDEO) && (voiceChannel?.allowVideo ?? true)} locked={!!voiceLock} onToggleCamera={toggleCamera}
          quickShare={runningGame && voice.status === "connected" && !voice.screenOn ? { name: runningGame.name, onShare: () => { quickShare.current = runningGame.id; void client.setScreenShareEnabled(true).finally(() => { quickShare.current = null; }); } } : null}
          afkReturn={afkReturn && voice.afkRoom ? { name: afkReturnChannel?.name ?? null, onReturn: () => { void joinVoice(afkReturn.host, afkReturn.channelId).catch(() => {}); } } : null} />
      </div>

      <main className={`main ${!view && !homeOpen ? "mobile-status" : ""}`}>
        {mobile && mobileContent && <button className="mobile-back secondary" onClick={() => { setMobileContent(false); setStageOpen(false); }}><Icon name="chevron-left" />{t(showStage ? "mobile.minimizeVoice" : "mobile.back")}</button>}
        {(!mobile || mobileContent || !view && !homeOpen) && <>
        {homeOpen ? (
          <HomeMain state={state} store={store} />
        ) : !active ? (
          <NoServers directoryUrl={state.directoryUrl} account={state.directoryAccount ?? null} onDiscover={() => setShowBrowser(true)} onAdd={() => { void addServer(); }} onLogout={() => { void signOut(store, () => { void client.leave(); }); }} />
        ) : !view ? (
          <ServerStatus s={active} store={store} state={state} rail={railServers} onRetry={(invite) => store.retryServer(active.host, invite)} onClose={() => { if (active.refused) store.removeRefused(active.host); else store.closeServer(active.host); }}
            onOpen={(key) => { setMobileContent(false); setVoicePreview(null); store.openServer(key === state.homeHost ? homeDirHost : key); }}
            join={homeless && !active.me ? state.joinInvites[active.host] ?? "" : null} />
        ) : showStage && voiceChannel ? (
          stage(false)
        ) : stageAway && voiceChannel ? (
          <section className="stage-empty stage-away">
            <div className="stage-away-box">
              <Icon name="external-link" />
              <strong>{voiceChannel.name}</strong>
              <p className="muted">{t("stage.awayText")}</p>
              <div className="row">
                <button onClick={stageWindow.close}><Icon name="undo-2" /> {t("stage.awayRestore")}</button>
                <button className="secondary" onClick={stageWindow.focus}>{t("stage.awayShow")}</button>
              </div>
            </div>
          </section>
        ) : current ? (
          <ChatView
            channel={current} messages={view.active.messages[current.id] ?? { list: [], hasMore: true, loaded: false, loading: false }}
            members={view.server.members} myUserId={view.active.userId!} myPermissions={permsIn(view.server, current.id)}
            typing={view.active.typing[current.id] ?? {}} conn={view.conn}
            canReport={view.server.openReports !== undefined} serverName={view.server.settings.name} blocked={blockControlsFor(view.active.host)}
            canReactionRoles={view.server.reactions === true && hasPermission(view.server.myPermissions, Permission.MANAGE_ROLES)} roles={view.server.roles}
            passOn={mayReport("server", view.active.host) && directoryHost ? { store, host: directoryHost, serverHost: view.active.host === state.homeHost ? homeDirHost : view.active.serverDomain ?? view.active.host } : null}
          />
        ) : (
          <section className="chat empty"><p className="muted">{t("app.noTextChannel")}</p></section>
        )}
        {showDebug && <DebugPanel log={active?.log ?? []} client={client} voice={voice} />}
        <button className="debug-toggle icon" title={t("app.debug")} onClick={() => setShowDebug((v) => !v)}><Icon name="bug" /></button>
        </>}
      </main>

      {mobile && voicePreview && view && <MobileVoicePreview
        channel={view.server.channels.find((c) => c.id === voicePreview) ?? null}
        participants={view.active.voice[voicePreview] ?? []} members={view.server.members}
        connected={voiceHost === activeHost && voice.channelId === voicePreview && voice.status !== "disconnected"}
        onClose={() => setVoicePreview(null)}
        onJoin={async () => {
          const host = view.active.host, channelId = voicePreview;
          // The sheet is a native modal dialog in the top layer, where the confirm dialog could not show: it closes first
          // and comes back when the user cancels, or with the error when the join fails after the confirm.
          const name = elsewhereName(host);
          if (name) {
            setVoicePreview(null);
            if (!await confirmElsewhere(name)) { setVoicePreview(channelId); return; }
          }
          // A failed join closes the sheet (a native dialog in the top layer, above the modal) and shows the error as the
          // modal every voice error gets: the client's own text through the effect above, else the bare one.
          try { await joinVoice(host, channelId); } catch (err) { setVoicePreview(null); reportJoinError(err); return; }
          setStageOpen(true); setMobileContent(true); setVoicePreview(null);
        }} />}
      {voteKick && votePerson && voteKick.canVote && voteAsked !== voteKick.vote.id && <VoteKickModal state={voteKick} person={votePerson} onVote={castVote} onClose={() => setVoteAsked(voteKick.vote.id)} />}
      {!homeOpen && view && <MemberList api={view.conn.api} members={view.server.members} roles={view.server.roles} myUserId={view.active.userId!} myPermissions={view.server.myPermissions} channelPermissions={view.server.myChannelPermissions} ownerId={view.server.settings.ownerId} canReport={view.server.openReports !== undefined} serverName={view.server.settings.name}
        voice={view.active.voice} channels={view.server.channels} friends={state.serverAccounts[view.active.host] ? null : friendsMenu} blocked={blockControlsFor(view.active.host)} onClose={mobile ? () => setMobileMembers(false) : null}
        onReportAccount={reportAccount(view.active.host)}
        voteKickAllowed={view.active.voteKickAllowed} onVoteKick={(userId, channelId) => startVoteKick(view.active.host, channelId, userId)}
        voteKickBox={voiceHost === activeHost ? <VoteKickPanel state={voteKick} result={voteKickResult} person={votePerson} onVote={castVote} /> : null} />}

      {directoryReport && directoryHost && <ReportDialog target={directoryReport} directory={{ store, host: directoryHost }} onClose={() => setDirectoryReport(null)} />}
      {!noticesLater && state.directoryUrl && state.directoryAccount && state.notices.some((n) => n.readAt === null) && (
        <NoticesDialog notices={state.notices} handle={state.directoryAccount.handle} directoryUrl={state.directoryUrl} onRead={(id) => store.readNotice(id)} onClose={() => setNoticesLater(true)} />
      )}
      {showAdmin && view && <AdminPanel api={view.conn.api} server={view.server} myUserId={view.active.userId!} directoryUrl={view.active.directoryUrl} onClose={() => setShowAdmin(false)} onEditChannel={setChannelEdit} />}
      {channelEdit && view && <ChannelDialog api={view.conn.api} server={view.server} target={channelEdit} myUserId={view.active.userId!} onClose={() => setChannelEdit(null)} />}
      {screenPick && inPickWindow(<ScreenPicker offer={screenPick.offer} h265={VoiceClient.supportsH265()} audioPossible={platform.os === "windows"} win={pickWindow ?? window}
        onPick={(pick) => { screenPick.resolve(pick); setScreenPick(null); }} onCancel={() => { screenPick.resolve(null); setScreenPick(null); }} />)}
      {cameraPick && inPickWindow(<CameraPicker cameras={cameraPick} initial={voiceSettings.cameraDeviceId} initialBlur={voiceSettings.cameraBlur} win={pickWindow ?? window} onPick={(id, b) => { void pickCamera(id, b); }} onCancel={() => setCameraPick(null)} />)}
      {miniProfile && active?.me && (
        <MiniProfile anchor={miniProfile} displayName={me?.displayName ?? active.me.displayName ?? "…"} avatarUrl={myAvatarUrl} storedName={active.me.displayName} handle={handleLabel(active.me)}
          serverName={server?.settings.name ?? active.serverName} withDirectory={!!state.directoryAccount && !!active.serverDomain}
          onSave={(n) => store.setServerDisplayName(n)} onOpenSettings={() => setSettingsTab("profile")} onClose={() => setMiniProfile(null)} />
      )}
      {settingsTab && (homeless || (active?.me && conn)) && (
        <SettingsDialog api={active?.me && conn ? conn.api : null} me={active?.me ?? null} publicKey={state.identity?.publicKey ?? null} displayName={me?.displayName ?? active?.me?.displayName ?? state.directoryAccount?.displayName ?? "…"} avatarUrl={myAvatarUrl} directoryUrl={state.directoryUrl} directoryAccount={state.directoryAccount}
          serverDomain={active?.serverDomain ?? null} clientVersion={platform.app?.version ?? home?.serverVersion ?? null} syncError={state.settingsSyncError} sealed={state.settingsSealed} client={client} voice={voice} games={games} hotkeyStatus={hotkeyStatus} initialTab={settingsTab}
          blocked={{ list: blockedList, inAccount: blockedInAccount, onUnblock: (pk) => store.setBlocked(activeHost, pk, false, { directory: true }) }}
          onSaveServerName={(n) => store.setServerDisplayName(n)} onSaveGlobalName={(n) => store.setDirectoryName(null, n)} onSetAvatar={(active?.me?.localHandle && !active.me.handle) || (state.directoryAccount && state.directoryAvatars) ? (image) => store.setAvatar(image) : null} onSetLocale={(pref) => store.setLocale(pref)} localePending={state.localeReloadPending}
          onCapturingKey={setCapturingPttKey} onClose={() => setSettingsTab(null)}
          onLogout={() => { void signOut(store, () => { setSettingsTab(null); void client.leave(); }); }}
          accountDevices={deviceList}
          onDirectorySignIn={homeless && !state.directoryAccount && state.directoryUrl ? () => { setSettingsTab(null); store.openAccountLogin(); } : null}
          serverAccount={active?.me?.localHandle && !active.me.handle ? {
            serverName: server?.settings.name ?? active.serverName ?? active.host,
            onChangePassword: (oldPw, newPw) => store.changeLocalPassword(oldPw, newPw),
            onDelete: async (pw) => { if (voiceHost === active.host) await client.leave(); setSettingsTab(null); await store.deleteLocalAccount(pw); },
          } : null} />
      )}
    </div>
    </GameLibraryContext.Provider>
  );
}

/** The directory's host for a sentence ("refused by the operator of ..."). */
/**
 * Sign out (store.ts `logout`): the keys leave this installation, so nobody gets back in with one click. An account without
 * a password exists on its devices only and would be lost: the user is asked first. `before` = what ends with the sign-out
 * (the voice connection, an open dialog), run once the user said yes.
 */
async function signOut(store: Store, before?: () => void): Promise<void> {
  if (store.logoutLosesAccount()) {
    const ok = await askConfirm({ title: t("profile.signOutLosesTitle"), text: t("profile.signOutLosesText", { handle: store.state.directoryAccount?.handle ?? "" }), confirmLabel: t("profile.signOut"), danger: true });
    if (!ok) return;
  }
  before?.();
  await store.logout();
}

const directoryName = (url: string | null): string => { try { return url ? new URL(url).host : "?"; } catch { return url ?? "?"; } };

/** Main area for a foreign server that has no state (yet): connecting, error, removed. */
/**
 * `join` (client without a home server, not signed in there): the invite code that came with the address, "" = none. The view
 * then waits for a click before signing in, because that reveals the public key and creates an account on that server.
 */
function ServerStatus({ s, store, state, rail, onRetry, onClose, onOpen, join }: { s: ServerConnState; store: Store; state: State; rail: readonly RailServer[]; onRetry: (invite?: string) => void; onClose: () => void; onOpen: (key: string) => void; join: string | null }) {
  const busy = s.connection === "logging-in" || s.connection === "connecting" || s.connection === "reconnecting";
  // Without an answer from /api/health the directory's list may still know the name (docs/features/offline.md).
  const name = s.serverName ?? (state.accountServers ?? []).find((a) => store.hostFor(a.host) === s.host)?.name ?? s.host;
  const [invite, setInvite] = useState(join ?? "");
  useEffect(() => setInvite(join ?? ""), [s.host, join]);
  const firstContact = join !== null && !s.error && !s.removed;
  const claim = s.me?.registrationRequired === true;
  // Which account to join with (docs/features/local-accounts.md): the directory account in one click where the server knows
  // that directory, a server account of its own (sign in or create) where the server allows them. Never a bare key.
  // A server this device has been on that does not answer (docs/features/offline.md): the notice and "Erneut versuchen"
  // only; the join view with its invite field and account forms would offer an account on a server nobody can reach.
  const offline = s.waiting === "unreachable";
  const accountForms = !busy && !claim && !s.removed && !offline && (join !== null || s.accountNeeded);
  const directoryHere = !!s.directoryUrl && s.directoryUrl === state.directoryUrl;
  const handle = directoryHere ? state.directoryAccount?.handle ?? null : null;
  const localAccounts = s.localAccounts || (!s.directoryUrl && s.serverVersion !== null) || s.ownerSetup;
  const code = () => invite.trim() || undefined;
  const conn = store.connection(s.host);
  // Refused by the directory's operator (docs/features/reports.md): a page of its own. No retry, no "open directly", no
  // account forms: the client does not connect to it, however it was opened.
  if (s.refused) {
    return (
      <section className="chat empty server-status server-refused">
        <div className="stack">
          <h2><Icon name="ban" /> {t("refused.title")}</h2>
          <p><strong>{name}</strong>{name !== s.host && <> <span className="muted small">{s.host}</span></>}</p>
          <p>{t("refused.text", { directory: directoryName(state.directoryUrl) })}</p>
          <p className="muted small">{t("refused.contact")}</p>
          {(state.accountServers ?? []).some((a) => a.refused && store.hostFor(a.host) === s.host) && <p className="muted small">{t("refused.removeHint")}</p>}
          <div className="row"><button className="secondary" onClick={onClose}>{t("refused.remove")}</button></div>
        </div>
      </section>
    );
  }
  // The centred notice with the countdown and the other servers (ServerUnreachable.tsx) instead of the status page; the
  // first contact ("Verbinde mit …", the stored session or the health request, a sign-in under way) is centred the same way.
  if (offline || (busy && !claim)) return <ServerUnreachable s={s} name={name} checking={!offline} others={reachableServers(state.servers, s.host, (key) => rail.find((r) => r.key === key)?.iconUrl ?? null)} onRetry={() => onRetry()} onOpen={onOpen} />;
  return (
    <section className="chat empty server-status">
      <div className="stack">
        <h2>{name}</h2>
        {busy && <p className="muted">{t("status.connecting", { host: s.host })}</p>}
        {s.removed && <p className="error">{s.removed.reason === "banned" ? t("status.banned") : t("status.removed")}{s.removed.message ? `: ${s.removed.message}` : "."}</p>}
        {/* A server this device has been on that does not answer: the plain notice, the connection tries again by itself (docs/features/offline.md). */}
        {s.waiting === "unreachable" && <p className="error">{t("status.offline", { name })}</p>}
        {!claim && s.error && s.waiting !== "unreachable" && <p className="error">{s.error}</p>}
        {claim && <ClaimAccount serverName={name} directoryUrl={directoryHere ? s.directoryUrl : null} localAccounts={localAccounts} emailRequired={state.directoryEmailRequired} error={s.error}
          onClaimLocal={(h, pw) => store.claimLocal(s.host, h, pw)} onClaimDirectory={(h, email, c) => store.claimDirectory(s.host, h, email, c)}
          onLogout={onClose} checkFree={conn ? (h) => conn.api.localHandleFree(h) : null} privacyPolicyUrl={s.privacyPolicyUrl} />}
        {accountForms && firstContact && <p className="muted">{t(handle ? "join.hintAccount" : "join.hintNoAccount", { host: s.host })}</p>}
        {accountForms && s.accountNeeded && <p className="muted">{t("login.accountNeeded")}</p>}
        {!busy && !offline && (join !== null || s.accountNeeded) && !claim && (
          <label className="stack">
            <span>{t("join.invite")}</span>
            <input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder={t("login.invitePlaceholder")} maxLength={32}
              onKeyDown={(e) => { if (e.key === "Enter" && handle) onRetry(code()); }} />
          </label>
        )}
        {accountForms && handle && <button className="login-primary" onClick={() => onRetry(code())}>{t("join.asHandle", { handle })}</button>}
        {accountForms && <>
          {localAccounts && <SignInForm idPrefix={`join-${s.host}`} hasDirectory={false} localAccounts={localAccounts} busy={busy}
            onDirectory={async () => {}} onLocal={(h, pw, replaceDevice) => store.loginLocal(s.host, h, pw, code(), replaceDevice)} onEmailCode={null} />}
          <CreateAccount directoryUrl={s.directoryUrl} localAccounts={localAccounts} busy={busy}
            openExternal={platform.home ? null : (url) => platform.links.openExternal(url)}
            local={<LocalRegisterForm idPrefix={`join-${s.host}`} busy={busy} ownerSetup={s.ownerSetup} privacyPolicyUrl={s.privacyPolicyUrl} checkFree={conn ? (h) => conn.api.localHandleFree(h) : null} onRegister={(h, pw, ownerCode) => store.registerLocal(s.host, h, pw, code(), ownerCode)} />} />
        </>}
        {!busy && (
          <div className="row">
            {!accountForms && !claim && <button onClick={() => onRetry(join !== null ? code() : undefined)}>{t("common.retry")}</button>}
            {platform.home
              ? <a className="link-btn" href={directoryServerUrl(s.host)}>{t("status.openDirect")}</a>
              : <button className="secondary" onClick={() => platform.links.openExternal(directoryServerUrl(s.host))}>{t("status.openInBrowser")}</button>}
            <button className="secondary" onClick={onClose}>{t("common.close")}</button>
          </div>
        )}
      </div>
    </section>
  );
}
