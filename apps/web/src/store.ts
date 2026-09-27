import {
  DM_MAX_CIPHERTEXT_CHARS, DM_REPORT_CONTEXT_MAX, base64ToBytes, deriveDmKey, deriveSettingsKey, directoryServerUrl, openDm, openSettings, reportKindsOf, sealDm, sealSettings, type DmControl, type DmPreview,
  type AccountServer, type AccountSettings, type AccountStatus, type DirectoryAccount, type DirectoryServerEvent, type DmConversation, type DmMessage, type Friend, type GamePresence, type ReportReason, type ServerLeaveResponse,
  type AccountNotice, type DirectoryReportKind, type ServerReportEvidence,
} from "@squorli/protocol";
import { REFUSED_LIST_MAX_AGE_MS, hostRefused, loadDismissedRefused, loadRefusedList, refusedList, refusedListDue, sameHidden, saveDismissedRefused, saveRefusedList, shownRefused, type RefusedList } from "./refusedServers";
import { buildDmPreviews, type PreviewDeps } from "./dmPreviews";
import { shrinkPreviewImage } from "./dmPreviewImage";
import { activity } from "./activity";
import { chooseInitialServer, loadClientData, parseServerAddress, saveClientData } from "./clientHome";
import * as api from "./api";
import type { AvatarImage } from "./avatarImage";
import { DirectoryLink, type LinkStatus } from "./directoryLink";
import { dmReportContent } from "./dmReports";
import { forgetServerAccount, loadOrCreateIdentity, loadServerAccounts, newIdentity, storeIdentity, storeServerAccount, type Identity, type ServerAccount } from "./identity";
import { ServerConnection, type ServerConnState } from "./serverConnection";
import { applyAccountSettings, sameAccountSettings, sameHiddenGames, toAccountSettings } from "./accountSettings";
import { loadBlockedLists, sameBlocked, saveBlockedLists, saveBlockedName, withBlocked, type BlockedLists } from "./blocked";
import { sameServerOrder } from "./serverOrder";
import { seesIncoming } from "./attention";
import { notificationBody, type IncomingNote } from "./notifications";
import { accountLocalePreference, detectLocale, locale, localePreference, markAccountLocalePreference, storeLocalePreference, t, type LocalePreference } from "./i18n";
import { loadVoiceSettings, sameSoundSettings, saveVoiceSettings, subscribeVoiceSettings } from "./voice/settings";
import { normalizeSoundSettings } from "./voice/sounds";
import { platform } from "./platform";
import type { PlatformHome } from "./platform/types";
import { connectedHost } from "./serverHost";


export type { ChannelMessages, Connection, RawLogEntry, ServerConnState } from "./serverConnection";

/**
 * Client state without a UI dependency (apps/web/AGENTS.md). Multi-server client: one `ServerConnection` per server (own server =
 * the one serving the client, key `homeHost`; foreign servers from the server rail via their origin, key =
 * the host from the directory). The server rail switches `activeHost` without leaving the page; running connections
 * (and with them the voice connection) survive. Plus identity, directory (M6), friends and direct messages (M7).
 *
 * A client without a home server (the desktop app, docs/features/desktop.md): `homeHost` is null, the directory is the
 * platform's default, the client has a login of its own (`signedIn`) and every server is a "foreign" one: the account's
 * servers from the directory plus the ones added by address (`localHosts`).
 */

/** Decrypted direct message (M7); text = null if it could not be opened (foreign key, corrupted). */
/** `previews` = what the sender put into the message; `control` = the message is an instruction (dmPreviews.ts `visibleDms`), not text. */
export type Dm = { id: string; seq: number; from: string; to: string; sentAt: string; text: string | null; previews?: DmPreview[]; control?: DmControl };
export type DmThread = { list: Dm[]; hasMore: boolean; loaded: boolean; loading: boolean };

export type State = {
  /** The main identity: the directory account's key, or this device's (friends, direct messages and synced settings hang off it). */
  identity: Identity | null;
  /**
   * Server accounts on this device (`~name`, docs/features/local-accounts.md): store key of the server -> the handle there.
   * Such a server signs in with the account's own key, never with `identity`.
   */
  serverAccounts: Record<string, string>;
  /** Key of your own server in `servers` (the host in the address bar); null = the client has no home server (desktop app). */
  homeHost: string | null;
  /** The server shown in the main area (server rail); null = none (only without a home server). */
  activeHost: string | null;
  /** State per server; your own server is always present when the client has one. */
  servers: Record<string, ServerConnState>;
  /** Directory service (M6) named by your own server; null = none. */
  directoryUrl: string | null;
  /** Account at the directory for your own key; undefined = not checked yet, null = not registered. */
  directoryAccount: DirectoryAccount | null | undefined;
  directoryError: string | null;
  /** The directory wants a confirmed e-mail address for a new handle (its `features.emailRequired`); asked only while the key has no handle. */
  directoryEmailRequired: boolean;
  /** The directory stores avatars (`features.avatars`): the settings offer the upload. False until the signed status was read. */
  directoryAvatars: boolean;
  /** The directory has a game library (`GET /api/games/:id`, docs/features/games.md): names and icons of launcher game ids. */
  directoryGameLibrary: boolean;
  /** Servers the handle has signed in on (directory, AccountStatus.servers): the server rail. null = unknown/no account. */
  accountServers: AccountServer[] | null;
  /** Last failure while saving the settings in the directory account (shown in the settings dialog); null = fine. */
  settingsSyncError: string | null;
  /** The account keeps the settings as a blob only this user's key opens (directory `features.settingsSealed`); false = in the open, or no account. */
  settingsSealed: boolean;
  /** The games never to show, as the account's sealed settings hold them (App.tsx hands them to the game detection); null = the account says nothing. */
  accountHiddenGames: string[] | null;
  /** A language change is stored but waits for the reload until the voice connection has ended (`reloadForLocale`). */
  localeReloadPending: boolean;
  /**
   * Blocked people per identity (the identity's public key -> their public keys; blocked.ts, docs/features/reports.md stage 3).
   * The main identity's list follows the directory account inside the sealed settings, a server account's stays on this device.
   */
  blocked: BlockedLists;
  // ---- M7: friends and direct messages over the directory socket
  /** Connection to the directory socket; "idle" also when there is no directory or no account. */
  directoryLink: LinkStatus;
  directoryLinkError: string | null;
  /** The directory takes reports of direct messages (`features.reports`, docs/features/reports.md): the flag on a friend's message. */
  dmReports: boolean;
  /**
   * What the account may report to the directory's operator (`reportKindsOf`): "account" = a directory account as it shows,
   * "server" = a chat server. Empty without a directory account, or at a directory from before them.
   */
  reportKinds: DirectoryReportKind[];
  /**
   * Notices about measures of the directory's operator (a warning, the picture or name removed, a suspension and its end;
   * docs/features/reports.md), newest first, as the account's status has them. The client shows the unread ones and marks
   * them as read (`readNotice`). Empty without an account.
   */
  notices: AccountNotice[];
  /**
   * The directory's operator suspended the account until then, with the reason; null = not suspended. While it lasts the
   * directory gives no socket (no friends, no direct messages), and chat servers refuse the sign-in unless their operator
   * switched that off.
   */
  suspendedUntil: string | null;
  suspendedReason: ReportReason | null;
  /** Friends and open requests (from my point of view); null = nothing from the directory yet. */
  friends: Friend[] | null;
  /** Conversations per friend (the friend's key) with unread counts; arrives with the welcome and is kept up to date live. */
  conversations: Record<string, DmConversation>;
  dms: Record<string, DmThread>;
  /** Home view (the Squorli mark in the rail): friends list and direct messages instead of the server columns. */
  homeOpen: boolean;
  currentPeer: string | null;
  /** Last error from a friend or message action (shown inline). */
  friendsError: string | null;
  /**
   * The client is still finding out what its first screen is (`init()`: the key, and without a home server the directory
   * account with its servers). Until then App.tsx shows a start screen instead of a login or a "no server yet" that would
   * only flash by (user's report, 20 September 2026), and the desktop app keeps its start window up.
   */
  starting: boolean;
  /** Direct messages and mentions that arrived while the window did not have the focus (attention.ts); 0 again once it has. */
  missed: number;
  // ---- Client without a home server (desktop app); unused otherwise
  /** Past the client's own login (directory account or this device's key). */
  signedIn: boolean;
  /** Servers added by address, in the order they were added (the rail shows them after the account's). */
  localHosts: string[];
  /** The client's own login: running, and its last error. */
  clientLogin: { busy: boolean; error: string | null };
  /** Invite codes that came with a server address or link, for the join view of that server. */
  joinInvites: Record<string, string>;
};

/** Sessions per server (the token stays secret); v1 held only the own server's and is migrated once. */
const SESSIONS_KEY = "chat.sessions.v2";
const SESSION_KEY_V1 = "chat.session.v1";
type StoredSessions = { publicKey: string; tokens: Record<string, string> };

export const homeState = (s: State): ServerConnState | null => (s.homeHost !== null ? s.servers[s.homeHost] ?? null : null);
export const activeState = (s: State): ServerConnState | null => (s.activeHost !== null ? s.servers[s.activeHost] : undefined) ?? homeState(s);

const handlesOf = (all: Record<string, ServerAccount>): Record<string, string> => Object.fromEntries(Object.entries(all).map(([h, a]) => [h, a.localHandle]));

/** A failed key restore for the login views: the directory's code and body (`totp_required` carries `email`). */
const restoreError = (err: unknown) => Object.assign(new Error("restore failed"), { code: err instanceof api.ApiError ? err.code : null, body: err instanceof api.ApiError ? err.body : {} });

/** What the store needs from the platform (`platform/`): the server that serves the page, or the directory to use when there is none. */
export type StoreOptions = { home: PlatformHome | null; defaultDirectoryUrl: string | null };

const START_SCREEN_MAX_MS = 8000;

