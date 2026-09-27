import { DIRECTORY_WS_VERSION, DirectoryServerEvent, directoryWsAuthMessage, type DirectoryClientEvent, type GamePresence } from "@squorli/protocol";
import { t } from "./i18n";
import { sign, type Identity } from "./identity";
import { connectedHost } from "./serverHost";

/**
 * Second WebSocket connection (M7): to the directory service, for friends, presence and end-to-end encrypted
 * direct messages. Sign-in without a session: the service sends a challenge, we answer with a signature from the
 * device key (bound to the directory's host). Reconnect with growing backoff; the store receives
 * every event and the connection state. Like `ServerConnection` it notices a connection that died without a close: nothing
 * arrived between two of its pings = drop the socket and connect again (18 September 2026, docs/features/afk.md).
 * A refusal that ends the connection for good (`version`, `unauthorized`, `unknown_account`, and `account_suspended`: the
 * directory's operator suspended the account, docs/features/reports.md) stops the reconnecting, and its message stays in
 * the status: the close that follows must not wipe it (until 27 September 2026 it did, and the friends view only ever said
 * "no connection").
 */
export type LinkStatus = "idle" | "connecting" | "connected" | "error";

export class DirectoryLink {
  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private ping: number | null = null;
  private delay = 1000;
  private want = false;
  /** AFK detection: the user's activity state (activity.ts), reported when the directory knows the `activity` event (features.afk). */
  private idle = false;
  /** Game display: what the user plays (store.ts), reported with the activity state; a fresh socket knows none. */
  private game: GamePresence | null = null;
  private pingSentAt = 0;
  private lastHeard = 0;
  /** The directory refused this connection for good: the status keeps saying why after the socket closed. */
  private refused = false;

  constructor(private readonly url: string, private readonly identity: Identity,
    private readonly onEvent: (e: DirectoryServerEvent) => void, private readonly onStatus: (s: LinkStatus, error?: string) => void, private readonly reportsActivity = false) {}

  /** The user turned idle or came back. The directory counts a fresh socket as active, so only `true` is repeated after a welcome. */
  setIdle(idle: boolean) {
    if (idle === this.idle) return;
    this.idle = idle;
    if (this.reportsActivity) this.send({ type: "activity", idle, game: this.game });
  }

  setGame(game: GamePresence | null) {
    if (game?.id === this.game?.id && game?.name === this.game?.name) return;
    this.game = game;
    if (this.reportsActivity) this.send({ type: "activity", idle: this.idle, game });
  }

  connect() {
    this.want = true;
    this.refused = false;
    this.onStatus("connecting");
    this.dropSocket(); // never two sockets of one client: an earlier one left open would keep the account present
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/api/ws`);
    this.ws = ws;
    ws.onmessage = (m) => {
      this.lastHeard = Date.now();
      const parsed = DirectoryServerEvent.safeParse(JSON.parse(String(m.data)));
      if (!parsed.success) return;
      const e = parsed.data;
      if (e.type === "challenge") {
        // Signed for the host this client connects to (api.ts `signingHealth`): a directory naming another one gets nothing.
        if (e.host.toLowerCase() !== connectedHost(this.url)) {
          this.want = false;
          this.dropSocket();
          this.onStatus("error", t("dir.hostMismatch", { base: this.url, host: e.host }));
          return;
        }
        void sign(this.identity, directoryWsAuthMessage(e.host, e.nonce)).then((signature) => {
          if (this.ws === ws) this.send({ type: "auth", publicKey: this.identity.publicKey, signature, version: DIRECTORY_WS_VERSION });
        });
        return;
      }
      if (e.type === "welcome") {
        this.delay = 1000;
        this.onStatus("connected");
        if (this.ping) clearInterval(this.ping);
        this.pingSentAt = 0;
        this.ping = window.setInterval(() => this.heartbeat(), 25_000);
        if ((this.idle || this.game) && this.reportsActivity) this.send({ type: "activity", idle: this.idle, game: this.game });
      }
      if (e.type === "error" && (e.code === "version" || e.code === "unauthorized" || e.code === "unknown_account" || e.code === "account_suspended")) {
        // No reconnect: the client does not match the service, the key has no account there, or the account is suspended.
        // A suspended account gets two events (the second one for clients from before the first): the first one counts.
        if (this.refused) return;
        this.want = false;
        this.refused = true;
        this.onStatus("error", e.message);
      }
      this.onEvent(e);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.ping) { clearInterval(this.ping); this.ping = null; }
      if (!this.want) { if (!this.refused) this.onStatus("idle"); return; }
      this.onStatus("connecting");
      this.timer = window.setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(30_000, this.delay * 2);
    };
  }

  /** Let go of the current socket without waiting for its close (a dead connection may take minutes to notice). */
  private dropSocket() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onmessage = ws.onclose = null;
    try { ws.close(); } catch { /* already closing */ }
    if (this.ping) { clearInterval(this.ping); this.ping = null; }
  }

  /** Every 25 s: nothing arrived since the last ping (the service answers each with `pong`) = the connection is dead. */
  private heartbeat() {
    const now = Date.now();
    // A timer that fired late (throttled or frozen page) proves nothing: answers may still be waiting behind it.
    if (this.pingSentAt && this.lastHeard < this.pingSentAt && now - this.pingSentAt < 60_000) {
      this.pingSentAt = 0;
      this.dropSocket();
      if (this.want) this.connect();
      return;
    }
    this.pingSentAt = now;
    this.send({ type: "ping", t: now });
  }

  send(e: DirectoryClientEvent): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(e));
    return true;
  }

  close() {
    this.want = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.ping) { clearInterval(this.ping); this.ping = null; }
    this.ws?.close();
    this.ws = null;
  }
}
