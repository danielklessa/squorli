import { PROTOCOL_VERSION, ServerEvent, VOTEKICK_RESULT_MS, type ClientEvent, type GamePresence, type Me, type Message, type ServerState, type VoiceMember, type VerifyResponse, type VoiceStatus, type VoteKickResult } from "@squorli/protocol";
import { ServerApi, explainLoginError, type Health } from "./api";
import type { VoteKickState } from "./voteKick";
import type { Identity } from "./identity";
import { t } from "./i18n";
import { freshPlan, nextTry, planAfterUser, sessionRejected, type RetryPlan } from "./serverRetry";
import { showNotice } from "./dialogs";
import { mentionsUser } from "./mentions";
import { catchUp, loadReadState, markRead, pruneReadState, saveReadState, type ReadState } from "./readState";

/**
 * Connection to exactly one chat server (multi-server client): session, WebSocket with reconnect, server state,
 * message cache, voice channel presence, typing indicator. The store holds one connection per server (own server = the one
 * that serves the client; foreign servers from the server rail via their origin) and displays the active one.
 */
export type Connection = "idle" | "logging-in" | "connecting" | "connected" | "reconnecting" | "error";

export type ChannelMessages = { list: Message[]; hasMore: boolean; loaded: boolean; loading: boolean };

export type RawLogEntry = { dir: "in" | "out"; at: number; text: string };

export type ServerConnState = {
  /** Key in the store: own server = the host in the address bar, foreign ones = the host from the directory (PUBLIC_DOMAIN). */
  host: string;
  /** Origin of the server for REST/WS; "" = own server (relative paths). */
  base: string;
  me: Me | null;
  userId: string | null;
  connection: Connection;
  error: string | null;
  /** The server removed us; sign in again only after a user action. */
  removed: { reason: "kicked" | "banned"; message: string | null } | null;
  /**
   * This device has a session here, but the server has not answered yet (docs/features/offline.md): "checking" = the
   * stored session is being tried, "unreachable" = the server did not answer and the next try is scheduled. App.tsx
   * shows a notice instead of the login as long as this is set; null = nothing pending.
   */
  waiting: "checking" | "unreachable" | null;
  /** When the next automatic try is due (`retryLater`), for the countdown on screen; null = none scheduled (a try runs, nothing pending, or `retryPaused`). */
  retryAt: number | null;
  /** The automatic tries are used up (ten, or five after the user's press; serverRetry.ts): nothing happens until the user presses "Erneut versuchen". */
  retryPaused: boolean;
  server: ServerState | null;
  voice: Record<string, VoiceMember[]>;
  /**
   * Vote kick (docs/features/votekick.md): per voice channel whether the server would take a vote right now (enough
   * members, nobody present who may throw somebody out, none running); no entry = no, and a server from before it never
   * says yes. `voteKick` = the vote running in the channel one sits in, `voteKickResult` = how the last one ended, shown
   * for VOTEKICK_RESULT_MS and then dropped by the timer below.
   */
  voteKickAllowed: Record<string, boolean>;
  voteKick: VoteKickState | null;
  voteKickResult: VoteKickResult | null;
  /** Web radio: what a voice channel's station is playing right now (server event `radio.meta`); no entry = unknown. */
  radioTitles: Record<string, string>;
  /** The server's clock minus ours in ms (from the welcome's `serverTime`): videos played in step are timed by the server's clock. */
  clockOffset: number;
  messages: Record<string, ChannelMessages>;
  /** channelId -> userId -> timestamp of the last typing event */
  typing: Record<string, Record<string, number>>;
  currentChannelId: string | null;
  /** Channel with unread messages (since it was last viewed; also from before this session, see readState.ts). */
  unread: Record<string, boolean>;
  /** Messages that mention me per channel, since it was last viewed (like `unread`, also from before this session). */
  mentions: Record<string, number>;
  /** Channels I have muted and whether I have muted this whole server: no unread marks for them (mentions still show). Kept by the server. */
  muted: Record<string, boolean>;
  serverMuted: boolean;
  /** The server keeps read states and mutes (false = older server: marks per device, no muting). */
  readSync: boolean;
  log: RawLogEntry[];
  /** Server name and icon from /api/health (the icon already resolved against the server), for title/favicon/rail even before sign-in. */
  serverName: string | null;
  iconUrl: string | null;
  /** This server's PUBLIC_DOMAIN (from /api/health): its key in the directory and the domain of the login signature for foreign servers. */
  serverDomain: string | null;
  /** Sign-in only with a directory account (from /api/health; servers since the server accounts always say true). */
  requireAccount: boolean;
  /** Server accounts (`~name`) may be registered here (from /api/health). */
  localAccounts: boolean;
  /** The last sign-in said this key has no account here (403 registration_required): the login shows the account forms. */
  accountNeeded: boolean;
  /** New members need an invite code (from /api/health; false for servers that do not say). */
  inviteRequired: boolean;
  /** The server waits for its owner, who registers a server account with the setup code (from /api/health). */
  ownerSetup: boolean;
  serverVersion: string | null;
  /** Directory service named by this server; null = none. */
  directoryUrl: string | null;
};