export class Store {
  readonly homeHost: string | null;
  /** Domain a login on the home server signs (the hostname of the address bar). */
  private readonly signDomain: string;
  private readonly defaultDirectoryUrl: string | null;
  /** Without a home server: the server viewed last (stored per device, clientHome.ts). */
  private lastHost: string | null = null;
  /** Without a home server: past the login and the first server chosen; a link that arrives earlier waits in `startTarget`. */
  private entered = false;
  private startTarget: string | null = null;
  state: State;
  private conns = new Map<string, ServerConnection>();
  private link: DirectoryLink | null = null;
  /** Game display: what goes out about the running game (gamePresence.ts), and whether chat servers get it or friends only. */
  private game: GamePresence | null = null;
  private gameOnServers = true;
  /** Pair key per friend (M7), derived from your own seed and the friend's key; clear it on an identity switch. */
  private dmKeys = new Map<string, Promise<CryptoKey>>();
  /** The directory has the blob store and the link lookup for previews in direct messages (`features.dmPreviews`). */
  private dmPreviewsAtDirectory = false;
  private listeners = new Set<(s: State) => void>();
  /** Set by the voice client: a kick/session loss on `host` ends the voice connection if it runs there. */
  onRemoved: ((host: string) => void) | null = null;
  /** Moderation (M3) on `host`: moving to another voice channel (null = out) and stopping camera/screen. */
  /** `votekick` = the channel voted the user out (docs/features/votekick.md). */
  onVoiceMoved: ((host: string, channelId: string | null, by: string, reason: "afk" | "elsewhere" | "votekick" | "blocked" | null, until?: string | null) => void) | null = null;
  onVoiceStop: ((host: string, what: { camera: boolean; screen: boolean }, by: string) => void) | null = null;
  /** The voice channel one sits in vanished from the channel list (channel permissions): App.tsx hangs up. */
  onVoiceGone: ((host: string) => void) | null = null;
  /** A direct message or a mention arrived that the user does not see right now (App.tsx plays the cue and shows the notification). */
  onIncoming: ((note: IncomingNote) => void) | null = null;
  /** Settings as the directory account holds them (null = none there or no account); user changes are pushed when they differ. */
  private accountSettings: AccountSettings | null = null;
  /** The directory stores all settings (features.settings); false = one that predates them, then only the cue settings follow the account. */
  private settingsSupported = false;
  /** The directory keeps the settings as a blob the client encrypts (features.settingsSealed); then nothing is written in the open any more. */
  private sealedSupported = false;
  /** What the account holds is such a blob already; false = plaintext settings or none, which the next push seals. */
  private accountSealed = false;
  /** The account's status was read once for this account: before that a push would not know what it overwrites and waits (`pushWanted`). */
  private settingsLoaded = false;
  private pushWanted = false;
  /** Hide list of the game display: as the account holds it, and as this device has it (App.tsx; null = this client keeps none, a browser, and passes the account's on). */
  private accountHidden: string[] | null = null;
  private localHidden: string[] | null = null;
  /** The server rail's order as the account's sealed blob has it (null = it says nothing); like the hide list it never travels in the open. */
  private accountOrder: string[] | null = null;
  /** The blocked people as the account's sealed blob has them (null = it says nothing); the same rule. */
  private accountBlocked: string[] | null = null;
  /** The switch for link previews in direct messages as the account holds it (null = the blob says nothing). */
  private accountDmPreviews: boolean | null = null;
  private settingsKey: { publicKey: string; key: Promise<CryptoKey> } | null = null;
  private settingsPushTimer: ReturnType<typeof setTimeout> | null = null;
  /** The chat servers the directory's operator refused (refusedServers.ts): the list of before counts until a new one arrived. */
  private refused: RefusedList | null = loadRefusedList();
  private refusedFetch: Promise<void> | null = null;
  /** The account's own servers among the refused ones, by store key (the account's status names them; known at once, not an hour later). */
  private accountRefused = new Set<string>();
  /** Those of them the user removed from the rail (refusedServers.ts): this device's copy, and what the account's sealed blob has (null = it says nothing). */
  private dismissedRefused: string[] = loadDismissedRefused();
  private accountDismissed: string[] | null = null;
  private linkRun = 0;

  constructor(opts: StoreOptions) {
    this.homeHost = opts.home?.host ?? null;
    this.signDomain = opts.home?.signDomain ?? "";
    this.defaultDirectoryUrl = opts.defaultDirectoryUrl;
    const home = this.homeHost !== null ? this.createConnection(this.homeHost, "") : null;
    this.state = {
      identity: null, serverAccounts: handlesOf(loadServerAccounts()), homeHost: this.homeHost, activeHost: this.homeHost, servers: home ? { [home.state.host]: home.state } : {},
      signedIn: false, localHosts: [], clientLogin: { busy: false, error: null }, joinInvites: {},
      directoryUrl: null, directoryAccount: undefined, directoryError: null, directoryEmailRequired: false, directoryAvatars: false, directoryGameLibrary: false, accountServers: null, settingsSyncError: null, settingsSealed: false, accountHiddenGames: null, localeReloadPending: false, blocked: loadBlockedLists(),
      directoryLink: "idle", directoryLinkError: null, dmReports: false, reportKinds: [], notices: [], suspendedUntil: null, suspendedReason: null, friends: null, conversations: {}, dms: {}, homeOpen: false, currentPeer: null, friendsError: null, missed: 0, starting: true,
    };
    // The list of refused chat servers is good for an hour (refusedServers.ts).
    setInterval(() => { void this.refreshRefused(); }, REFUSED_LIST_MAX_AGE_MS);
    subscribeVoiceSettings((_s, source) => { if (source === "user") this.scheduleSettingsPush(); });
    // AFK detection: every chat server and the directory hear when the user turns idle or comes back (activity.ts).
    activity.subscribe((idle) => { for (const conn of this.conns.values()) conn.setIdle(idle); this.link?.setIdle(idle); });
  }

  subscribe(fn: (s: State) => void) { this.listeners.add(fn); fn(this.state); return () => { this.listeners.delete(fn); }; }
  private set(p: Partial<State>) { this.state = { ...this.state, ...p }; for (const fn of this.listeners) fn(this.state); }

  /** Connection to a server (your own server is always present when the client has one). */
  connection(host: string | null): ServerConnection | null { return host !== null ? this.conns.get(host) ?? null : null; }
  get home(): ServerConnection | null { return this.connection(this.homeHost); }
  get active(): ServerConnection | null { return this.connection(this.state.activeHost) ?? this.home; }

  private createConnection(host: string, base: string): ServerConnection {
    const conn = new ServerConnection(host, base, () => this.identityFor(host), {
      onState: (s) => { if (this.state) this.set({ servers: { ...this.state.servers, [host]: s } }); },
      onToken: (token) => this.storeToken(host, token),
      onSessionLost: (message) => this.sessionLost(host, message),
      onRemoved: () => this.onRemoved?.(host),
      // Your own server, or a server the rail does not list yet (first sign-in there): fetch the list again. Servers connected in the
      // background are already on it, asking the directory once per server would be pointless.
      onConnected: () => { this.noteJoined(host); if (host === this.homeHost || !(this.state.accountServers ?? []).some((s) => this.hostFor(s.host) === host)) void this.refreshAccountServers(); },
      onVoiceMoved: (channelId, by, reason, until) => this.onVoiceMoved?.(host, channelId, by, reason, until),
      onVoiceStop: (what, by) => this.onVoiceStop?.(host, what, by),
      onVoiceGone: () => this.onVoiceGone?.(host),
      onMention: (message) => this.incoming(() => this.mentionNote(host, message), this.state.activeHost === host && !this.state.homeOpen && this.conns.get(host)?.state.currentChannelId === message.channelId),
      // Blocked people (stage 3): their messages neither mark the channel unread nor count as mentions.
      isBlocked: (publicKey) => this.blockedFor(host).includes(publicKey),
      isRefused: () => this.isRefused(host),
    });
    conn.setIdle(activity.idle);
    conn.setGame(this.gameOnServers ? this.game : null);
    this.conns.set(host, conn);
    return conn;
  }

  async init() {
    // A server or directory that does not answer must not hold the start screen for long: what is known by then is shown.
    const cap = setTimeout(() => this.set({ starting: false }), START_SCREEN_MAX_MS);
    try { await this.start(); } finally { clearTimeout(cap); if (this.state.starting) this.set({ starting: false }); }
  }
  private async start() {
    const identity = await loadOrCreateIdentity();
    this.set({ identity });
    const home = this.home;
    if (home) {
      void this.refreshDirectory();
      const token = this.storedToken(home.state.host);
      if (token) await home.resume(token);
      return;
    }
    // No home server: the device remembers whether the user is past the login, the added servers and the server viewed last.
    const data = loadClientData();
    this.lastHost = data.lastHost;
    this.set({ signedIn: data.signedIn, localHosts: data.hosts });
    await this.refreshDirectory();
    if (data.signedIn) this.enterClient();
  }

  // ---------- Chat servers the directory's operator refused (refusedServers.ts, docs/features/reports.md)
  /**
   * Whether the client must not connect to `host` (a store key: a foreign server's is its host at the directory). The
   * server that serves the page is never checked: a refused operator serves that page anyway, and refusing it here would
   * only lock its members out of a client they are looking at.
   */
  private async isRefused(host: string): Promise<boolean> {
    if (host === this.homeHost) return false;
    // The account's status names its own refused servers: that counts at once, the list of hashes may be an hour behind.
    if (this.accountRefused.has(host)) return true;
    return hostRefused(this.refused, this.state.directoryUrl, host);
  }
  /**
   * Fetch the list when it is due (none yet, another directory, older than an hour); a directory that cannot be reached
   * or that has no such list leaves the one at hand as it is. Every connection is checked against a new list.
   * `fresh` = now and past the browser's cache: the account's status said that the list at hand is behind.
   */
  private refreshRefused(fresh = false): Promise<void> {
    const url = this.state.directoryUrl;
    if (!url || (!fresh && !refusedListDue(this.refused, url, Date.now()))) return Promise.resolve();
    this.refusedFetch ??= (async () => {
      try {
        const health = await api.directoryHealth(url);
        if (!health.features.refusedServers) return;
        this.refused = refusedList(url, await api.directoryRefusedServers(url, fresh), Date.now());
        saveRefusedList(this.refused);
        this.recheckRefused();
      } catch { /* the list of before stays in force */ }
    })().finally(() => { this.refusedFetch = null; });
    return this.refusedFetch;
  }

  /**
   * What is known about refused servers changed: every connection is asked again. One refused since is closed by the
   * check; one of the user's servers that is allowed again connects by itself, as it would at the start.
   */
  private recheckRefused() {
    for (const conn of [...this.conns.values()]) {
      const was = conn.state.refused;
      void conn.checkRefused().then((refused) => {
        const host = conn.state.host;
        if (!was || refused || this.conns.get(host) !== conn || conn.state.connection !== "idle" || !this.isMine(host)) return;
        if (this.storedToken(host) || this.serverAccount(host)) void this.connectForeign(conn);
        else void this.probeServer(conn);
      });
    }
  }

  // ---------- Server accounts: one key per server (identity.ts), used instead of the main identity there
  private serverAccount(host: string): ServerAccount | null { return loadServerAccounts()[host] ?? null; }
  /** The key a server signs in with: its server account's, else the main identity. */
  identityFor(host: string): Identity | null {
    const acc = this.serverAccount(host);
    return acc ? { publicKey: acc.publicKey, privateKey: acc.privateKey } : this.state.identity;
  }
  private rememberServerAccount(host: string, id: Identity, localHandle: string, token: string | null) {
    storeServerAccount(host, { ...id, localHandle, token });
    this.set({ serverAccounts: handlesOf(loadServerAccounts()) });
  }
  private dropServerAccount(host: string) {
    const acc = this.serverAccount(host);
    forgetServerAccount(host);
    this.set({ serverAccounts: handlesOf(loadServerAccounts()) });
    if (acc) this.forgetBlockedOf(acc.publicKey);
  }
  /**
   * The domain a sign-in on `conn` signs: the address bar's for the own server, else the host this client actually connects
   * to (security review of 25 September 2026: a server's own word about its domain is never signed, or a malicious server
   * could name another one and pass the signature on, a login relay; docs/features/directory.md). The server's
   * PUBLIC_DOMAIN must be that same host; a server that says otherwise gets no sign-in at all.
   */
  private async signDomainOf(conn: ServerConnection): Promise<string> {
    if (conn.state.host === this.homeHost) return this.signDomain;
    const reported = conn.state.serverDomain ?? (await conn.refreshHealth())?.domain ?? null;
    if (!reported) throw new Error(t("err.serverUnreachableShort", { base: conn.state.base }));
    const actual = connectedHost(conn.state.base);
    if (reported.toLowerCase() !== actual) {
      const msg = t("err.foreignDomainMismatch", { base: conn.state.base, domain: reported });
      conn.state = { ...conn.state, connection: "error", error: msg };
      this.publish(conn);
      throw new Error(msg);
    }
    return actual;
  }
  private publish(conn: ServerConnection) { this.set({ servers: { ...this.state.servers, [conn.state.host]: conn.state } }); }
  private failed(conn: ServerConnection, err: unknown): never {
    conn.state = { ...conn.state, connection: "idle", error: api.explainLocalError(err) };
    this.publish(conn);
    throw Object.assign(new Error("server account failed"), { code: err instanceof api.ApiError ? err.code : null });
  }

