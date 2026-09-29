import { AFK_AFTER_MS, type GamePresence, type ServerEvent } from "@squorli/protocol";
import type { WebSocket } from "ws";

/**
 * All authenticated WebSocket connections, grouped by user.
 * Presence (online) = at least one connection. Single node, in memory.
 *
 * AFK detection: a client reports per connection when its user has been idle for AFK_AFTER_MS (`activity`); a user is AFK
 * once ALL of their connections are idle (a second tab or device in use keeps them present). When the connection in use
 * closes and only idle ones remain, the user was active a moment ago: they turn AFK AFK_AFTER_MS later, unless something
 * happens before. Presence listeners also fire when the AFK state changes (`online` stays true). A connection whose client
 * code went silent (a frozen page, ws/liveness.ts) cannot report anything: it counts as idle until the client speaks again.
 *
 * Game display (docs/features/games.md): a client may report what its user plays, per connection like the idle state; the
 * member's game is the one reported last among their connections and goes when that connection does. The server only
 * relays it (viewers ask the directory's game library), and it is independent of the AFK state. Presence listeners fire
 * when it changes.
 */
export class Hub {
  private readonly byUser = new Map<string, Set<WebSocket>>();
  private readonly userOf = new Map<WebSocket, string>();
  /** Session per connection, so a remote sign-out (M6c) closes exactly that connection. */
  private readonly sessionOf = new Map<WebSocket, string>();
  /** Connections whose client reported its user idle. */
  private readonly idle = new Set<WebSocket>();
  /** Connections that answer pings but whose client sends nothing any more (ws/liveness.ts): idle for the AFK state. */
  private readonly stale = new Set<WebSocket>();
  private readonly afk = new Set<string>();
  /** What a connection's client says its user plays; insertion order = the order of the reports, the last one counts. */
  private readonly games = new Map<WebSocket, GamePresence>();
  /** Users whose active connection just closed: not AFK before this time (ms), with the timer that looks again then. */
  private readonly grace = new Map<string, { until: number; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(userId: string, online: boolean) => void>();
  /** May this user receive events of this channel? index.ts installs the visibility snapshot's answer; until then everybody may. */
  private visible: (userId: string, channelId: string) => boolean = () => true;

  setVisibility(fn: (userId: string, channelId: string) => boolean): void { this.visible = fn; }

  onPresence(fn: (userId: string, online: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  add(userId: string, ws: WebSocket, sessionId: string) {
    let set = this.byUser.get(userId);
    const wasOnline = !!set && set.size > 0;
    if (!set) { set = new Set(); this.byUser.set(userId, set); }
    set.add(ws);
    this.userOf.set(ws, userId);
    this.sessionOf.set(ws, sessionId);
    // A new connection counts as active: somebody just opened or reloaded the client.
    const wasAfk = this.afk.delete(userId);
    if (!wasOnline || wasAfk) for (const fn of this.listeners) fn(userId, true);
  }

  remove(ws: WebSocket) {
    const userId = this.userOf.get(ws);
    if (!userId) return;
    const gameBefore = this.gameOf(userId);
    this.games.delete(ws);
    this.userOf.delete(ws);
    this.sessionOf.delete(ws);
    const wasStale = this.stale.delete(ws);
    const wasIdle = this.idle.delete(ws) || wasStale;
    const set = this.byUser.get(userId);
    set?.delete(ws);
    if (set && set.size === 0) {
      this.byUser.delete(userId);
      this.afk.delete(userId);
      this.endGrace(userId);
      for (const fn of this.listeners) fn(userId, false);
    } else if (!wasIdle) {
      // The connection in use is gone: the user was active until now, so the idle ones that remain count from here.
      this.endGrace(userId);
      const timer = setTimeout(() => { this.grace.delete(userId); this.refreshAfk(userId); }, AFK_AFTER_MS);
      timer.unref();
      this.grace.set(userId, { until: Date.now() + AFK_AFTER_MS, timer });
    }
    // The connection that reported the game is gone while the member stays online on another one.
    if (this.isOnline(userId) && !sameGame(gameBefore, this.gameOf(userId))) for (const fn of this.listeners) fn(userId, true);
  }

  /** A connection reports what its user plays (null = nothing). */
  setGame(ws: WebSocket, game: GamePresence | null) {
    const userId = this.userOf.get(ws);
    if (!userId) return;
    const before = this.gameOf(userId);
    this.games.delete(ws);
    if (game) this.games.set(ws, game);
    if (!sameGame(before, this.gameOf(userId))) for (const fn of this.listeners) fn(userId, true);
  }

  /** The game a member plays: the last report among their connections, null = none. */
  gameOf(userId: string): GamePresence | null {
    let last: GamePresence | null = null;
    for (const [ws, game] of this.games) if (this.userOf.get(ws) === userId) last = game;
    return last;
  }

  /** A connection reports its user idle (no activity for AFK_AFTER_MS) or back. */
  setIdle(ws: WebSocket, idle: boolean) {
    const userId = this.userOf.get(ws);
    if (!userId || idle === this.idle.has(ws)) return;
    if (idle) this.idle.add(ws); else this.idle.delete(ws);
    this.refreshAfk(userId);
  }

  /** The client of a connection went silent or speaks again (ws/liveness.ts). */
  setStale(ws: WebSocket, stale: boolean) {
    const userId = this.userOf.get(ws);
    if (!userId || stale === this.stale.has(ws)) return;
    if (stale) this.stale.add(ws); else this.stale.delete(ws);
    this.refreshAfk(userId);
  }

  private endGrace(userId: string) {
    const g = this.grace.get(userId);
    if (g) { clearTimeout(g.timer); this.grace.delete(userId); }
  }

  /** Recompute a user's AFK state and tell the listeners when it changed. */
  private refreshAfk(userId: string) {
    const conns = [...(this.byUser.get(userId) ?? [])];
    const all = conns.length > 0 && conns.every((ws) => this.idle.has(ws) || this.stale.has(ws)) && (this.grace.get(userId)?.until ?? 0) <= Date.now();
    if (all === this.afk.has(userId)) return;
    if (all) this.afk.add(userId); else this.afk.delete(userId);
    for (const fn of this.listeners) fn(userId, true);
  }

  isAfk(userId: string): boolean {
    return this.afk.has(userId);
  }

  afkUsers(): string[] {
    return [...this.afk];
  }

  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  onlineUserIds(): string[] {
    return [...this.byUser.keys()];
  }

  send(ws: WebSocket, e: ServerEvent) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
  }

  sendToUser(userId: string, e: ServerEvent) {
    for (const ws of this.byUser.get(userId) ?? []) this.send(ws, e);
  }

  broadcast(e: ServerEvent, except?: WebSocket) {
    const text = JSON.stringify(e);
    for (const ws of this.userOf.keys()) if (ws !== except && ws.readyState === ws.OPEN) ws.send(text);
  }

  /** Like broadcast(), but only to users who may see the channel (docs/features/channel-permissions.md). Asked once per user. */
  broadcastToChannel(channelId: string, e: ServerEvent, except?: WebSocket) {
    const text = JSON.stringify(e);
    const decided = new Map<string, boolean>();
    for (const [ws, userId] of this.userOf) {
      if (ws === except || ws.readyState !== ws.OPEN) continue;
      let ok = decided.get(userId);
      if (ok === undefined) { ok = this.visible(userId, channelId); decided.set(userId, ok); }
      if (ok) ws.send(text);
    }
  }

  /** Throw a user out: send the event, then close all of their connections. */
  disconnectUser(userId: string, e: ServerEvent, code = 4010) {
    for (const ws of [...(this.byUser.get(userId) ?? [])]) {
      this.send(ws, e);
      ws.close(code, e.type);
    }
  }

  /** Close all connections of a user with a bare close code (no event), e.g. 4012 `account_deleted` after a deletion via the directory. */
  closeUser(userId: string, code: number, reason: string) {
    for (const ws of [...(this.byUser.get(userId) ?? [])]) ws.close(code, reason);
  }

  /** The open connections of a session (users/devices.ts looks at their voice seat before it ends them). */
  socketsOfSession(sessionId: string): WebSocket[] {
    return [...this.sessionOf].filter(([, sid]) => sid === sessionId).map(([ws]) => ws);
  }

  /** Remote sign-out (M6c): close only the connections of this session. The client recognizes the code and goes to the login. */
  disconnectSession(sessionId: string, code = 4011, reason = "session_revoked") {
    for (const [ws, sid] of [...this.sessionOf]) if (sid === sessionId) ws.close(code, reason);
  }
}

const sameGame = (a: GamePresence | null, b: GamePresence | null): boolean => a?.id === b?.id && a?.name === b?.name;