export type ConnectionHooks = {
  onState: (s: ServerConnState) => void;
  /** Remember the session token (null = forget it). */
  onToken: (token: string | null) => void;
  /** Session gone (remote sign-out, expired, membership lost): the store decides what that means for the client. */
  onSessionLost: (message: string) => void;
  /** Kick/ban: end the voice connection if it belongs to this server. */
  onRemoved: () => void;
  /** First welcome of a session (not after a reconnect): e.g. refresh the server list at the directory. */
  onConnected: () => void;
  /** Moderation (M3): moving to another voice channel (null = out) and stopping camera/screen. `votekick` = voted out of the channel (docs/features/votekick.md). */
  /** `until`: with reason "blocked", when the block ends (null = permanent). */
  onVoiceMoved: (channelId: string | null, by: string, reason: "afk" | "elsewhere" | "votekick" | "blocked" | null, until?: string | null) => void;
  /** The voice channel this connection sits in vanished from the channel list (the access is gone): the client hangs up. */
  onVoiceGone: () => void;
  onVoiceStop: (what: { camera: boolean; screen: boolean }, by: string) => void;
  /** A live message of someone else mentions me (also in the channel that is open: the store knows whether the user looks at it). */
  onMention: (message: Message) => void;
  /** Blocked people (docs/features/reports.md, stage 3): by public key; their messages neither mark unread nor count as mentions here. */
  isBlocked: (publicKey: string) => boolean;
};

const LOG_MAX = 80;
/** After connecting, at most this many text channels are checked for messages that arrived while we were away. */
const CATCH_UP_CHANNELS = 50;
const READ_SYNC_MIN_MS = 15_000;
const READ_ACK_DELAY_MS = 800;
/** Edits and deletions in marked channels are counted again after this pause (one request for a burst). */
const RECOUNT_DELAY_MS = 500;
const EMPTY: ChannelMessages = { list: [], hasMore: true, loaded: false, loading: false };
/**
 * Attachment links are signed and valid for at least 7 days (server: attachmentLinks.ts). A history loaded longer ago than
 * this is loaded again, so its pictures never break: an open channel at once, the others when they are opened next.
 */
const HISTORY_MAX_AGE_MS = 3 * 86_400_000;

export class ServerConnection {
  readonly api: ServerApi;
  state: ServerConnState;
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  /** A try to reach a server that did not answer (`retryLater`): the scheduled step, its timer and the delay of the last one. */
  private retry: (() => void) | null = null;
  private retryTimer: number | null = null;
  /** The plan of automatic tries for the current silent spell (serverRetry.ts): phase, failed so far, how many are left. */
  private retryPlan: RetryPlan = freshPlan();
  private wantConnection = false;
  private pingTimer: number | null = null;
  /** When each channel's history was loaded from scratch (HISTORY_MAX_AGE_MS), and when that was last checked. */
  private historyLoadedAt = new Map<string, number>();
  private historyCheckedAt = 0;
  /** Watchdog for a connection that died without a close (sleep, network change): when the last ping went out and when anything last arrived. */
  private pingSentAt = 0;
  private lastHeard = 0;
  /**
   * The voice channel this client told the server it sits in. The server keeps that per WebSocket, and voice (LiveKit) is a
   * connection of its own that survives a reconnect here: after one, the place is announced again. Without it the member
   * vanished from the channel's list and the AFK move never found them (user's report, 18 September 2026).
   */
  private voiceChannelId: string | null = null;
  /** The mute state last reported (voice.join, voice.status), said again with the join after a reconnect. */
  private voiceStatus: VoiceStatus = { micMuted: false, deafened: false, cameraOn: false, screenOn: false };
  /** Newest message shown per channel (readState.ts), loaded for the signed-in user at every welcome. */
  private read: ReadState = {};
  /** The server keeps read states (GET /api/read-state answered): marks come from there and hold on every device. */
  private serverRead = false;
  /** What the server has acknowledged as read per channel, and pending acknowledgements (coalesced). */
  private acked: ReadState = {};
  private ackTimers = new Map<string, number>();
  /** Newest live message of other people per channel that is not on screen: an older answer of the server must not clear its mark. */
  private liveLatest: ReadState = {};
  private lastReadSync = 0;
  private recountTimer: number | null = null;
  /** Vote kick: when I was last voted out of a channel, so the `voice.moved` right after it is explained as one. */
  private voteKickedAt = 0;
  /** The result box goes by itself after VOTEKICK_RESULT_MS (user's wish). */
  private resultTimer: number | null = null;
  /** AFK detection: what the user's activity tracker says (activity.ts); reported to servers that know the `activity` event. */
  private idle = false;
  private game: GamePresence | null = null;