  /**
   * Register a server account on `host` with a fresh key and sign in with it (docs/features/local-accounts.md). The main
   * identity stays as it is; the new key belongs to this server only. Throws with `code` after setting the server's error.
   */
  async registerLocal(host: string, handle: string, password: string, invite?: string, ownerCode?: string): Promise<void> {
    const conn = this.conns.get(host);
    if (!conn) return;
    conn.state = { ...conn.state, connection: "logging-in", error: null, removed: null };
    this.publish(conn);
    try {
      const id = await newIdentity();
      const session = await conn.api.localRegister(id, await this.signDomainOf(conn), handle, password, invite, ownerCode);
      this.rememberServerAccount(host, id, handle.trim().toLowerCase(), null);
      await conn.adopt(session);
    } catch (err) { this.failed(conn, err); }
  }
  /** Sign in with a server account on another device: fetch its key from the server with the password, then sign in with it. */
  async loginLocal(host: string, handle: string, password: string, invite?: string): Promise<void> {
    const conn = this.conns.get(host);
    if (!conn) return;
    conn.state = { ...conn.state, connection: "logging-in", error: null, removed: null };
    this.publish(conn);
    let id: Identity;
    let legacy = false;
    try { ({ id, legacy } = await conn.api.localRestore(handle, password)); }
    catch (err) { this.failed(conn, err); }
    this.rememberServerAccount(host, id, handle.trim().toLowerCase(), null);
    try { await conn.login(await this.signDomainOf(conn), invite); }
    catch (err) { this.dropServerAccount(host); throw err; }
    // A backup from before 25 September 2026 is not bound to this server's host (backup.ts): encrypt it anew, bound, now
    // that the password is at hand (the same password; the server keeps nothing else).
    if (legacy) void conn.api.localChangePassword(id, handle.trim().toLowerCase(), password, password).catch(() => { /* next sign-in tries again */ });
  }
  /**
   * A member from before server accounts (`me.registrationRequired`) registers a server account on a fresh key for this server
   * (security review of 25 September 2026: the key they are signed in with, often the main identity, stays on the device);
   * the membership moves to the new key, the session stays. An older server cannot move it: then no claim at all.
   */
  async claimLocal(host: string, handle: string, password: string): Promise<void> {
    const conn = this.conns.get(host);
    const id = this.identityFor(host);
    if (!conn || !id) return;
    const health = await conn.refreshHealth();
    if (!health?.localClaimRekey) this.failed(conn, new Error(t("err.claimNeedsUpdate")));
    const fresh = await newIdentity();
    try { await conn.api.localClaim(id, fresh, await this.signDomainOf(conn), handle, password); }
    catch (err) { this.failed(conn, err); }
    const token = conn.api.getToken();
    this.storeToken(host, null);
    this.rememberServerAccount(host, fresh, handle.trim().toLowerCase(), token);
    await conn.refreshMe();
  }
  /** Such a member registers a directory handle for the key instead; the server sees it at the next sign-in. */
  async claimDirectory(host: string, handle: string, email?: string, emailCode?: string): Promise<"done" | "failed" | { sentTo: string }> {
    const res = await this.registerHandle(handle, email, emailCode);
    const conn = this.conns.get(host);
    if (res === "done" && conn) await conn.login(await this.signDomainOf(conn)).catch(() => {});
    return res;
  }
  /** Sign out of a server account on this device: the session ends and the key is forgotten (the password brings it back). */
  logoutServerAccount(host: string) {
    if (!this.serverAccount(host)) return;
    const conn = this.conns.get(host);
    conn?.logout();
    this.dropServerAccount(host);
    if (host !== this.homeHost) this.closeServer(host);
  }
  /** A new password for the server account of the server shown. Throws with a translated message. */
  async changeLocalPassword(oldPassword: string, newPassword: string): Promise<void> {
    const conn = this.active; const host = conn?.state.host ?? null;
    const acc = host !== null ? this.serverAccount(host) : null;
    const handle = conn?.state.me?.localHandle;
    if (!conn || !handle) return;
    const id = acc ?? this.state.identity;
    if (!id) return;
    try { await conn.api.localChangePassword(id, handle, oldPassword, newPassword); }
    catch (err) { throw new Error(api.explainLocalError(err)); }
    // A new password ends the account's other sessions here (security review, 25 September 2026): whoever changes it
    // because it leaked wants the other devices out. Done by the client, since the same route rebinds an old backup with
    // the same password at a sign-in (loginLocal), which must sign nobody out.
    await conn.api.revokeOtherSessions().catch(() => { /* the password is changed; the list in Sitzungen still works */ });
  }
  /** Delete the server account of the server shown (the password proves it); the server then closes the socket with 4012. */
  async deleteLocalAccount(password: string): Promise<void> {
    const conn = this.active; const handle = conn?.state.me?.localHandle;
    if (!conn || !handle) return;
    try { await conn.api.localDelete(handle, password); }
    catch (err) { throw new Error(api.explainLocalError(err)); }
    const host = conn.state.host;
    conn.accountDeleted();
    this.dropServerAccount(host);
    if (host !== this.homeHost) this.closeServer(host);
  }

