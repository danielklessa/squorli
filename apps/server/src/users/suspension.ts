import { WS_CLOSE_ACCOUNT_SUSPENDED, suspendedCloseReason } from "@squorli/protocol";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db";
import { localAccounts, users } from "../db/schema";
import type { Hub } from "../hub";
import type { LivekitAdmin } from "../livekit/admin";
import type { VoicePresence } from "../voice/presence";

/**
 * Suspended directory accounts (docs/features/reports.md, 27 September 2026; the user's decisions 8 to 11 of
 * docs/PLAN-reports.md). The directory's operator can suspend an account for a time; the directory tells its registered
 * chat servers (`DirectoryAccount.suspendedUntil`, with the server's token only), and this server refuses such an account
 * until the suspension ends, unless its operator switched that off (`server_settings.refuse_suspended`, on by default).
 *
 * What "refuses" means: no sign-in (403 `account_suspended` with the date), no request with a session of that user (the
 * same answer), no WebSocket (an `unauthorized` error whose message carries the date, then close 4014), and whoever is
 * connected when the server learns of the suspension is disconnected and leaves their voice channel. The sessions
 * themselves stay: they work again when the suspension ends or is lifted, without a new sign-in.
 * Server accounts (`~name`) have no directory account and are never concerned. The cached date counts while the directory
 * cannot be reached.
 */
export const isSuspendedNow = (until: Date | null | undefined, now: number = Date.now()): until is Date => !!until && until.getTime() > now;

/** The end of the suspension this server refuses the user for, or null: a directory account (no server account) that is suspended, while the switch is on. */
export function refusedUntil(u: { handle: string | null; localHandle: string | null; suspendedUntil: Date | null }, refuse: boolean, now: number = Date.now()): Date | null {
  if (!refuse || !u.handle || u.localHandle) return null;
  return isSuspendedNow(u.suspendedUntil, now) ? u.suspendedUntil : null;
}

/** What a refused request answers: 403 with this body. */
export const suspendedBody = (until: Date) => ({ error: "account_suspended", until: until.toISOString() });

type Log = { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void };

export class Suspensions {
  constructor(private readonly db: Db, private readonly hub: Hub, private readonly presence: VoicePresence, private readonly lk: LivekitAdmin, private readonly refuse: () => Promise<boolean>, private readonly log: Log) {}

  /** The server learned that this user is suspended: end their connections and their seat in a voice channel (when the switch is on). */
  async enforce(userId: string, until: Date): Promise<boolean> {
    if (!isSuspendedNow(until) || !(await this.refuse())) return false;
    // A server account's key never has a directory account; a users row with both (a claim from before the fresh key) counts as the server's.
    const [local] = await this.db.select({ userId: localAccounts.userId }).from(localAccounts).where(eq(localAccounts.userId, userId)).limit(1);
    if (local) return false;
    this.disconnect(userId, until);
    return true;
  }

  /** The switch was turned on: everybody whose suspension this server already knows of. */
  async enforceKnown(): Promise<number> {
    if (!(await this.refuse())) return 0;
    const rows = await this.db.select({ id: users.id, until: users.suspendedUntil, local: localAccounts.userId }).from(users)
      .leftJoin(localAccounts, eq(localAccounts.userId, users.id))
      .where(and(isNotNull(users.handle), gt(users.suspendedUntil, sql`now()`)));
    let n = 0;
    for (const r of rows) if (!r.local && r.until) { this.disconnect(r.id, r.until); n++; }
    return n;
  }

  private disconnect(userId: string, until: Date): void {
    const channelId = this.presence.channelOfUser(userId);
    this.presence.leaveUser(userId);
    // The event first: a client from before the suspension stops on `unauthorized` (it would reconnect on a close code it
    // does not know); a client that knows it reads the date from the message.
    this.hub.disconnectUser(userId, { type: "error", code: "unauthorized", message: suspendedCloseReason(until.toISOString()) }, WS_CLOSE_ACCOUNT_SUSPENDED);
    // Voice is a connection of its own (LiveKit): the client hangs up when its socket goes, the server makes sure.
    if (channelId) this.lk.removeParticipant(channelId, userId).catch((err) => this.log.warn({ err: err instanceof Error ? err.message : String(err), userId }, "Sperre: LiveKit-Teilnehmer nicht entfernt"));
    this.log.info({ userId, until: until.toISOString() }, "Gesperrtes Verzeichniskonto getrennt");
  }
}