  constructor(host: string, base: string, private readonly identity: () => Identity | null, private readonly hooks: ConnectionHooks) {
    this.api = new ServerApi(base);
    this.state = {
      host, base, me: null, userId: null, connection: "idle", error: null, removed: null, waiting: null, retryAt: null, retryPaused: false, server: null,
      voice: {}, voteKickAllowed: {}, voteKick: null, voteKickResult: null, radioTitles: {}, clockOffset: 0, messages: {}, typing: {}, currentChannelId: null, unread: {}, mentions: {}, muted: {}, serverMuted: false, readSync: false, log: [],
      serverName: null, iconUrl: null, serverDomain: null, requireAccount: false, localAccounts: false, accountNeeded: false, inviteRequired: false, ownerSetup: false, serverVersion: null, directoryUrl: null,
    };
    // Token rejected by the server (expired, signed out from another device): do not keep running with a dead token.
    // Back in front of this tab: another device may have read channels meanwhile (normally `read.update` says so right away).
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.serverRead && this.state.connection === "connected" && Date.now() - this.lastReadSync > READ_SYNC_MIN_MS) void this.syncReadState();
      // A server that did not answer: the wait is over as soon as the user looks again.
      if (document.visibilityState === "visible") this.retryNow();
    });
    window.addEventListener("online", () => this.retryNow());
    this.api.onUnauthorized = () => { if (this.state.me) this.sessionLost("Die Sitzung ist abgelaufen oder wurde abgemeldet. Bitte erneut anmelden."); };
  }

  private set(p: Partial<ServerConnState>) { this.state = { ...this.state, ...p }; this.hooks.onState(this.state); }

  /** Read /api/health: name, icon, domain, directory. null if the server is unreachable. */
  async refreshHealth(): Promise<Health | null> {
    const health = await this.api.getHealth().catch(() => null);
    this.set({
      serverName: health?.serverName ?? null, iconUrl: health?.iconUrl ? this.api.abs(health.iconUrl) : null, serverDomain: health?.domain?.toLowerCase() ?? null,
      directoryUrl: health?.directoryUrl ?? null, requireAccount: !!health?.directoryUrl && health?.requireAccount === true, localAccounts: health?.localAccounts === true, inviteRequired: health?.inviteRequired === true, ownerSetup: health?.ownerSetup === true, serverVersion: health?.version ?? null,
    });
    return health;
  }

  /**
   * Reuse the stored session. "rejected" = the server refused it (dropped; the login follows). "unreachable" = the server
   * did not answer (docs/features/offline.md): the session stays, `waiting` says so and the next try is scheduled here,
   * so that a server that is down for a while shows a notice instead of the login and comes back by itself.
   */
  async resume(token: string): Promise<"ok" | "rejected" | "unreachable"> {
    this.api.setToken(token);
    // A retry after "unreachable" keeps that notice (and its buttons) on screen while the attempt runs.
    if (this.state.waiting !== "unreachable") this.set({ connection: "connecting", error: null, waiting: "checking" });
    try {
      const me = await this.api.getMe();
      this.retrySettled();
      this.enter(me);
      return "ok";
    } catch (err) {
      if (sessionRejected(err)) { this.retrySettled(); this.api.setToken(null); this.set({ connection: "idle", waiting: null }); return "rejected"; }
      this.set({ connection: "error", error: t("err.serverUnreachable"), waiting: "unreachable" });
      this.retryLater(() => void this.resume(token));
      return "unreachable";
    }
  }

  /**
   * The server did not answer: run `step` again after a while (15 s, then 30 s for the 2nd to 5th try, then a minute each;
   * ten tries in all, after the user's press five a minute apart, serverRetry.ts), or at once when the device comes back
   * online, the tab is shown again or the user asks (`retryNow`). With the plan used up nothing is scheduled: the step is
   * kept and `retryPaused` says so until `retryByUser()`. `close()` and `cancelRetry()` drop it; a step that fails again
   * schedules the next one itself by calling this again.
   */
  retryLater(step: () => void) {
    this.cancelRetry();
    const next = nextTry(this.retryPlan);
    this.retryPlan = next.plan;
    this.retry = step;
    if (next.delay === null) { this.set({ retryPaused: true }); return; }
    this.retryTimer = window.setTimeout(() => this.retryNow(), next.delay);
    this.set({ retryAt: Date.now() + next.delay });
  }
  /** Run the scheduled try now (nothing scheduled, or the automatic tries used up = nothing happens). */
  retryNow() {
    if (this.state.retryPaused) return;
    const step = this.retry;
    this.cancelRetry();
    step?.();
  }
  /** The user pressed "Erneut versuchen": the plan becomes five tries a minute apart (used up or not), and the try runs now. */
  retryByUser() {
    this.noteUserRetry();
    const step = this.retry;
    this.cancelRetry();
    step?.();
  }
  /** The user asked for a try that the store runs itself (a foreign server): only the plan changes. */
  noteUserRetry() {
    this.retryPlan = planAfterUser();
    if (this.state.retryPaused) this.set({ retryPaused: false });
  }
  /** Forget the scheduled try (the delay keeps growing until the server answered). */
  cancelRetry() {
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.retry = null;
    if (this.state.retryAt !== null) this.set({ retryAt: null });
  }
  /** The server answered: no try pending, the next failure starts the plan over. */
  retrySettled() {
    this.cancelRetry();
    this.retryPlan = freshPlan();
    if (this.state.retryPaused) this.set({ retryPaused: false });
  }

  /** Signed in: connect, unless the member must register first (a member from before server accounts, docs/features/local-accounts.md). */
  private enter(me: Me) {
    // A resumed session keeps `waiting` until the welcome, so the notice stands until the client can be shown (never the login in between).
    this.set({ me, userId: me.userId, accountNeeded: false, waiting: me.registrationRequired ? null : this.state.waiting });
    if (me.registrationRequired) { this.set({ connection: "idle", error: null }); return; }
    this.connect();
  }

  /** Take a session the store got elsewhere (the registration of a server account answers like a sign-in). */
  async adopt(session: VerifyResponse): Promise<void> {
    this.api.setToken(session.sessionToken);
    this.hooks.onToken(session.sessionToken);
    this.enter(await this.api.getMe());
  }

  /** After registering an account for this session: read /api/me again and connect. */
  async refreshMe(): Promise<void> {
    this.enter(await this.api.getMe());
  }

  /** Sign in (challenge-response) with a signature over `domain`, optionally with an invite, then connect the WebSocket. */
  async login(domain: string, invite?: string): Promise<void> {
    const id = this.identity();
    if (!id) return;
    this.set({ connection: "logging-in", error: null, removed: null });
    try {
      await this.adopt(await this.api.login(id, domain, invite));
    } catch (err) {
      const code = err instanceof Error && "code" in err ? (err as { code: string | null }).code : null;
      // No account for this key: not an error the user did, but the next step (the account forms).
      if (code === "registration_required") this.set({ connection: "idle", error: null, accountNeeded: true, waiting: null });
      else this.set({ connection: "error", error: await explainLoginError(err, this.api, domain), waiting: null });
      throw Object.assign(new Error("login failed"), { code });
    }
  }

  /** Sign out: end the session on the server side too (M6c, best effort) and close the connection. */
  logout() {
    if (this.api.getToken()) void this.api.logoutSession().catch(() => {});
    this.clearSession(null);
  }

  private sessionLost(message: string) {
    this.hooks.onRemoved();
    this.clearSession(message);
    this.hooks.onSessionLost(message);
  }

  /** The account on this server was deleted at the user's request (via the directory): drop the session, show the login with a note. */
  accountDeleted() {
    if (this.state.me || this.api.getToken()) this.sessionLost(t("err.accountDeleted"));
  }

  private clearSession(error: string | null) {
    this.close();
    this.api.setToken(null);
    this.hooks.onToken(null);
    for (const timer of this.ackTimers.values()) clearTimeout(timer);
    this.ackTimers.clear(); this.acked = {}; this.liveLatest = {}; this.serverRead = false;
    if (this.recountTimer !== null) { clearTimeout(this.recountTimer); this.recountTimer = null; }
    this.voiceChannelId = null;
    this.set({ me: null, userId: null, accountNeeded: false, connection: "idle", waiting: null, server: null, messages: {}, voice: {}, currentChannelId: null, unread: {}, mentions: {}, muted: {}, serverMuted: false, readSync: false, removed: null, error });
  }

  /** Close the connection without forgetting the session (e.g. on an identity switch). */
  close() {
    this.wantConnection = false;
    this.retrySettled();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.ws?.close();
    this.ws = null;
  }

  // ---------- WebSocket
  private connect() {
    this.wantConnection = true;
    const token = this.api.getToken();
    if (!token) return;
    this.set({ connection: this.state.server ? "reconnecting" : "connecting" });
    const base = this.state.base || window.location.origin;
    // Never two sockets of one client: an earlier one that stayed open would keep its own presence on the server.
    this.dropSocket();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/ws`);
    this.ws = ws;
    ws.onopen = () => this.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionToken: token });
    ws.onmessage = (m) => {
      this.lastHeard = Date.now();
      this.pushLog({ dir: "in", at: Date.now(), text: String(m.data).slice(0, 2000) });
      const parsed = ServerEvent.safeParse(JSON.parse(m.data));
      if (parsed.success) this.handle(parsed.data);
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      // 4011 = session signed out from another device (M6c), 4012 = account deleted via the directory: do not reconnect, go back to the login.
      if (ev.code === 4011 && this.wantConnection) return this.sessionLost(t("err.sessionRevoked"));
      if (ev.code === 4012 && this.wantConnection) return this.sessionLost(t("err.accountDeleted"));
      // 4013 = the member has no account yet (docs/features/local-accounts.md): no reconnect, the account forms instead.
      if (ev.code === 4013 && this.wantConnection) { this.close(); void this.refreshMe().catch(() => {}); return; }
      if (!this.wantConnection) return;
      this.set({ connection: "reconnecting" });
      this.reconnectTimer = window.setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(15_000, this.reconnectDelay * 2);
    };
  }

  /** Let go of the current socket without waiting for its close (a dead connection may take minutes to notice). */
  private dropSocket() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = null;
    try { ws.close(); } catch { /* already closing */ }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  /** Every 20 s: nothing arrived since the last ping (the server answers each with `pong`) = the connection is dead; connect again. */
  /** At most once an hour (from the heartbeat): histories older than HISTORY_MAX_AGE_MS are loaded again or forgotten. */
  private refreshOldHistories() {
    const now = Date.now();
    if (now - this.historyCheckedAt < 3_600_000) return;
    this.historyCheckedAt = now;
    const old = [...this.historyLoadedAt].filter(([, at]) => now - at > HISTORY_MAX_AGE_MS).map(([id]) => id);
    if (!old.length) return;
    const messages = { ...this.state.messages };
    for (const id of old) { delete messages[id]; this.historyLoadedAt.delete(id); }
    this.set({ messages });
    const current = this.state.currentChannelId;
    if (current && old.includes(current)) void this.loadHistory(current);
  }

  private heartbeat() {
    this.refreshOldHistories();
    const now = Date.now();
    // A timer that fired late (throttled or frozen page) proves nothing: answers may still be waiting behind it.
    if (this.pingSentAt && this.lastHeard < this.pingSentAt && now - this.pingSentAt < 60_000) {
      this.pingSentAt = 0;
      this.dropSocket();
      if (this.wantConnection) this.connect();
      return;
    }
    this.pingSentAt = now;
    this.send({ type: "ping", t: now });
  }

  /** The user turned idle or came back (store.ts). A server counts a fresh connection as active, so only `true` needs repeating after a welcome. */
  setIdle(idle: boolean) {
    if (idle === this.idle) return;
    this.idle = idle;
    this.reportIdle();
  }
  /** Game display: what the user plays, as it may be shown on this server (store.ts; null = nothing or kept to friends). A fresh connection knows none. */
  setGame(game: GamePresence | null) {
    if (game?.id === this.game?.id && game?.name === this.game?.name) return;
    this.game = game;
    this.reportIdle();
  }
  private reportIdle() {
    // Servers from before the AFK detection do not send the setting and would answer the event with `bad_message`; one from
    // before the game display drops `game` unread.
    if (this.state.server?.settings.afkChannelId !== undefined) this.send({ type: "activity", idle: this.idle, game: this.game });
  }

  send(e: ClientEvent) {
    if (e.type === "voice.join") { this.voiceChannelId = e.channelId; this.voiceStatus = { micMuted: e.micMuted ?? false, deafened: e.deafened ?? false, cameraOn: e.cameraOn ?? false, screenOn: e.screenOn ?? false }; }
    else if (e.type === "voice.leave") this.voiceChannelId = null;
    else if (e.type === "voice.status") { this.voiceStatus = { micMuted: e.micMuted, deafened: e.deafened, cameraOn: e.cameraOn, screenOn: e.screenOn }; if (this.state.server?.settings.statusApi === undefined) return; } // a server from before it would answer bad_message
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(e);
    this.pushLog({ dir: "out", at: Date.now(), text });
    this.ws.send(text);
  }

  private pushLog(e: RawLogEntry) { this.set({ log: [...this.state.log.slice(-(LOG_MAX - 1)), e] }); }

  /** My permissions in one channel or category: the server's channel-resolved mask, or on a server from before the server-wide one. */
  channelPermissions(id: string): number {
    const s = this.state.server;
    return s?.myChannelPermissions?.[id] ?? s?.myPermissions ?? 0;
  }

  /**
   * The channel list changed (docs/features/channel-permissions.md): a channel that is gone takes its traces with it,
   * above all its cached messages (a channel one lost the access to must not show an old page when it comes back), and
   * a channel that appeared gets its read state. The voice channel one sits in going away is told to App.tsx.
   */
  private channelsChanged(before: { id: string }[], after: { id: string; name: string }[]) {
    const now = new Set(after.map((c) => c.id));
    const gone = before.filter((c) => !now.has(c.id)).map((c) => c.id);
    if (gone.length) {
      const drop = <T>(rec: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(rec).filter(([id]) => now.has(id)));
      this.set({ messages: drop(this.state.messages), typing: drop(this.state.typing), unread: drop(this.state.unread), mentions: drop(this.state.mentions), muted: drop(this.state.muted), radioTitles: drop(this.state.radioTitles), voice: drop(this.state.voice), voteKickAllowed: drop(this.state.voteKickAllowed) });
      this.liveLatest = drop(this.liveLatest);
      this.acked = drop(this.acked);
      if (this.state.userId) { this.read = pruneReadState(this.read, [...now]); saveReadState(this.state.host, this.state.userId, this.read); }
      if (this.voiceChannelId && gone.includes(this.voiceChannelId)) { this.voiceChannelId = null; this.hooks.onVoiceGone(); }
    }
    if (after.some((c) => !before.some((b) => b.id === c.id))) void this.syncReadState();
  }

  private handle(e: ServerEvent) {
    switch (e.type) {
      case "welcome": {
        this.reconnectDelay = 1000;
        const wasReconnect = this.state.server !== null;
        const current = this.state.currentChannelId && e.state.channels.some((c) => c.id === this.state.currentChannelId)
          ? this.state.currentChannelId
          : e.state.channels.find((c) => c.kind === "text")?.id ?? null;
        this.set({ server: e.state, userId: e.userId, connection: "connected", currentChannelId: current, error: null, waiting: null, radioTitles: {}, voteKick: null, voteKickAllowed: {}, clockOffset: Date.parse(e.serverTime) - Date.now() }); // the server sends the known titles after the welcome
        this.read = pruneReadState(loadReadState(this.state.host, e.userId), e.state.channels.map((c) => c.id));
        void this.syncReadState();
        if (this.idle || this.game) this.reportIdle();
        if (this.voiceChannelId) this.send({ type: "voice.join", channelId: this.voiceChannelId, ...this.voiceStatus });
        if (!wasReconnect) this.hooks.onConnected();
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingSentAt = 0;
        this.pingTimer = window.setInterval(() => this.heartbeat(), 20_000);
        // After a reconnect: messages could be missing, and a long pause may have outlived the attachment links: forget every
        // history, reload the current one (the others load when they are opened).
        if (wasReconnect) { this.historyLoadedAt.clear(); this.set({ messages: {} }); if (current) void this.loadHistory(current); }
        else if (current) void this.loadHistory(current);
        break;
      }
      case "structure": {
        const server = this.state.server;
        if (!server) break;
        const next: ServerState = {
          ...server,
          ...(e.settings ? { settings: e.settings } : {}),
          ...(e.categories ? { categories: e.categories } : {}),
          ...(e.channels ? { channels: e.channels } : {}),
          ...(e.roles ? { roles: e.roles } : {}),
          ...(e.radioStations ? { radioStations: e.radioStations } : {}),
          ...(e.members ? { members: e.members } : {}),
        };
        const current = this.state.currentChannelId && next.channels.some((c) => c.id === this.state.currentChannelId)
          ? this.state.currentChannelId : next.channels.find((c) => c.kind === "text")?.id ?? null;
        this.set({ server: next, currentChannelId: current });
        if (e.channels) this.channelsChanged(server.channels, e.channels);
        break;
      }
      case "me":
        if (this.state.server) this.set({ server: { ...this.state.server, myPermissions: e.myPermissions, ...(e.myChannelPermissions !== undefined ? { myChannelPermissions: e.myChannelPermissions } : {}), ...(e.myVoiceLock !== undefined ? { myVoiceLock: e.myVoiceLock } : {}) } });
        break;
      case "radio.meta": {
        const { [e.channelId]: _old, ...rest } = this.state.radioTitles;
        this.set({ radioTitles: e.title ? { ...rest, [e.channelId]: e.title } : rest });
        break;
      }
      case "radio.playback": {
        const server = this.state.server;
        if (server) this.set({ server: { ...server, channels: server.channels.map((c) => (c.id === e.channelId && c.radio?.youtubeVideo ? { ...c, radio: { ...c.radio, playback: e.playback } } : c)) } });
        break;
      }
      case "voice.state":
        this.set({ voice: { ...this.state.voice, [e.channelId]: e.members }, voteKickAllowed: { ...this.state.voteKickAllowed, [e.channelId]: e.voteKick } });
        break;
      case "votekick":
        // Only the channel one sits in ever has a vote; the server sends it to whoever is in it.
        this.set({ voteKick: e.vote ? { vote: e.vote, myVote: e.myVote, canVote: e.canVote } : null });
        break;
      case "votekick.result": {
        // My own client hangs up on the `voice.moved` that follows: it must say why, not "somebody removed you".
        if (e.result.outcome === "passed" && e.result.targetId === this.state.userId) this.voteKickedAt = Date.now();
        if (this.resultTimer) window.clearTimeout(this.resultTimer);
        this.resultTimer = window.setTimeout(() => { this.resultTimer = null; this.set({ voteKickResult: null }); }, VOTEKICK_RESULT_MS);
        this.set({ voteKickResult: e.result });
        break;
      }
      case "voice.moved":
        this.hooks.onVoiceMoved(e.channelId, e.by, e.reason ?? (e.channelId === null && Date.now() - this.voteKickedAt < 5000 ? "votekick" : null), e.until ?? null);
        break;
      case "voice.stop":
        this.hooks.onVoiceStop({ camera: e.camera, screen: e.screen }, e.by);
        break;
      case "message.create": {
        const ch = this.state.messages[e.message.channelId];
        if (ch?.loaded && !ch.list.some((m) => m.id === e.message.id)) {
          this.set({ messages: { ...this.state.messages, [e.message.channelId]: { ...ch, list: [...ch.list, e.message] } } });
        }
        const typing = { ...(this.state.typing[e.message.channelId] ?? {}) };
        delete typing[e.message.authorId];
        // A blocked person's message is folded on screen and marks nothing (stage 3 of reports).
        const blockedAuthor = this.blockedAuthors().has(e.message.authorId);
        const unread = e.message.channelId !== this.state.currentChannelId && e.message.authorId !== this.state.userId && !blockedAuthor;
        if (e.message.channelId === this.state.currentChannelId) this.rememberRead(e.message.channelId, [e.message]);
        if (unread) this.liveLatest = { ...this.liveLatest, [e.message.channelId]: e.message.seq };
        const mentionsMe = !blockedAuthor && e.message.authorId !== this.state.userId && this.state.userId !== null && mentionsUser(e.message.content, this.state.userId);
        const mentioned = unread && mentionsMe;
        if (mentionsMe) this.hooks.onMention(e.message);
        this.set({
          typing: { ...this.state.typing, [e.message.channelId]: typing },
          unread: unread ? { ...this.state.unread, [e.message.channelId]: true } : this.state.unread,
          mentions: mentioned ? { ...this.state.mentions, [e.message.channelId]: (this.state.mentions[e.message.channelId] ?? 0) + 1 } : this.state.mentions,
        });
        break;
      }
      case "message.update": {
        const ch = this.state.messages[e.message.channelId];
        if (ch) this.set({ messages: { ...this.state.messages, [e.message.channelId]: { ...ch, list: ch.list.map((m) => (m.id === e.message.id ? e.message : m)) } } });
        this.recountMarks(e.message.channelId, false);
        break;
      }
      case "message.delete": {
        const ch = this.state.messages[e.channelId];
        if (ch) this.set({ messages: { ...this.state.messages, [e.channelId]: { ...ch, list: ch.list.filter((m) => m.id !== e.id) } } });
        this.recountMarks(e.channelId, true);
        break;
      }
      // Reports (docs/features/reports.md): many messages of one channel at once (a ban with "delete messages of the last ...").
      case "message.bulkDelete": {
        const ch = this.state.messages[e.channelId];
        const gone = new Set(e.ids);
        if (ch) this.set({ messages: { ...this.state.messages, [e.channelId]: { ...ch, list: ch.list.filter((m) => !gone.has(m.id)) } } });
        this.recountMarks(e.channelId, true);
        break;
      }
      // The open reports for a moderator (a count only); the rail and Verwaltung > Meldungen show it.
      case "reports.count": {
        if (this.state.server) this.set({ server: { ...this.state.server, openReports: e.open } });
        break;
      }
      // A moderator removed something of mine after a report (decision 4 of 25 September 2026): the reason, never the reporter.
      case "moderation.notice": {
        void showNotice({ title: t("report.noticeTitle"), text: e.kind === "message_removed" ? t("report.noticeMessage", { channel: e.channelName ?? "?", server: this.state.server?.settings.name ?? this.state.host }) : t("report.noticeMessages", { n: e.count, server: this.state.server?.settings.name ?? this.state.host }) });
        break;
      }
      case "read.update": {
        // One of my devices (this one included) has read a channel.
        this.acked = { ...this.acked, [e.channelId]: Math.max(this.acked[e.channelId] ?? -1, e.lastReadSeq) };
        if (this.state.userId && (this.read[e.channelId] ?? -1) < e.lastReadSeq) { this.read = { ...this.read, [e.channelId]: e.lastReadSeq }; saveReadState(this.state.host, this.state.userId, this.read); }
        if (e.channelId === this.state.currentChannelId) break;
        const list = this.state.messages[e.channelId]?.list ?? [];
        const newest = Math.max(this.liveLatest[e.channelId] ?? -1, list[list.length - 1]?.seq ?? -1);
        if (newest <= e.lastReadSeq) this.set({ unread: { ...this.state.unread, [e.channelId]: false }, mentions: { ...this.state.mentions, [e.channelId]: 0 } });
        else void this.syncReadState();   // read only in part over there: let the server count what is left
        break;
      }
      case "mute.update":
        this.set({ serverMuted: e.serverMuted, muted: Object.fromEntries(e.channelIds.map((id) => [id, true])) });
        break;
      case "typing":
        this.set({ typing: { ...this.state.typing, [e.channelId]: { ...(this.state.typing[e.channelId] ?? {}), [e.userId]: Date.now() } } });
        break;
      case "removed":
        this.wantConnection = false;
        this.voiceChannelId = null;
        this.hooks.onRemoved();
        this.set({ removed: { reason: e.reason, message: e.message }, connection: "idle", server: null, messages: {}, voice: {} });
        break;
      case "error":
        if (e.code === "unauthorized" && e.message === "registration required") {
          // The close 4013 that follows shows the account forms; the session stays.
        } else if (e.code === "unauthorized") {
          // Token invalid or membership lost: do not stay in the chat with a dead socket.
          this.sessionLost(e.message === "not a member" ? t("err.notMember") : t("err.sessionInvalid"));
        } else if (e.code === "protocol_version") {
          this.wantConnection = false;
          this.set({ connection: "error", error: `${e.code}: ${e.message}` });
        }
        break;
      case "pong":
        break;
    }
  }

  // ---------- Channels and messages
  /** Change your display name on this server; `me` follows right away (the member list follows via the server's broadcast). */
  async updateDisplayName(displayName: string | null): Promise<void> {
    const me = await this.api.updateMe(displayName);
    this.set({ me });
  }

  /** Mute or unmute a text channel / this whole server for myself (kept by the server, so it holds on every device). */
  async setChannelMuted(channelId: string, muted: boolean): Promise<void> { this.applyMutes(await this.api.setChannelMuted(channelId, muted)); }
  async setServerMuted(muted: boolean): Promise<void> { this.applyMutes(await this.api.setServerMuted(muted)); }
  private applyMutes(m: { serverMuted: boolean; channelIds: string[] }) { this.set({ serverMuted: m.serverMuted, muted: Object.fromEntries(m.channelIds.map((id) => [id, true])) }); }

  selectChannel(channelId: string) {
    this.set({ currentChannelId: channelId, unread: { ...this.state.unread, [channelId]: false }, mentions: { ...this.state.mentions, [channelId]: 0 } });
    this.rememberRead(channelId, this.state.messages[channelId]?.list ?? []);
    if (!this.state.messages[channelId]?.loaded) void this.loadHistory(channelId);
  }

  /**
   * The channel is on screen: its newest message counts as read from now on. Told to the server (all my devices) when it
   * keeps read states, and always remembered on this device (readState.ts) for servers that do not.
   */
  private rememberRead(channelId: string, shown: readonly Message[]) {
    const userId = this.state.userId;
    if (!userId) return;
    const next = markRead(this.read, channelId, shown);
    if (next !== this.read) { this.read = next; saveReadState(this.state.host, userId, next); }
    this.acknowledge(channelId);
  }

  /**
   * A message in a marked channel that is not on screen was edited or deleted: the mention (or the only unread message)
   * may be gone, and a mark must not outlive its reason. The server counts again; without read states the cached page does.
   */
  private recountMarks(channelId: string, deleted: boolean) {
    const userId = this.state.userId;
    if (!userId || channelId === this.state.currentChannelId) return;
    if (!this.state.unread[channelId] && !this.state.mentions[channelId]) return;
    if (this.serverRead) {
      // The deleted message may have been the newest one: `liveLatest` would then keep the server's answer out for ever.
      if (deleted) this.liveLatest = Object.fromEntries(Object.entries(this.liveLatest).filter(([id]) => id !== channelId));
      this.recountTimer ??= window.setTimeout(() => { this.recountTimer = null; void this.syncReadState(); }, RECOUNT_DELAY_MS);
      return;
    }
    const ch = this.state.messages[channelId];
    if (!ch?.loaded) return;
    const result = catchUp(ch.list, this.read[channelId], userId, this.blockedAuthors());
    this.set({ unread: { ...this.state.unread, [channelId]: result.unread }, mentions: { ...this.state.mentions, [channelId]: result.mentions } });
  }

  /** The members this user has blocked, by user id, for the counters (`hooks.isBlocked` knows them by public key). */
  private blockedAuthors(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const m of this.state.server?.members ?? []) if (this.hooks.isBlocked(m.publicKey)) out.add(m.userId);
    return out;
  }
  /** The block list changed (store.ts): unread and mention marks are counted again without the blocked people's messages. */
  refreshMarks(): void {
    if (this.state.connection !== "connected" || !this.state.userId) return;
    if (this.serverRead) { void this.syncReadState(); return; }
    void this.catchUpChannels();
  }

  /** Coalesced: a busy open channel sends one acknowledgement per pause, not one per message. */
  private acknowledge(channelId: string) {
    const seq = this.read[channelId];
    if (!this.serverRead || seq === undefined || seq <= (this.acked[channelId] ?? -1) || this.ackTimers.has(channelId)) return;
    this.ackTimers.set(channelId, window.setTimeout(() => {
      this.ackTimers.delete(channelId);
      const latest = this.read[channelId];
      if (latest === undefined || !this.serverRead) return;
      this.api.markRead(channelId, latest).then(
        (r) => { this.acked = { ...this.acked, [channelId]: Math.max(this.acked[channelId] ?? -1, r.lastReadSeq) }; },
        () => { /* offline or no access: the next message or the next welcome tries again */ },
      );
    }, READ_ACK_DELAY_MS));
  }

  /**
   * After every welcome (and when the tab comes back): ask the server how far I have read each text channel, on whatever
   * device, and take its marks and mention counts. A server without read states (older version) answers 404: then this
   * device's own state decides (`catchUpChannels`).
   */
  private async syncReadState() {
    const userId = this.state.userId;
    if (!userId) return;
    let remote;
    try { remote = await this.api.getReadState(); } catch { this.serverRead = false; this.set({ readSync: false }); return this.catchUpChannels(); }
    if (this.state.userId !== userId) return;
    this.serverRead = true;
    this.lastReadSync = Date.now();
    const unread = { ...this.state.unread }, mentions = { ...this.state.mentions };
    for (const c of remote.channels) {
      this.acked = { ...this.acked, [c.channelId]: Math.max(this.acked[c.channelId] ?? -1, c.lastReadSeq ?? -1) };
      if (c.channelId === this.state.currentChannelId) continue;   // on screen = read, acknowledged below
      if ((this.liveLatest[c.channelId] ?? -1) > (c.latestSeq ?? -1)) continue;   // a live message is newer than this answer
      unread[c.channelId] = c.unread;
      mentions[c.channelId] = c.mentions;
    }
    this.set({ unread, mentions, readSync: true, serverMuted: remote.serverMuted, muted: Object.fromEntries(remote.channels.filter((c) => c.muted).map((c) => [c.channelId, true])) });
    const current = this.state.currentChannelId;
    if (current) this.rememberRead(current, this.state.messages[current]?.list ?? []);
  }

  /**
   * Fallback for servers without read states: fetch the newest page of each text channel that is not on screen and compare it with what this
   * device has read, so channels are marked (and mentions counted) for messages that arrived while we were away or before
   * a reload. The pages also fill the message cache, so opening such a channel needs no request. One channel after the
   * other, to be gentle with the server; a channel we may not read simply gets no mark.
   */
  private async catchUpChannels() {
    const userId = this.state.userId;
    const channels = (this.state.server?.channels ?? []).filter((c) => c.kind === "text").slice(0, CATCH_UP_CHANNELS);
    for (const c of channels) {
      if (c.id === this.state.currentChannelId) continue;
      try {
        const page = await this.api.getMessages(c.id);
        if (!userId || this.state.userId !== userId || this.state.connection !== "connected") return;   // signed out or another user meanwhile
        const cur = this.state.messages[c.id];
        const list = cur?.loaded ? mergeLatest(cur.list, page.messages) : page.messages;
        if (!cur?.loaded) this.historyLoadedAt.set(c.id, Date.now());
        const messages = { ...this.state.messages, [c.id]: { list, hasMore: cur?.loaded ? cur.hasMore : page.hasMore, loaded: true, loading: cur?.loading ?? false } };
        if (c.id === this.state.currentChannelId) { this.set({ messages }); this.rememberRead(c.id, list); continue; }   // opened while we were fetching
        const result = catchUp(page.messages, this.read[c.id], userId, this.blockedAuthors());
        if (this.read[c.id] === undefined) this.rememberRead(c.id, page.messages);   // first sight on this device: start from here
        this.set({
          messages,
          unread: { ...this.state.unread, [c.id]: (this.state.unread[c.id] ?? false) || result.unread },
          // Messages that came in live since the welcome are part of the page too: the larger number is the right one.
          mentions: { ...this.state.mentions, [c.id]: Math.max(this.state.mentions[c.id] ?? 0, result.mentions) },
        });
      } catch { /* not allowed or not reachable: no mark */ }
    }
  }

  async loadHistory(channelId: string, older = false) {
    const ch = this.state.messages[channelId] ?? EMPTY;
    if (ch.loading || (older && !ch.hasMore)) return;
    this.set({ messages: { ...this.state.messages, [channelId]: { ...ch, loading: true } } });
    try {
      const before = older ? ch.list[0]?.seq : undefined;
      const page = await this.api.getMessages(channelId, before);
      const cur = this.state.messages[channelId] ?? EMPTY;
      const merged = older ? [...page.messages, ...cur.list] : mergeLatest(cur.list, page.messages);
      if (!older && !cur.loaded) this.historyLoadedAt.set(channelId, Date.now());
      this.set({ messages: { ...this.state.messages, [channelId]: { list: merged, hasMore: older ? page.hasMore : (cur.loaded ? cur.hasMore : page.hasMore), loaded: true, loading: false } } });
      if (channelId === this.state.currentChannelId) this.rememberRead(channelId, merged);
    } catch (err) {
      this.set({ messages: { ...this.state.messages, [channelId]: { ...ch, loading: false } }, error: String(err) });
    }
  }

  async sendMessage(channelId: string, content: string, files: File[]) {
    const attachmentIds: string[] = [];
    for (const f of files) attachmentIds.push((await this.api.uploadAttachment(f)).id);
    const msg = await this.api.sendMessage(channelId, content, attachmentIds);
    const ch = this.state.messages[channelId];
    if (ch?.loaded && !ch.list.some((m) => m.id === msg.id)) {
      this.set({ messages: { ...this.state.messages, [channelId]: { ...ch, list: [...ch.list, msg] } } });
    }
  }

  typing(channelId: string) { this.send({ type: "typing", channelId }); }

  clearError() { this.set({ error: null }); }
}

/** Merge the newest page with the existing cache (after a reconnect), without duplicates. */
function mergeLatest(cur: Message[], page: Message[]): Message[] {
  if (!cur.length) return page;
  const known = new Set(cur.map((m) => m.id));
  const byId = new Map(page.map((m) => [m.id, m]));
  const updated = cur.map((m) => byId.get(m.id) ?? m);
  return [...updated, ...page.filter((m) => !known.has(m.id))].sort((a, b) => a.seq - b.seq);
}