  // ---------- Sessions per server in localStorage
  private readSessions(): StoredSessions | null {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      if (raw) return JSON.parse(raw) as StoredSessions;
      const v1 = localStorage.getItem(SESSION_KEY_V1);
      if (v1) {
        const s = JSON.parse(v1) as { token: string; publicKey: string };
        const migrated: StoredSessions = { publicKey: s.publicKey, tokens: this.homeHost !== null ? { [this.homeHost]: s.token } : {} };
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(migrated));
        localStorage.removeItem(SESSION_KEY_V1);
        return migrated;
      }
    } catch { /* no localStorage */ }
    return null;
  }
  private storedToken(host: string): string | null {
    const acc = this.serverAccount(host);
    if (acc) return acc.token;
    const s = this.readSessions();
    return s && s.publicKey === this.state.identity?.publicKey ? s.tokens[host] ?? null : null;
  }
  private storeToken(host: string, token: string | null) {
    const acc = this.serverAccount(host);
    if (acc) { storeServerAccount(host, { ...acc, token }); return; }
    const pk = this.state.identity?.publicKey;
    if (!pk) return;
    try {
      const prev = this.readSessions();
      const tokens = prev && prev.publicKey === pk ? { ...prev.tokens } : {};
      if (token) tokens[host] = token; else delete tokens[host];
      localStorage.setItem(SESSIONS_KEY, JSON.stringify({ publicKey: pk, tokens } satisfies StoredSessions));
    } catch { /* never mind */ }
  }
  private forgetAllTokens() { try { localStorage.removeItem(SESSIONS_KEY); localStorage.removeItem(SESSION_KEY_V1); } catch { /* never mind */ } }

  // ---------- Server rail: switching servers and opening foreign servers
  /** Map a host from the directory (PUBLIC_DOMAIN) onto the key in `servers`: your own server is called `homeHost` here. */
  hostFor(directoryHost: string): string {
    const h = directoryHost.toLowerCase();
    const home = homeState(this.state);
    if (this.homeHost === null || !home) return h;
    return h === home.serverDomain || h === this.homeHost.toLowerCase() || h === this.signDomain.toLowerCase() ? this.homeHost : h;
  }
  /** Show a server in the main area; a foreign server is connected on first use (signing in with your own key). */
  openServer(directoryHost: string) {
    const host = this.hostFor(directoryHost);
    this.set({ activeHost: host, homeOpen: false });
    if (host === this.homeHost) return;
    this.rememberLast(host);
    let conn = this.conns.get(host);
    if (!conn) {
      conn = this.createConnection(host, directoryServerUrl(host));
      this.set({ servers: { ...this.state.servers, [host]: conn.state } });
    }
    const st = conn.state;
    if (st.connection === "idle" && !st.removed) void this.connectForeign(conn);
  }
  /**
   * Connect every server of the rail in the background (signing in with your own key like `openServer`, but without showing
   * it), so the rail can mark servers with unread messages and mentions, live. Only while signed in on your own server;
   * a server whose account deletion is pending is left alone. Consequence: you are online on all your servers.
   */
  private connectAccountServers(servers: readonly AccountServer[]) {
    if (this.homeHost !== null ? !this.home?.state.me : !this.state.signedIn) return;
    for (const s of servers) {
      const host = this.hostFor(s.host);
      if (host === this.homeHost || s.leaveRequestedAt || this.conns.has(host)) continue;
      const conn = this.createConnection(host, directoryServerUrl(host));
      this.set({ servers: { ...this.state.servers, [host]: conn.state } });
      // By itself only to a server this device has signed in to before (a stored session or a server account); one the list
      // names that this device does not know shows in the rail and connects at the first click (security review of 25
      // September 2026: the list is the directory's word, a server that slipped in must not get a sign-in unasked).
      if (this.storedToken(host) || this.serverAccount(host)) void this.connectForeign(conn);
      else void this.probeServer(conn);
    }
  }
  /**
   * One of the user's servers: a stored session or a server account here, added by address, or on the account's list at
   * the directory. Such a server that does not answer gets the notice with retries (docs/features/offline.md); any other
   * one is a first contact and waits for a click.
   */
  private isMine(host: string): boolean {
    return !!this.storedToken(host) || !!this.serverAccount(host) || this.state.localHosts.includes(host) || (this.state.accountServers ?? []).some((s) => this.hostFor(s.host) === host && !s.leaveRequestedAt);
  }
  /**
   * A server on the account's list this device has no session on: only its health is asked, so the rail can mark one that
   * does not answer and the notice can show (never a sign-in without a click, security review of 25 September 2026). The
   * probe repeats by itself while the server stays silent; once it answers, the join view waits for the click as before.
   */
  private async probeServer(conn: ServerConnection) {
    const health = await conn.refreshHealth();
    if (conn.state.refused) return;
    if (!health) { this.markUnreachable(conn, () => void this.probeServer(conn)); return; }
    conn.retrySettled();
    if (conn.state.waiting !== null || conn.state.connection === "error") { conn.state = { ...conn.state, connection: conn.state.me ? conn.state.connection : "idle", error: null, waiting: null }; this.publish(conn); }
  }
  /** Try again (after an error or a removal); also the "join" of a server added by address, then possibly with an invite. */
  retryServer(host: string, invite?: string) {
    const conn = this.conns.get(host);
    if (!conn || host === this.homeHost) return;
    conn.noteUserRetry();
    conn.cancelRetry();
    void this.connectForeign(conn, invite);
  }
  /**
   * The server did not answer. `again` = the step to run when it is worth trying by itself (a server this device has
   * been on, docs/features/offline.md): the state says "unreachable" and the connection schedules it; a server the user
   * is only about to join waits for a click.
   */
  private markUnreachable(conn: ServerConnection, again: (() => void) | null) {
    conn.state = { ...conn.state, connection: "error", error: t("err.serverUnreachableShort", { base: conn.state.base }), waiting: again ? "unreachable" : null };
    this.set({ servers: { ...this.state.servers, [conn.state.host]: conn.state } });
    if (again) conn.retryLater(again);
  }
  private async connectForeign(conn: ServerConnection, invite?: string) {
    const host = conn.state.host;
    // One of the user's servers is tried again by itself while it is down; a first contact waits for a click.
    const known = this.isMine(host);
    // The first try says "checking"; a retry after "unreachable" keeps that notice on screen (the attempt itself may take the
    // health request's whole time limit, and a status that flips back and forth would say nothing).
    if (known && conn.state.waiting !== "unreachable") { conn.state = { ...conn.state, connection: "connecting", error: null, waiting: "checking" }; this.publish(conn); }
    const health = await conn.refreshHealth();
    if (conn.state.refused) return;
    if (!health) { this.markUnreachable(conn, known ? () => void this.connectForeign(conn, invite) : null); return; }
    conn.retrySettled();
    const token = this.storedToken(host);
    if (token && await conn.resume(token) !== "rejected") return;
    try { await conn.login(await this.signDomainOf(conn), invite); } catch { /* the message is kept in the server's state */ }
  }
  /**
   * "Aus der Liste entfernen" on a server the directory's operator refused: gone from the rail. One of the account's list
   * is hidden (refusedServers.ts): the list of hidden hosts follows the account inside the sealed settings, so the entry
   * is gone on every device. The account's entry at the directory stays, and the server shows again by itself once it
   * is allowed.
   */
  removeRefused(host: string) {
    if (host === this.homeHost) return;
    if (this.accountRefused.has(host) && !this.dismissedRefused.includes(host)) this.storeDismissed([...this.dismissedRefused, host]);
    const listed = this.state.accountServers;
    if (listed) this.set({ accountServers: listed.filter((s) => !(s.refused && this.hostFor(s.host) === host)) });
    this.closeServer(host);
  }
  /** The hidden refused servers as they are now: kept on the device and, when they differ from the account's, pushed there. */
  private storeDismissed(hosts: string[]) {
    this.dismissedRefused = hosts;
    saveDismissedRefused(hosts);
    // At once: one click, nothing to gather, and the user may close the app right after it.
    if (this.sealedSupported && this.settingsLoaded && !sameHidden(hosts, this.accountDismissed)) this.scheduleSettingsPush(0);
  }
  /** Close a foreign server and remove it from the client's rail (the session stays stored). */
  closeServer(host: string) {
    if (host === this.homeHost) return;
    const conn = this.conns.get(host);
    conn?.close();
    this.conns.delete(host);
    const servers = { ...this.state.servers }; delete servers[host];
    this.set({ servers, localHosts: this.state.localHosts.filter((h) => h !== host), activeHost: this.state.activeHost === host ? this.homeHost : this.state.activeHost });
    if (this.lastHost === host) this.lastHost = null;
    this.saveClient();
  }
  /** Session on `host` gone: own server = back to the login (all connections closed), foreign = signed out there only. */
  private sessionLost(host: string, _message: string) {
    if (host !== this.homeHost) return;
    this.closeAllForeign();
  }
  /** Close the foreign servers; `keepServerAccounts` leaves those that sign in with a server account of their own (another main identity does not touch them). */
  private closeAllForeign(keepServerAccounts = false) {
    const accounts = loadServerAccounts();
    const kept: Record<string, ServerConnState> = {};
    for (const [host, conn] of this.conns) {
      if (host === this.homeHost) continue;
      if (keepServerAccounts && accounts[host]) { kept[host] = conn.state; continue; }
      conn.close(); this.conns.delete(host);
    }
    const home = this.home;
    const activeKept = this.state.activeHost !== null && this.state.activeHost in kept;
    this.set({ servers: { ...(home ? { [home.state.host]: home.state } : {}), ...kept }, activeHost: activeKept ? this.state.activeHost : this.homeHost });
  }

  // ---------- Client without a home server (desktop app): own login, servers by address, the server viewed last
  private saveClient() {
    if (this.homeHost === null) saveClientData({ signedIn: this.state.signedIn, hosts: this.state.localHosts, lastHost: this.lastHost });
  }
  private rememberLast(host: string) {
    if (this.homeHost !== null || this.lastHost === host) return;
    this.lastHost = host;
    this.saveClient();
  }
  /** A server connected: one that is not on the account's list (no directory, another directory) is kept as added by address. */
  private noteJoined(host: string) {
    if (this.homeHost !== null) return;
    if (this.state.activeHost === host) this.rememberLast(host);
    if (this.state.localHosts.includes(host) || (this.state.accountServers ?? []).some((s) => this.hostFor(s.host) === host)) return;
    this.set({ localHosts: [...this.state.localHosts, host] });
    this.saveClient();
  }
  /** Past the login: connect the added servers (the account's are connected by `connectAccountServers`) and show one. */
  private enterClient() {
    for (const host of this.state.localHosts) {
      if (this.conns.has(host)) continue;
      const conn = this.createConnection(host, directoryServerUrl(host));
      this.set({ servers: { ...this.state.servers, [host]: conn.state } });
      void this.connectForeign(conn);
    }
    this.entered = true;
    // A link the app was opened with wins over the server viewed last.
    const target = this.startTarget; this.startTarget = null;
    if (target) { void this.addServer(target); return; }
    const host = chooseInitialServer({ last: this.lastHost, accountServers: this.state.accountServers, localHosts: this.state.localHosts });
    if (host) this.openServer(host);
  }
  /**
   * A `squorli://` link reached the app (desktop): shown like an address typed in (`addServer`), so a server the key has never
   * been on waits for a click. Before the client's own login it waits and is shown right after it.
   */
  openLink(input: string): boolean {
    if (this.homeHost !== null) return false; // a client served by a server shows no other server this way (the browser hands the link to the system)
    if (this.entered) void this.addServer(input); else this.startTarget = input;
    return true;
  }
  /**
   * Sign in with the directory account (handle + password, code with an active authenticator): fetches the key, replaces the
   * device key, then connects the account's servers and opens the one viewed last. Throws like `loginWithHandle`.
   */
  async loginDirectoryAccount(handle: string, password: string, code?: string): Promise<void> {
    const url = this.state.directoryUrl;
    if (!url || this.homeHost !== null) return;
    this.set({ clientLogin: { busy: true, error: null } });
    let id: Identity;
    try { id = await api.directoryRestore(url, handle, password, code); }
    catch (err) {
      this.set({ clientLogin: { busy: false, error: api.explainDirectoryError(err) } });
      throw restoreError(err);
    }
    // Another key than this device had: its sessions and added servers belonged to that key. Servers with a server account
    // sign in with a key of their own and stay (the user's wish: directory account and server accounts side by side).
    if (id.publicKey !== this.state.identity?.publicKey) {
      this.closeAllForeign(true);
      this.forgetAllTokens();
      const accounts = loadServerAccounts();
      if (this.lastHost !== null && !accounts[this.lastHost]) this.lastHost = null;
      this.set({ localHosts: this.state.localHosts.filter((h) => !!accounts[h]), joinInvites: {} });
    }
    storeIdentity(id);
    this.set({ identity: id, directoryAccount: undefined, signedIn: true });
    this.saveClient();
    await this.refreshDirectory();
    this.set({ clientLogin: { busy: false, error: null } });
    this.enterClient();
  }
  /**
   * Signed in with server accounts only: show the client's login again to add the directory account, without signing out.
   * The servers keep running; `loginDirectoryAccount` keeps the ones with a server account, "continue" goes back.
   */
  openAccountLogin() {
    if (this.homeHost !== null) return;
    this.set({ signedIn: false, clientLogin: { busy: false, error: null } });
  }
  /** Go on with this device's key (it may have a handle or not; servers without a directory need none). */
  continueWithDeviceKey() {
    if (this.homeHost !== null) return;
    this.set({ signedIn: true, clientLogin: { busy: false, error: null } });
    this.saveClient();
    this.connectAccountServers(this.state.accountServers ?? []);
    void this.connectDirectory();
    this.enterClient();
  }
  /**
   * Show a server named by an address, an invite link or a `squorli://` link (clientHome.ts `parseServerAddress`). A server
   * the key has been on (stored session, added before, or on the account's list) is connected right away; any other one is
   * only looked at (`/api/health`): signing in reveals the public key and creates an account there, so the join view waits
   * for a click (`retryServer(host, invite)`). Returns a message when the input names no server.
   */
  async addServer(input: string): Promise<string | null> {
    const target = parseServerAddress(input);
    if (!target) return t("add.invalid");
    const host = target.host;
    let conn = this.conns.get(host);
    if (!conn) {
      conn = this.createConnection(host, directoryServerUrl(host));
      this.set({ servers: { ...this.state.servers, [host]: conn.state } });
    }
    this.set({ activeHost: host, homeOpen: false, ...(target.invite ? { joinInvites: { ...this.state.joinInvites, [host]: target.invite } } : {}) });
    if (conn.state.me || conn.state.connection !== "idle") { this.rememberLast(host); return null; }
    if (this.isMine(host)) { this.rememberLast(host); void this.connectForeign(conn, target.invite ?? undefined); }
    else if (!(await conn.refreshHealth()) && !conn.state.refused) this.markUnreachable(conn, null);
    return null;
  }

  /** Fetch the directory URL from your own server and check whether your key has a handle there. */
  async refreshDirectory(): Promise<void> {
    const home = this.home;
    const directoryUrl = home ? (await home.refreshHealth())?.directoryUrl ?? null : this.defaultDirectoryUrl;
    this.set({ directoryUrl, directoryError: null });
    const id = this.state.identity;
    if (!directoryUrl || !id) { this.set({ directoryAccount: null }); return; }
    try {
      const account = await api.directoryLookup(directoryUrl, id.publicKey);
      // A key without a handle may register one: the login has to know whether the directory wants an e-mail address for that.
      const emailRequired = account ? false : (await api.directoryHealth(directoryUrl)).features.emailRequired;
      this.set({ directoryAccount: account, directoryEmailRequired: emailRequired });
    }
    catch (err) { this.set({ directoryAccount: undefined, directoryError: api.explainDirectoryError(err) }); }
    // The refused chat servers first: the connections made below are checked against the list at hand either way.
    void this.refreshRefused();
    const rail = this.refreshAccountServers();
    void this.connectDirectory();
    // Without a home server the caller goes on to pick the server to show, which needs the account's list.
    if (!home) await rail;
  }

  // ---------- M7: directory socket (friends, presence, direct messages)
  /** Open the socket to the directory as soon as directory, account and key are present; otherwise close it. */
  private async connectDirectory() {
    const id = this.state.identity; const url = this.state.directoryUrl;
    // Two runs at once (the status arrived while the first one asked the directory's health) must not leave two sockets.
    const run = ++this.linkRun;
    this.link?.close(); this.link = null;
    this.dmKeys.clear();
    this.set({ directoryLink: "idle", directoryLinkError: null, dmReports: false, friends: null, conversations: {}, dms: {}, homeOpen: false, currentPeer: null });
    if (!id || !url || !this.state.directoryAccount) return;
    if (this.homeHost === null && !this.state.signedIn) return;
    // A suspended account gets no socket (docs/features/reports.md): nothing to try until the suspension is over.
    if (this.isSuspended()) return;
    const health = await api.directoryHealth(url).catch(() => null);
    if (run !== this.linkRun || !health?.features.friends) return;
    if (this.isSuspended()) return;
    this.dmPreviewsAtDirectory = health.features.dmPreviews;
    this.set({ dmReports: health.features.reports });
    const link = new DirectoryLink(url, id, (e) => this.handleDirectory(e), (status, error) => this.set({ directoryLink: status, directoryLinkError: error ?? null }), health.features.afk);
    link.setIdle(activity.idle);
    link.setGame(this.game);
    this.link = link;
    link.connect();
  }
  private dmKey(peer: string): Promise<CryptoKey> {
    const id = this.state.identity!;
    let p = this.dmKeys.get(peer);
    if (!p) { p = deriveDmKey(id.privateKey, id.publicKey, peer); this.dmKeys.set(peer, p); }
    return p;
  }
  private async decrypt(m: DmMessage): Promise<Dm> {
    const me = this.state.identity?.publicKey;
    const peer = m.from === me ? m.to : m.from;
    const base = { id: m.id, seq: m.seq, from: m.from, to: m.to, sentAt: m.sentAt };
    try {
      const opened = await openDm(await this.dmKey(peer), m);
      return { ...base, text: opened.text, ...(opened.previews ? { previews: opened.previews } : {}), ...(opened.control ? { control: opened.control } : {}) };
    } catch { return { ...base, text: null }; }
  }
  private thread(peer: string): DmThread { return this.state.dms[peer] ?? { list: [], hasMore: true, loaded: false, loading: false }; }
  private setThread(peer: string, t: DmThread) { this.set({ dms: { ...this.state.dms, [peer]: t } }); }
  private async handleDirectory(e: DirectoryServerEvent) {
    const me = this.state.identity?.publicKey ?? "";
    switch (e.type) {
      case "welcome": {
        const conversations: Record<string, DmConversation> = {};
        for (const c of e.conversations) conversations[c.peer] = c;
        // After a reconnect, reload the open history; messages could be missing.
        this.set({ friends: e.friends, conversations, dms: {} });
        if (this.state.currentPeer) void this.loadDmHistory(this.state.currentPeer);
        break;
      }
      case "friends.update": {
        const rest = (this.state.friends ?? []).filter((f) => f.publicKey !== e.publicKey);
        this.set({ friends: e.friend ? [...rest, e.friend] : rest });
        break;
      }
      case "friends.presence":
        this.set({ friends: (this.state.friends ?? []).map((f) => (f.publicKey === e.publicKey ? { ...f, online: e.online, afk: e.afk, game: e.game } : f)) });
        break;
      case "dm.message": {
        const m = e.message;
        const peer = m.from === me ? m.to : m.from;
        const dm = await this.decrypt(m);
        const t = this.thread(peer);
        if (t.loaded && !t.list.some((x) => x.id === dm.id)) this.setThread(peer, { ...t, list: [...t.list, dm].sort((a, b) => a.seq - b.seq) });
        const viewing = this.state.homeOpen && this.state.currentPeer === peer && document.visibilityState === "visible";
        const prev = this.state.conversations[peer];
        if (dm.control) {
          // An instruction (a preview taken away) is nothing to read: no unread mark, no sound, the conversation stays where
          // it is in the list. With everything before it read, the read cursor moves past it, so it never counts later either.
          if (prev) this.set({ conversations: { ...this.state.conversations, [peer]: { ...prev, lastSeq: m.seq } } });
          if (m.from !== me && (viewing || (prev?.unread ?? 0) === 0)) this.link?.send({ type: "dm.read", peer, seq: m.seq });
          break;
        }
        const unread = m.from === me || viewing ? 0 : (prev?.unread ?? 0) + 1;
        this.set({ conversations: { ...this.state.conversations, [peer]: { peer, lastSeq: m.seq, lastAt: m.sentAt, unread } } });
        if (viewing && m.from !== me) this.link?.send({ type: "dm.read", peer, seq: m.seq });
        if (m.from !== me) this.incoming(() => this.dmNote(peer, dm.text ?? ""), this.state.homeOpen && this.state.currentPeer === peer);
        break;
      }
      case "dm.history": {
        const list = await Promise.all(e.messages.map((m) => this.decrypt(m)));
        const t = this.thread(e.peer);
        const known = new Set(t.list.map((m) => m.id));
        const merged = [...list.filter((m) => !known.has(m.id)), ...t.list].sort((a, b) => a.seq - b.seq);
        this.setThread(e.peer, { list: merged, hasMore: t.loaded && merged.length && list.length && list[0]!.seq > merged[0]!.seq ? t.hasMore : e.more, loaded: true, loading: false });
        break;
      }
      case "dm.read": {
        const c = this.state.conversations[e.peer];
        if (c && e.seq >= c.lastSeq) this.set({ conversations: { ...this.state.conversations, [e.peer]: { ...c, unread: 0 } } });
        break;
      }
      case "dm.deleted": {
        const t = this.state.dms[e.peer];
        if (t) this.setThread(e.peer, { ...t, list: t.list.filter((m) => m.id !== e.id) });
        break;
      }
      case "dm.cleared": {
        const conversations = { ...this.state.conversations }; delete conversations[e.peer];
        this.set({ conversations, dms: { ...this.state.dms, [e.peer]: { list: [], hasMore: false, loaded: true, loading: false } } });
        break;
      }
      case "error":
        if (e.code === "version" || e.code === "unauthorized" || e.code === "unknown_account") break; // connection error, recorded in directoryLinkError
        if (e.code === "account_suspended") {
          // The directory's operator suspended the account: no socket until then. The status has the reason and the notice.
          this.link?.close(); this.link = null;
          this.set({ suspendedUntil: e.until ?? this.state.suspendedUntil ?? "", directoryLink: "idle", directoryLinkError: null, friends: null, conversations: {}, dms: {}, currentPeer: null });
          void this.refreshAccountServers();
          break;
        }
        this.set({ friendsError: explainDirectoryCode(e.code) });
        break;
      // A measure of the directory's operator left a notice (or one was read on another device): read the status again.
      case "notices.changed":
        void this.refreshAccountServers();
        break;
      case "pong": case "challenge":
        break;
    }
  }
  /**
   * A direct message or a mention came in live (attention.ts). Seen at once = nothing happens; otherwise the cue sounds, and
   * what arrives while the window does not have the focus is counted for the desktop app's task bar mark until it has.
   */
  private incoming(note: () => IncomingNote, showing: boolean) {
    const visible = document.visibilityState === "visible";
    const focused = visible && document.hasFocus();
    if (seesIncoming({ visible, focused }, showing)) return;
    if (!focused) this.set({ missed: this.state.missed + 1 });
    this.onIncoming?.(note());
  }
  /** Who wrote a direct message, for its notification: the friend's name as the friends list shows it. */
  private dmNote(peer: string, text: string): IncomingNote {
    const f = this.state.friends?.find((x) => x.publicKey === peer);
    return { kind: "dm", peer, from: f ? f.displayName ?? `@${f.handle}` : `${peer.slice(0, 8)}…`, text: notificationBody(text) };
  }
  /** Server, channel and author of a message that mentions the user, with mention tokens as names. */
  private mentionNote(host: string, message: { channelId: string; authorId: string; content: string }): IncomingNote {
    const server = this.conns.get(host)?.state.server ?? null;
    const names = new Map((server?.members ?? []).map((m) => [m.userId.toLowerCase(), m.displayName] as const));
    return {
      kind: "mention", host, channelId: message.channelId,
      server: server?.settings.name ?? host,
      channel: server?.channels.find((c) => c.id === message.channelId)?.name ?? "?",
      from: names.get(message.authorId.toLowerCase()) ?? t("chat.formerMember"),
      text: notificationBody(message.content, names),
    };
  }
  /** The window has the focus again. */
  clearMissed() { if (this.state.missed !== 0) this.set({ missed: 0 }); }
  openHome(open = true) { this.set({ homeOpen: open, friendsError: null }); }
  /** Open a conversation with a friend: home view, load the history, report it as read. */
  selectPeer(peer: string) {
    this.set({ homeOpen: true, currentPeer: peer, friendsError: null });
    if (!this.state.dms[peer]?.loaded) void this.loadDmHistory(peer);
    this.markDmRead(peer);
  }
  markDmRead(peer: string) {
    const c = this.state.conversations[peer];
    if (!c || c.unread === 0) return;
    this.set({ conversations: { ...this.state.conversations, [peer]: { ...c, unread: 0 } } });
    this.link?.send({ type: "dm.read", peer, seq: c.lastSeq });
  }
  async loadDmHistory(peer: string, older = false) {
    const t = this.thread(peer);
    if (t.loading || (older && !t.hasMore)) return;
    this.setThread(peer, { ...t, loading: true });
    const before = older ? t.list[0]?.seq : undefined;
    if (!this.link?.send({ type: "dm.history", peer, ...(before !== undefined ? { before } : {}) })) this.setThread(peer, { ...t, loading: false });
  }
  private friendAction(type: "friends.request" | "friends.accept" | "friends.decline" | "friends.remove" | "friends.block" | "friends.unblock", publicKey: string) {
    this.set({ friendsError: null });
    if (!this.link?.send({ type, publicKey })) this.set({ friendsError: "Keine Verbindung zum Verzeichnis." });
  }
  requestFriend(publicKey: string) { this.friendAction("friends.request", publicKey); }
  acceptFriend(publicKey: string) { this.friendAction("friends.accept", publicKey); }
  declineFriend(publicKey: string) { this.friendAction("friends.decline", publicKey); }
  removeFriend(publicKey: string) { this.leavePeer(publicKey); this.friendAction("friends.remove", publicKey); }
  /** Blocking a friend (or anybody with a directory account) is the block of stage 3 with the directory told as well (`setBlocked`). */
  blockFriend(publicKey: string, name = "") { this.setBlocked(null, publicKey, true, { name, directory: true }); }
  /** An open conversation with somebody who is no friend any more closes: the home view shows its start page. */
  private leavePeer(publicKey: string) { if (this.state.currentPeer === publicKey) this.set({ currentPeer: null }); }
  unblockFriend(publicKey: string) { this.setBlocked(null, publicKey, false, { directory: true }); }

  // ---------- Blocked people (blocked.ts, docs/features/reports.md stage 3, 27 September 2026)
  /** The people blocked by the identity used on `host` (its server account's list, else the main identity's); null = the main identity. */
  blockedFor(host: string | null): readonly string[] {
    const owner = host ? this.identityFor(host) : this.state.identity;
    return owner ? this.state.blocked[owner.publicKey] ?? [] : [];
  }
  /**
   * Block or unblock a person for the identity used on `host` (null = the main identity). Blocking is this client's view:
   * their messages fold, their voice is silent here, their mentions do not count; no server learns it. `directory` = the person
   * has a directory account, so the directory is told as well: `friends.block` keeps their requests out and ends a friendship,
   * `friends.unblock` lifts that. `name` is kept on this device for the settings' list.
   */
  setBlocked(host: string | null, publicKey: string, blocked: boolean, opts: { name?: string; directory?: boolean } = {}): void {
    const owner = host ? this.identityFor(host) : this.state.identity;
    const key = publicKey.toLowerCase();
    if (!owner || key === owner.publicKey) return;
    const list = this.state.blocked[owner.publicKey] ?? [];
    const next = withBlocked(list, key, blocked);
    if (!sameBlocked(list, next)) this.storeBlockedList(owner.publicKey, next, blocked && opts.name ? { key, name: opts.name } : null);
    if (owner.publicKey !== this.state.identity?.publicKey || !opts.directory || !this.link) return;
    if (blocked) { this.leavePeer(key); this.friendAction("friends.block", key); }
    else if (this.friendState(key) === "blocked") this.friendAction("friends.unblock", key);
  }
  /** The list of one identity as it is now: stored, shown, the servers' marks counted again, and the main identity's pushed to the account. */
  private storeBlockedList(owner: string, list: string[], name: { key: string; name: string } | null = null): void {
    const all = { ...this.state.blocked };
    if (list.length > 0) all[owner] = list; else delete all[owner];
    saveBlockedLists(all);
    saveBlockedName(name?.key ?? "", name?.name ?? "", all);
    this.set({ blocked: all });
    for (const [host, conn] of this.conns) if (this.identityFor(host)?.publicKey === owner) conn.refreshMarks();
    if (owner === this.state.identity?.publicKey && this.sealedSupported && this.settingsLoaded && !sameBlocked(list, this.accountBlocked)) this.scheduleSettingsPush();
  }
  /** A key that is gone (a server account forgotten, the identity replaced) takes its list along. */
  private forgetBlockedOf(owner: string): void {
    if (!this.state.blocked[owner]) return;
    const all = { ...this.state.blocked }; delete all[owner];
    saveBlockedLists(all); saveBlockedName("", "", all);
    this.set({ blocked: all });
  }
  /**
   * Encrypt and send a direct message; it is displayed via the directory's echo (dm.message). Links get their previews
   * first (dmPreviews.ts): made here, by the sender, and sent inside the encrypted message.
   */
  async sendDm(peer: string, text: string) {
    const id = this.state.identity;
    if (!id) return;
    const msgId = crypto.randomUUID();
    const key = await this.dmKey(peer);
    // Switched off (Einstellungen > Ansicht): the links are never looked up, neither here nor at the directory.
    const previews = loadVoiceSettings().dmLinkPreviews ? await buildDmPreviews(text, this.previewDeps()).catch(() => []) : [];
    let sealed = await sealDm(key, id.publicKey, peer, msgId, previews.length > 0 ? { text, previews } : { text });
    // A long text plus long descriptions may not fit into one message: the text matters, the previews go.
    if (sealed.ciphertext.length > DM_MAX_CIPHERTEXT_CHARS && previews.length > 0) sealed = await sealDm(key, id.publicKey, peer, msgId, { text });
    if (!this.link?.send({ type: "dm.send", to: peer, id: msgId, ...sealed, sentAt: new Date().toISOString() })) throw new Error(t("dir.noLink"));
  }
  /** Who looks a link up and where the picture goes: the desktop app asks the linked host itself, a browser asks the directory. */
  private previewDeps(): PreviewDeps {
    const id = this.state.identity!; const url = this.state.directoryUrl;
    const viaDirectory = url && this.dmPreviewsAtDirectory;
    return {
      lookUp: async (request) => {
        if (platform.links.lookUp) {
          const found = await platform.links.lookUp(request);
          return found.found ? { kind: found.kind, siteName: found.siteName, title: found.title, description: found.description, image: found.image ? { mime: found.image.mime, bytes: found.image.data } : null } : null;
        }
        if (!viaDirectory) return null;
        const found = await api.directoryLinkLookup(url, id, request);
        if (!found.found || !found.kind) return null;
        return { kind: found.kind, siteName: found.siteName ?? null, title: found.title ?? null, description: found.description ?? null, image: found.image ? { mime: found.image.mime, bytes: base64ToBytes(found.image.data) } : null };
      },
      shrink: shrinkPreviewImage,
      putBlob: viaDirectory ? (ciphertext) => api.directoryPutDmBlob(url, id, ciphertext) : null,
    };
  }
  /** The author takes a preview of their message away, for both sides: an encrypted instruction (dm.ts `DmControl`), shown as nothing. */
  async removeDmPreview(peer: string, messageId: string, url: string) {
    const id = this.state.identity;
    if (!id) return;
    const msgId = crypto.randomUUID();
    const sealed = await sealDm(await this.dmKey(peer), id.publicKey, peer, msgId, { text: "", control: { type: "preview.remove", id: messageId, url } });
    if (!this.link?.send({ type: "dm.send", to: peer, id: msgId, ...sealed, sentAt: new Date().toISOString() })) throw new Error(t("dir.noLink"));
  }
  /** Ciphertext of a preview's picture from the directory's blob store. */
  fetchDmBlob(blobId: string): Promise<Uint8Array> {
    const url = this.state.directoryUrl;
    return url ? api.directoryDmBlob(url, blobId) : Promise.reject(new Error("no directory"));
  }
  deleteDm(peer: string, id: string) { this.link?.send({ type: "dm.delete", peer, id }); }
  /**
   * Report a friend's direct message to the directory's operator (docs/features/reports.md, stage 4): the reported message
   * in plain text and, with `withContext`, the messages before it (dmReports.ts). Throws with a readable message.
   */
  async reportDm(peer: string, messageId: string, withContext: boolean, reason: ReportReason, text: string | undefined): Promise<void> {
    const id = this.state.identity, url = this.state.directoryUrl;
    if (!id || !url) throw new Error(t("dir.noLink"));
    const content = dmReportContent(this.state.dms[peer]?.list ?? [], messageId, withContext ? DM_REPORT_CONTEXT_MAX : 0);
    if (!content) throw new Error(t("report.dmUnreadable"));
    await api.directoryReportDm(url, id, { kind: "dm", reason, text, peer, message: content.message, context: content.context });
  }
  /**
   * Report a directory account as it shows (name, picture) to the directory's operator; the directory keeps its own copy of
   * both. Throws with a readable message.
   */
  async reportAccount(publicKey: string, reason: ReportReason, text: string | undefined): Promise<void> {
    const id = this.state.identity, url = this.state.directoryUrl;
    if (!id || !url) throw new Error(t("dir.noLink"));
    await api.directoryReport(url, id, { kind: "account", reason, text, account: publicKey });
  }
  /**
   * Report a chat server to the directory's operator, by its host. `evidence`: one message of that server as this client
   * shows it, for a report that is passed on because the server's moderators do nothing or are the problem (the receiver's
   * choice in the report dialog). Throws with a readable message.
   */
  async reportServer(host: string, reason: ReportReason, text: string | undefined, evidence: ServerReportEvidence | null): Promise<void> {
    const id = this.state.identity, url = this.state.directoryUrl;
    if (!id || !url) throw new Error(t("dir.noLink"));
    await api.directoryReport(url, id, { kind: "server", reason, text, host: host.trim().toLowerCase(), evidence });
  }
  /** "Verstanden" under a notice: marked as read in the account, so it shows as read on every device. */
  async readNotice(noticeId: string): Promise<void> {
    const id = this.state.identity, url = this.state.directoryUrl;
    if (!id || !url) throw new Error(t("dir.noLink"));
    try { this.set({ notices: await api.directoryReadNotice(url, id, noticeId) }); }
    catch (err) { throw new Error(api.explainDirectoryError(err)); }
  }
  /** Whether the account's suspension lies ahead ("" = suspended, the directory named no date). */
  private isSuspended(): boolean {
    const until = this.state.suspendedUntil;
    return until !== null && (until === "" || Date.parse(until) > Date.now());
  }
  clearDm(peer: string) { this.link?.send({ type: "dm.clear", peer }); }
  /** Handle search at the directory (prefix); errors are no big deal here, they just mean no hits. */
  searchHandles(q: string) { const url = this.state.directoryUrl; return url ? api.directorySearchHandles(url, q).catch(() => []) : Promise.resolve([]); }
  /** State of a key in my friends list; null = no entry; undefined = no directory socket. */
  friendState(publicKey: string): Friend["state"] | null | undefined {
    if (!this.state.friends) return undefined;
    return this.state.friends.find((f) => f.publicKey === publicKey)?.state ?? null;
  }

  /** Server rail: fetch the account's server list from the directory (signed). Only with a handle; errors are not a sign-in problem. */
  async refreshAccountServers(): Promise<void> {
    const id = this.state.identity; const url = this.state.directoryUrl;
    if (!id || !url || !this.state.directoryAccount) {
      this.accountSettings = null;
      this.accountSealed = false; this.settingsLoaded = false; this.pushWanted = false; this.accountHidden = null; this.accountOrder = null; this.accountBlocked = null; this.accountDismissed = null;
      if (this.settingsPushTimer) { clearTimeout(this.settingsPushTimer); this.settingsPushTimer = null; }
      this.set({ accountServers: null, settingsSealed: false, accountHiddenGames: null, reportKinds: [], notices: [], suspendedUntil: null, suspendedReason: null });
      this.accountRefused = new Set();
      return;
    }
    try {
      const [status, health] = await Promise.all([api.directoryAccountStatus(url, id), api.directoryHealth(url)]);
      this.settingsSupported = health.features.settings;
      this.sealedSupported = health.features.settingsSealed;
      // The public key lookup (refreshDirectory) never carries names; the signed status does: the global display name for the settings.
      const acc = this.state.directoryAccount;
      // The account's servers the directory's operator refused stay in the rail, marked (docs/features/reports.md).
      const refusedNow = status.refusedServers.map((s) => ({ ...s, refused: true }));
      this.accountRefused = new Set(refusedNow.map((s) => this.hostFor(s.host)));
      const allowed = status.servers.filter((s) => !this.accountRefused.has(this.hostFor(s.host))).map((s) => ({ ...s, refused: false }));
      // The avatar's version comes along: an image changed on the account page shows in the settings without a reload of the lookup.
      this.set({ directoryAvatars: health.features.avatars, directoryGameLibrary: health.features.gameLibrary, ...(acc ? { directoryAccount: { ...acc, displayName: status.displayName, avatarUpdatedAt: status.avatarUpdatedAt } } : {}) });
      // Measures of the directory's operator (docs/features/reports.md): the notices, and whether the account is suspended.
      const wasSuspended = this.isSuspended();
      this.set({ reportKinds: reportKindsOf(health.features).filter((k) => k !== "dm"), notices: health.features.notices ? status.notices : [], suspendedUntil: status.suspendedUntil, suspendedReason: status.suspendedReason });
      if (this.isSuspended()) {
        // No socket while it lasts; one that is open (the suspension came a moment ago) is closed by the directory anyway.
        if (this.link) { this.link.close(); this.link = null; this.set({ directoryLink: "idle", directoryLinkError: null, friends: null, conversations: {}, dms: {}, currentPeer: null }); }
      } else if (wasSuspended) {
        // Over or lifted: friends and direct messages are back.
        void this.connectDirectory();
      }
      await this.adoptAccountSettings(status);
      // The list the rail and the connections work with: `servers` plus the refused ones, without those the user removed
      // from the rail. That list came with the account's settings just now; a removal of a server that is not refused any
      // more is dropped, here and in the account.
      const kept = shownRefused(refusedNow, this.dismissedRefused, (h) => this.hostFor(h));
      if (!sameHidden(kept.dismissed, this.dismissedRefused) || !sameHidden(kept.dismissed, this.accountDismissed)) this.storeDismissed(kept.dismissed);
      const listed = [...allowed, ...kept.shown];
      this.set({ accountServers: listed });
      // Without a home server: a server added by address that the account's list names by now is the account's from here on.
      const local = this.state.localHosts.filter((h) => !listed.some((s) => this.hostFor(s.host) === h));
      if (local.length !== this.state.localHosts.length) { this.set({ localHosts: local }); this.saveClient(); }
      this.connectAccountServers(listed);
      // What the status says about refused servers counts for the connections that exist: one refused since is closed.
      // A server of the account that the list of hashes still refuses was allowed again since that list was fetched.
      const behind = (await Promise.all(allowed.map((s) => hostRefused(this.refused, url, this.hostFor(s.host))))).some(Boolean);
      this.recheckRefused();
      if (behind) void this.refreshRefused(true);
    } catch (err) { console.warn("Serverliste vom Verzeichnis nicht verfuegbar", err); }
  }

  // ---------- Settings in the account (everything except the device selection, accountSettings.ts): the per-device copy in
  // localStorage (voice/settings.ts, the locale in i18n) stays the working copy, so servers without a directory keep working;
  // with an account the account's copy wins on load and every user change is pushed there (signed, coalesced for slider drags).
  // A directory that predates the full settings only gets the cue settings, as before.
  // Sealed settings (21 September 2026, user's wish: only the user can read them): a directory with `features.settingsSealed` gets
  // the settings as a blob encrypted with a key from the identity's seed (protocol, "Sealed settings") and nothing in the open.
  // Plaintext settings found there are sealed at once, which makes the directory delete them. The blob also carries the game
  // display's hide list, which must not be stored readable (gameDetection.ts).
  /** Account status arrived: take the account's settings over on this device, or seed the account with the local ones if it has none yet. */
  private async adoptAccountSettings(status: AccountStatus): Promise<void> {
    const id = this.state.identity;
    let remote = this.settingsSupported ? status.settings : null;
    let sealed = false; let hidden: string[] | null = null; let order: string[] | null = null; let blocked: string[] | null = null; let dmPreviews: boolean | null = null; let dismissed: string[] | null = null;
    const blob = this.sealedSupported ? status.settingsSealed : null;
    if (id && blob) {
      const content = await this.settingsKeyOf(id).then((key) => openSettings(key, id.publicKey, blob), () => null);
      if (this.state.identity !== id) return;
      // A blob this key does not open counts as none: the device's settings make a new one.
      if (content) { remote = content.settings; hidden = content.hiddenGames ?? null; order = content.serverOrder ?? null; blocked = content.blockedUsers ?? null; dmPreviews = content.dmLinkPreviews ?? null; dismissed = content.hiddenServers ?? null; sealed = true; }
    }
    const first = !this.settingsLoaded;
    this.accountSealed = sealed; this.accountHidden = hidden; this.accountOrder = order; this.accountBlocked = blocked; this.accountDmPreviews = dmPreviews; this.accountDismissed = dismissed; this.settingsLoaded = true;
    // A change the user just made here is newer than what the status says; the pending push brings the account in step.
    if (this.settingsPushTimer || this.pushWanted) {
      // The hide list too, with one exception: a push that waited for this first status knows nothing of the account's list
      // yet and must not drop from it what another device hid. The block list the same way.
      if (first && hidden && this.localHidden) this.localHidden = [...new Set([...this.localHidden, ...hidden])];
      if (first && blocked && id) { const mine = this.state.blocked[id.publicKey] ?? []; const joined = [...new Set([...mine, ...blocked])]; if (!sameBlocked(mine, joined)) this.storeBlockedList(id.publicKey, joined); }
      if (first && dismissed) { this.dismissedRefused = [...new Set([...this.dismissedRefused, ...dismissed])]; saveDismissedRefused(this.dismissedRefused); }
      if (sealed !== this.state.settingsSealed) this.set({ settingsSealed: sealed });
      if (!this.settingsPushTimer) this.scheduleSettingsPush(0);
      return;
    }
    // The device's list is merged with the account's by the game detection; until App.tsx reports the result, the account's goes out.
    if (hidden && !sameHiddenGames(this.localHidden, hidden)) this.localHidden = null;
    if (sealed !== this.state.settingsSealed || (hidden === null) !== (this.state.accountHiddenGames === null) || !sameHiddenGames(hidden, this.state.accountHiddenGames)) this.set({ settingsSealed: sealed, accountHiddenGames: hidden });
    let local = loadVoiceSettings();
    // The server rail's order from the blob: the account's wins on this device (a device that reordered just now is the pending-push case above).
    if (order && !sameServerOrder(order, local.serverOrder)) { local = { ...local, serverOrder: order }; saveVoiceSettings(local, "directory"); }
    // The switch for link previews in direct messages the same way.
    if (dmPreviews !== null && dmPreviews !== local.dmLinkPreviews) { local = { ...local, dmLinkPreviews: dmPreviews }; saveVoiceSettings(local, "directory"); }
    // The blocked people the same way: the account's list wins on this device; a device that blocked somebody just now is the pending-push case.
    if (blocked && id && !sameBlocked(blocked, this.state.blocked[id.publicKey])) this.storeBlockedList(id.publicKey, blocked);
    // The refused servers removed from the rail the same way (refreshAccountServers goes on with this list).
    if (dismissed && !sameHidden(this.dismissedRefused, dismissed)) { this.dismissedRefused = dismissed; saveDismissedRefused(dismissed); }
    if (!remote) {
      // Nothing stored yet (or an older directory): cue settings stored by an older client still win, the rest is seeded from this device.
      const sounds = status.soundSettings ? normalizeSoundSettings({ ...status.soundSettings, message: status.soundSettings.message ?? local.sounds.message }) : null;
      if (sounds && !sameSoundSettings(local.sounds, sounds)) saveVoiceSettings({ ...local, sounds }, "directory");
      this.accountSettings = sounds && !this.settingsSupported ? this.localAccountSettings() : null;
      this.scheduleSettingsPush(0);
      return;
    }
    this.accountSettings = remote;
    if (!sameAccountSettings(toAccountSettings(local, remote.locale), remote, true)) saveVoiceSettings(applyAccountSettings(local, remote), "directory");
    // Settings still in the open, or a hide list, a server order or a block list the account lacks: the push seals them.
    if (this.sealedSupported && (!sealed || !sameHiddenGames(this.hiddenForAccount(), hidden) || !sameServerOrder(order ?? [], local.serverOrder) || !sameBlocked(this.mainBlocked(), blocked) || dmPreviews !== local.dmLinkPreviews)) this.scheduleSettingsPush(0);
    // Language: a choice made on this device since it was last in step with the account (login footer) wins and is pushed;
    // otherwise the account's applies, with a reload only when the texts actually change.
    const pref = localePreference(); const synced = accountLocalePreference();
    if (remote.locale === pref) { markAccountLocalePreference(pref); return; }
    if (synced !== null && pref !== synced) { this.scheduleSettingsPush(0); return; }
    storeLocalePreference(remote.locale);
    markAccountLocalePreference(remote.locale);
    this.reloadForLocale();
  }
  private localAccountSettings(): AccountSettings { return toAccountSettings(loadVoiceSettings(), localePreference()); }
  private hiddenForAccount(): string[] | null { return this.localHidden ?? this.accountHidden; }
  /** The main identity's blocked people, the part of the block lists that may follow the account. */
  private mainBlocked(): string[] { return this.state.identity ? this.state.blocked[this.state.identity.publicKey] ?? [] : []; }
  private settingsKeyOf(id: Identity): Promise<CryptoKey> {
    if (this.settingsKey?.publicKey !== id.publicKey) this.settingsKey = { publicKey: id.publicKey, key: deriveSettingsKey(id.privateKey, id.publicKey) };
    return this.settingsKey.key;
  }
  /**
   * The game display's hide list of this device, the part that may follow the account (App.tsx, from the game detection;
   * null = this client keeps none). It only ever travels inside the sealed settings.
   */
  setLocalHiddenGames(ids: string[] | null): void {
    this.localHidden = ids;
    if (this.sealedSupported && this.settingsLoaded && !sameHiddenGames(this.hiddenForAccount(), this.accountHidden)) this.scheduleSettingsPush();
  }
  private scheduleSettingsPush(delayMs = 800): void {
    if (!this.state.identity || !this.state.directoryUrl || !this.state.directoryAccount) return;
    if (this.settingsPushTimer) clearTimeout(this.settingsPushTimer);
    this.settingsPushTimer = setTimeout(() => { this.settingsPushTimer = null; void this.pushSettings(); }, delayMs);
  }
  private async pushSettings(): Promise<void> {
    const id = this.state.identity; const url = this.state.directoryUrl;
    if (!id || !url || !this.state.directoryAccount) return;
    // Before the account's status was read, nobody knows what the directory can do or what a push would overwrite (the hide list).
    if (!this.settingsLoaded) { this.pushWanted = true; return; }
    this.pushWanted = false;
    const next = this.localAccountSettings(); const known = this.accountSettings;
    try {
      if (this.sealedSupported) {
        const local = loadVoiceSettings(); const hidden = this.hiddenForAccount(); const order = local.serverOrder; const blocked = this.mainBlocked(); const dmLinkPreviews = local.dmLinkPreviews; const hiddenServers = this.dismissedRefused;
        if (this.accountSealed && known && sameAccountSettings(known, next) && sameHiddenGames(hidden, this.accountHidden) && sameServerOrder(order, this.accountOrder ?? []) && sameBlocked(blocked, this.accountBlocked) && dmLinkPreviews === this.accountDmPreviews && sameHidden(hiddenServers, this.accountDismissed)) return;
        // The block list always goes along, an empty one too: "nobody" must win over a device's stale list after an unblock elsewhere
        // (only a blob from before the feature says nothing about it). The refused servers removed from the rail the same way.
        const blob = await sealSettings(await this.settingsKeyOf(id), id.publicKey, { settings: next, ...(hidden ? { hiddenGames: hidden } : {}), ...(order.length ? { serverOrder: order } : {}), blockedUsers: blocked, dmLinkPreviews, hiddenServers });
        await api.directorySetSealedSettings(url, id, blob);
        markAccountLocalePreference(next.locale);
        this.accountSealed = true; this.accountHidden = hidden; this.accountOrder = order; this.accountBlocked = blocked; this.accountDmPreviews = dmLinkPreviews; this.accountDismissed = hiddenServers;
        this.set({ settingsSealed: true, accountHiddenGames: hidden });
      } else if (this.settingsSupported) {
        if (known && sameAccountSettings(known, next)) return;
        await api.directorySetSettings(url, id, next);
        markAccountLocalePreference(next.locale);
      } else {
        if (known && sameSoundSettings(known.sounds, next.sounds)) return;
        await api.directorySetSoundSettings(url, id, next.sounds);
      }
      this.accountSettings = next;
      if (this.state.settingsSyncError) this.set({ settingsSyncError: null });
    } catch (err) { this.set({ settingsSyncError: api.explainDirectoryError(err) }); }
  }

  /**
   * Game display: what goes out about the running game (App.tsx computes it, gamePresence.ts). The directory always hears it
   * (friends see it); the chat servers only when the user shows it to their members too. The store stays free of the platform:
   * the detection lives in App.tsx.
   */
  setGame(game: GamePresence | null, onServers: boolean): void {
    this.game = game;
    this.gameOnServers = onServers;
    for (const conn of this.conns.values()) conn.setGame(onServers ? game : null);
    this.link?.setGame(game);
  }

  /** Change the UI language: stored on this device, saved in the account first (the reload would cut a pending push off), then reload. */
  async setLocale(pref: LocalePreference): Promise<void> {
    storeLocalePreference(pref);
    if (this.settingsPushTimer) { clearTimeout(this.settingsPushTimer); this.settingsPushTimer = null; }
    await this.pushSettings();
    this.reloadForLocale();
  }

  /** Whether a voice connection is running (App.tsx sets it): a reload would throw the user out of their channel. */
  voiceActive: () => boolean = () => false;

  /**
   * The texts follow a language change through a reload (i18n/index.ts). Not while the user sits in a voice channel (user's
   * requirement, 18 September 2026: "Wenn ich die Sprache in meinem Client ändere möchte ich nicht aus Sprachkanälen
   * geschmissen werden"): the choice is stored, the settings say so, and App.tsx calls `applyPendingLocale` once voice ended.
   */
  private reloadForLocale(): void {
    if (detectLocale() === locale) { if (this.state.localeReloadPending) this.set({ localeReloadPending: false }); return; }
    if (this.voiceActive()) { this.set({ localeReloadPending: true }); return; }
    window.location.reload();
  }
  applyPendingLocale(): void {
    if (this.state.localeReloadPending) this.reloadForLocale();
  }

  /**
   * Register a handle at the directory (M6a). With `directoryEmailRequired` in two calls: with `email` the directory mails a
   * code (result `{ sentTo }`, the masked address), with `email` and `emailCode` it creates the account.
   */
  async registerHandle(handle: string, email?: string, emailCode?: string): Promise<"done" | "failed" | { sentTo: string }> {
    const id = this.state.identity; const url = this.state.directoryUrl;
    if (!id || !url) return "failed";
    this.set({ directoryError: null });
    try {
      const res = await api.directoryRegister(url, id, handle, email, emailCode);
      if ("emailPending" in res) return { sentTo: res.sentTo };
      this.set({ directoryAccount: res });
      return "done";
    } catch (err) {
      this.set({ directoryError: api.explainDirectoryError(err) });
      return "failed";
    }
  }

  /**
   * M6b: sign-in with handle + password. Fetches the key from the directory, replaces the device key, then signs in normally.
   * M6c: with an active authenticator the first attempt throws `totp_required`; the login screen then asks for the code.
   */
  async loginWithHandle(handle: string, password: string, invite?: string, code?: string): Promise<void> {
    const url = this.state.directoryUrl; const home = this.home;
    if (!url || !home) return;
    home.state = { ...home.state, connection: "logging-in", error: null, removed: null };
    this.set({ servers: { ...this.state.servers, [home.state.host]: home.state } });
    let id: Identity;
    try { id = await api.directoryRestore(url, handle, password, code); }
    catch (err) {
      const errCode = err instanceof api.ApiError ? err.code : null;
      // totp_required is not an error but the next step: keep the message neutral.
      home.state = { ...home.state, connection: errCode === "totp_required" ? "idle" : "error", error: api.explainDirectoryError(err) };
      this.set({ servers: { ...this.state.servers, [home.state.host]: home.state } });
      throw restoreError(err);
    }
    this.closeAllForeign(true);
    home.close();
    home.api.setToken(null);
    this.forgetAllTokens();
    // The own server now signs in with the directory account, not with a server account it may have had here.
    if (this.serverAccount(home.state.host)) this.dropServerAccount(home.state.host);
    storeIdentity(id);
    this.set({ identity: id, directoryAccount: undefined });
    void this.refreshDirectory();
    await this.login(invite);
  }

  /**
   * Your display name on the server shown (mini profile and settings). With a directory account the directory holds it (as this
   * server's entry, cleared when it equals the global name) and the server adopts it; without one only the server stores it.
   * null = fall back to the global name. Throws on errors (message translated where it comes from the directory).
   */
  async setServerDisplayName(displayName: string | null): Promise<void> {
    const conn = this.active; const acc = this.state.directoryAccount;
    if (!conn) return;
    // Only a domain this client verified (signDomainOf): the per-server name belongs to the host we are really connected to.
    const domain = conn.state.host === this.homeHost ? conn.state.serverDomain : conn.state.serverDomain === connectedHost(conn.state.base) ? conn.state.serverDomain : null;
    const global = acc?.displayName ?? null;
    if (acc && domain) await this.setDirectoryName(domain, displayName === global ? null : displayName);
    await conn.updateDisplayName(displayName ?? global);
  }

  /** Set the display name in the directory (server = null: global, otherwise this server); throws on errors (message translated). */
  async setDirectoryName(server: string | null, displayName: string | null): Promise<void> {
    const id = this.state.identity; const url = this.state.directoryUrl;
    if (!id || !url) throw new Error(t("dir.none"));
    try { await api.directorySetDisplayName(url, id, server, displayName); }
    catch (err) { throw new Error(api.explainDirectoryError(err)); }
    const acc = this.state.directoryAccount;
    if (acc && server === null) this.set({ directoryAccount: { ...acc, displayName } });
  }

  /**
   * Store (null = remove) the avatar of the directory account: the image the settings dialog cropped and encoded (avatarImage.ts),
   * signed, uploaded. The own account's state is updated at once; the chat servers get the directory's push and broadcast the
   * member list, friends get a `friends.update`. Throws with a translated message.
   */
  async setAvatar(image: AvatarImage | null): Promise<void> {
    // A server account keeps its picture on its server (docs/features/local-accounts.md); the member list follows by broadcast.
    const conn = this.active;
    if (conn?.state.me?.localHandle && !conn.state.me.handle) {
      try { await conn.api.setLocalAvatar(image); }
      catch (err) { throw new Error(api.explainLocalError(err)); }
      await conn.refreshMe();
      return;
    }
    const id = this.state.identity; const url = this.state.directoryUrl;
    if (!id || !url || !this.state.directoryAccount) throw new Error(t("dir.none"));
    let res: Awaited<ReturnType<typeof api.directorySetAvatar>>;
    try { res = await api.directorySetAvatar(url, id, image); }
    catch (err) { throw new Error(api.explainDirectoryError(err)); }
    const acc = this.state.directoryAccount;
    if (acc) this.set({ directoryAccount: { ...acc, avatarUpdatedAt: res.avatarUpdatedAt } });
  }

  /**
   * Delete your account on a chat server (rail context menu): the signed request goes to the directory, which notifies the
   * server. If it confirmed (`delivered`), the own server has already closed our socket with 4012 (login screen with a message);
   * a foreign server is closed here and its session forgotten. Throws with a translated message.
   */
  async leaveServer(directoryHost: string): Promise<ServerLeaveResponse> {
    const id = this.state.identity; const url = this.state.directoryUrl;
    if (!id || !url) throw new Error(t("dir.none"));
    let r: ServerLeaveResponse;
    try { r = await api.directoryLeaveServer(url, id, directoryHost); }
    catch (err) { throw new Error(api.explainDirectoryError(err)); }
    if (r.delivered) {
      const key = this.hostFor(directoryHost);
      if (key === this.homeHost) this.home?.accountDeleted();
      else { this.closeServer(key); this.storeToken(key, null); }
    }
    void this.refreshAccountServers();
    return r;
  }

  /** M6b: store a password backup of the device key at the directory. */
  async createBackup(password: string): Promise<boolean> {
    const id = this.state.identity; const url = this.state.directoryUrl;
    if (!id || !url) return false;
    this.set({ directoryError: null });
    try {
      await api.directoryBackupUpload(url, id, password);
      const acc = this.state.directoryAccount;
      if (acc) this.set({ directoryAccount: { ...acc, hasBackup: true } });
      return true;
    } catch (err) {
      this.set({ directoryError: api.explainDirectoryError(err) });
      return false;
    }
  }

  /** Sign in on your own server (signature over the hostname in the address bar = PUBLIC_DOMAIN), optionally with an invite. */
  async login(invite?: string): Promise<void> {
    await this.home?.login(this.signDomain, invite);
  }

  /** Sign out: all servers (the client hangs off your own server's session). */
  logout() {
    const home = this.home;
    if (home) {
      this.closeAllForeign();
      home.logout();
      // A server account of the own server: its key goes with the session (name and password bring it back).
      if (this.serverAccount(home.state.host)) this.dropServerAccount(home.state.host);
      return;
    }
    // No home server: the client's own login ends, with every session on the servers and the keys of the server accounts
    // (name and password bring them back; a shared computer keeps nothing).
    for (const conn of this.conns.values()) conn.logout();
    this.conns.clear();
    this.forgetAllTokens();
    for (const [host, acc] of Object.entries(loadServerAccounts())) { forgetServerAccount(host); this.forgetBlockedOf(acc.publicKey); }
    this.set({ serverAccounts: {} });
    this.lastHost = null; this.entered = false; this.startTarget = null;
    this.set({ servers: {}, activeHost: null, signedIn: false, localHosts: [], joinInvites: {}, clientLogin: { busy: false, error: null } });
    this.saveClient();
    void this.connectDirectory();
  }

  async forgetIdentity() {
    this.logout();
    this.link?.close(); this.link = null;
    this.forgetAllTokens();
    const { forgetIdentity } = await import("./identity");
    const old = this.state.identity;
    forgetIdentity();
    if (old) this.forgetBlockedOf(old.publicKey);
    this.set({ identity: await loadOrCreateIdentity(), directoryAccount: undefined });
    void this.refreshDirectory();
  }
}

/** Turns error codes from the directory socket (M7) into sentences. */
function explainDirectoryCode(code: string): string {
  switch (code) {
    case "self": case "unknown_account": case "not_friends": case "blocked": case "declined_recently": case "rate_limited": case "too_large": case "duplicate": case "not_found":
      return t(`dirws.${code}`);
    default: return t("dirws.default", { code });
  }
}
