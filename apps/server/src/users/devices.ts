import { DEVICE_IDLE_MS, DEVICE_MAX, WS_CLOSE_SESSION_ENDED, type DeviceInfo } from "@squorli/protocol";
import * as ed from "@noble/ed25519";
import { and, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { WebSocket } from "ws";
import type { Db } from "../db";
import { localAccounts, localDevices, sessions } from "../db/schema";
import type { Hub } from "../hub";
import type { LivekitAdmin } from "../livekit/admin";
import type { VoicePresence } from "../voice/presence";

/**
 * Devices (docs/features/devices.md, 29 September 2026; the contract: the protocol's directory.ts, "Devices"). Until then
 * signing a device out deleted its session, and the device signed in again with the account's key, which every device of
 * an account holds. Now every sign-in names the device's own key and proves it, the session remembers it, and a session
 * counts only while its device is let in:
 *  - a directory account (`@name`): the directory decides. It tells this server whether the account lets only enrolled
 *    devices in and which device keys those are (`users.devices_enforced`, `users.device_keys`, cached like the handle).
 *  - a server account (`~name`): this server decides (`local_devices`, `local_accounts.devices_enforced_at`). A users row
 *    with both counts as the server's, as for a suspension.
 * An account that is not enforced (from before, or one that never signed a device out) lets a sign-in without a device in.
 */
export type LocalDeviceRow = typeof localDevices.$inferSelect;
export type EnrolledBy = "register" | "password" | "claim" | "legacy";
export type RevokedWhy = "user" | "self" | "replaced" | "idle";
/** A device's row is touched at most this often. */
const TOUCH_EVERY_MS = 3_600_000;
/** A row of a device that was signed out is kept this long. */
export const REVOKED_KEEP_MS = 365 * 86_400_000;

const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
/** Whether `signature` is the device key's over `message`; never throws. */
export const deviceSignatureValid = (deviceKey: string, signature: string, message: string): Promise<boolean> =>
  ed.verifyAsync(hexToBytes(signature), new TextEncoder().encode(message), hexToBytes(deviceKey)).catch(() => false);

/** What is known about the account behind a sign-in or a session. `localDevice`: the row of the device key named, if any. */
export type DeviceState = {
  handle: string | null; localHandle: string | null;
  devicesEnforced: boolean; deviceKeys: string[] | null;
  localEnforced: boolean; localDevice: "active" | "revoked" | null;
};
/** Whether a sign-in or a session with `deviceKey` (null = none) is let in (pure). */
export function deviceAllowed(u: DeviceState, deviceKey: string | null): boolean {
  if (u.localHandle) {
    if (u.localDevice === "revoked") return false;
    return !u.localEnforced || (deviceKey !== null && u.localDevice === "active");
  }
  if (u.handle && u.devicesEnforced) return deviceKey !== null && (u.deviceKeys ?? []).includes(deviceKey);
  return true;
}

const toInfo = (d: LocalDeviceRow, currentKey: string | null): DeviceInfo => ({
  id: d.id, label: d.label, origin: d.origin, kind: "client", createdAt: d.createdAt.toISOString(), lastSeenAt: d.lastSeenAt?.toISOString() ?? null, current: d.deviceKey === currentKey,
});
/** Which devices a sign-out means (pure): `target` = an id or "others"; never the asking device, which signs itself out its own way. */
export function revokeTargets(rows: Pick<LocalDeviceRow, "id" | "deviceKey" | "revokedAt">[], target: string, currentKey: string | null): string[] {
  const active = rows.filter((r) => r.revokedAt === null);
  return active.filter((r) => r.deviceKey !== currentKey && (target === "others" || r.id === target)).map((r) => r.id);
}

type Log = { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void };
export type EnrolResult = { ok: true; device: LocalDeviceRow } | { ok: false; error: "too_many_devices"; devices: DeviceInfo[] };

export class Devices {
  constructor(private readonly db: Db, private readonly hub: Hub, private readonly presence: VoicePresence<WebSocket>, private readonly lk: LivekitAdmin, private readonly log: Log) {}

  // ---- Sessions

  /**
   * End sessions whose device is no longer let in: their rows go, their sockets close with 4011 and the reason
   * `device_revoked`, and a voice seat held through such a socket ends at LiveKit too (the client hangs up by itself, the
   * server makes sure). `resolveSession` refuses such a session anyway; this closes what is open.
   */
  private async end(rows: { id: string; userId: string }[]): Promise<number> {
    for (const s of rows) {
      const seats = this.hub.socketsOfSession(s.id).map((ws) => this.presence.channelOf(ws)).filter((c): c is string => c !== undefined);
      this.hub.disconnectSession(s.id, WS_CLOSE_SESSION_ENDED, "device_revoked");
      for (const channelId of seats) this.lk.removeParticipant(channelId, s.userId).catch((err) => this.log.warn({ err: err instanceof Error ? err.message : String(err), userId: s.userId }, "Geraet abgemeldet: LiveKit-Teilnehmer nicht entfernt"));
    }
    if (rows.length > 0) this.log.info({ sessions: rows.length }, "Sitzungen abgemeldeter Geraete beendet");
    return rows.length;
  }

  /**
   * Directory accounts: the sessions of enforced accounts whose device is not among the account's keys (or that have
   * none), for one user or for all. Called when the directory told of a change and after every reconciliation.
   */
  async endRefused(userId?: string): Promise<number> {
    const rows = await this.db.execute<{ id: string; user_id: string }>(sql`
      delete from sessions s using users u
      where s.user_id = u.id and u.devices_enforced and u.handle is not null
        and not exists (select 1 from local_accounts l where l.user_id = u.id)
        and (s.device_key is null or not jsonb_exists(coalesce(u.device_keys, '[]'::jsonb), s.device_key))
        ${userId ? sql`and u.id = ${userId}` : sql``}
      returning s.id, s.user_id`);
    return this.end([...rows].map((r) => ({ id: r.id, userId: r.user_id })));
  }

  // ---- Server accounts

  async findLocal(userId: string, deviceKey: string): Promise<LocalDeviceRow | null> {
    const [row] = await this.db.select().from(localDevices).where(and(eq(localDevices.userId, userId), eq(localDevices.deviceKey, deviceKey))).limit(1);
    return row ?? null;
  }
  async activeLocal(userId: string): Promise<LocalDeviceRow[]> {
    return this.db.select().from(localDevices).where(and(eq(localDevices.userId, userId), isNull(localDevices.revokedAt)))
      .orderBy(sql`${localDevices.lastSeenAt} desc nulls last`, desc(localDevices.createdAt));
  }
  async listLocal(userId: string, currentKey: string | null): Promise<DeviceInfo[]> {
    const rows = await this.activeLocal(userId);
    return [...rows.filter((r) => r.deviceKey === currentKey), ...rows.filter((r) => r.deviceKey !== currentKey)].map((r) => toInfo(r, currentKey));
  }
  async localEnforced(userId: string): Promise<boolean> {
    const [row] = await this.db.select({ at: localAccounts.devicesEnforcedAt }).from(localAccounts).where(eq(localAccounts.userId, userId)).limit(1);
    return !!row?.at;
  }

  /**
   * Enrol a device of a server account. `strict` = the limit of DEVICE_MAX holds and one more needs `replace`, the device
   * that makes way (the password was proven); without it a device beyond the limit is simply not enrolled (null). A row of
   * this key that was signed out comes back only with `reactivate`.
   */
  async enrolLocal(userId: string, d: { deviceKey: string; label: string | null; origin: string | null; by: EnrolledBy }, opts: { strict: boolean; replace?: string | undefined; reactivate?: boolean }): Promise<EnrolResult | null> {
    const existing = await this.findLocal(userId, d.deviceKey);
    if (existing && existing.revokedAt === null) { await this.touchLocal(existing); return { ok: true, device: existing }; }
    if (existing && !opts.reactivate) return null;
    const active = await this.activeLocal(userId);
    if (active.length >= DEVICE_MAX) {
      if (!opts.strict) return null;
      const gone = opts.replace ? active.find((r) => r.id === opts.replace) : undefined;
      if (!gone) return { ok: false, error: "too_many_devices", devices: active.map((r) => toInfo(r, null)) };
      await this.signOut(userId, [gone], "replaced");
    }
    const values = { label: d.label, origin: d.origin, enrolledBy: d.by, createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null, revokedWhy: null };
    const [row] = await this.db.insert(localDevices).values({ userId, deviceKey: d.deviceKey, ...values })
      .onConflictDoUpdate({ target: [localDevices.userId, localDevices.deviceKey], set: values }).returning();
    return row ? { ok: true, device: row } : null;
  }

  async touchLocal(d: LocalDeviceRow, now: number = Date.now()): Promise<void> {
    if (d.lastSeenAt && now - d.lastSeenAt.getTime() < TOUCH_EVERY_MS) return;
    await this.db.update(localDevices).set({ lastSeenAt: new Date(now) }).where(eq(localDevices.id, d.id));
  }

  /** Mark devices as signed out and end their sessions. */
  private async signOut(userId: string, rows: LocalDeviceRow[], why: RevokedWhy): Promise<LocalDeviceRow[]> {
    if (rows.length === 0) return [];
    const gone = await this.db.update(localDevices).set({ revokedAt: new Date(), revokedWhy: why })
      .where(and(inArray(localDevices.id, rows.map((r) => r.id)), isNull(localDevices.revokedAt))).returning();
    if (gone.length === 0) return [];
    const ended = await this.db.delete(sessions).where(and(eq(sessions.userId, userId), inArray(sessions.deviceKey, gone.map((r) => r.deviceKey)))).returning({ id: sessions.id, userId: sessions.userId });
    await this.end(ended);
    return gone;
  }

  /**
   * Sign devices of a server account out: `target` = a device's id or "others". The first such sign-out makes the account
   * enforced, and from then on sessions without an enrolled device end too (those of clients from before devices).
   */
  async revokeLocal(userId: string, target: string, currentKey: string): Promise<LocalDeviceRow[]> {
    const rows = await this.db.select().from(localDevices).where(eq(localDevices.userId, userId));
    const ids = new Set(revokeTargets(rows, target, currentKey));
    const gone = await this.signOut(userId, rows.filter((r) => ids.has(r.id)), "user");
    if (gone.length === 0 && target !== "others") return gone;
    const first = await this.db.update(localAccounts).set({ devicesEnforcedAt: new Date() }).where(and(eq(localAccounts.userId, userId), isNull(localAccounts.devicesEnforcedAt))).returning({ userId: localAccounts.userId });
    if (first.length > 0) {
      const keys = (await this.activeLocal(userId)).map((r) => r.deviceKey);
      const loose = await this.db.delete(sessions).where(and(eq(sessions.userId, userId), keys.length > 0 ? or(isNull(sessions.deviceKey), notInArray(sessions.deviceKey, keys)) : undefined)).returning({ id: sessions.id, userId: sessions.userId });
      await this.end(loose);
    }
    return gone;
  }
  /** The asking device signs itself out (the client's own "Abmelden"). */
  async revokeSelf(userId: string, deviceKey: string): Promise<number> {
    const row = await this.findLocal(userId, deviceKey);
    return row ? (await this.signOut(userId, [row], "self")).length : 0;
  }

  /** Hourly: devices unused for DEVICE_IDLE_MS are signed out, rows signed out a year ago go. */
  async sweep(now: number = Date.now()): Promise<number> {
    await this.db.delete(localDevices).where(lt(localDevices.revokedAt, new Date(now - REVOKED_KEEP_MS)));
    const before = new Date(now - DEVICE_IDLE_MS);
    const idle = await this.db.select().from(localDevices).where(and(isNull(localDevices.revokedAt), or(lt(localDevices.lastSeenAt, before), and(isNull(localDevices.lastSeenAt), lt(localDevices.createdAt, before)))));
    let n = 0;
    for (const userId of new Set(idle.map((r) => r.userId))) n += (await this.signOut(userId, idle.filter((r) => r.userId === userId), "idle")).length;
    if (n > 0) this.log.info({ n }, "Geraete nach 90 Tagen ohne Nutzung abgemeldet");
    return n;
  }
}
