import { ChallengeResponse, DirectoryAccount, ServerLeavesResponse, ServerProbeResponse, ServerRegisterResponse, ServerResolveResponse, directoryAvatarUrl, directoryServerRegisterMessage } from "@squorli/protocol";
import * as ed from "@noble/ed25519";
import { count, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config";
import type { Db } from "./db";
import { members, serverSettings, users } from "./db/schema";
import { SETTINGS_ID } from "./state";

/** For this long the cached directory state counts as fresh; after that GET /api/me refreshes it (name changed on the account page). */
const REFRESH_AFTER_MS = 5 * 60_000;
/** Periodic reconciliation of all users (names changed on the account page arrive without a reload this way). */
/** A user's signature from a sign-in here, passed on to the directory as the proof of a membership (`chatLoginMessage`). */
export type LoginProof = { nonce: string; signature: string };

export const SYNC_INTERVAL_MS = 5 * 60_000;
const SYNC_CHUNK = 200;
const TIMEOUT_MS = 2500;

/** `suspendedUntil`: as the directory told this server, or as it was cached when the answer came without the server's token. */
export type DirectoryProfile = { handle: string | null; displayName: string | null; avatarUrl: string | null; suspendedUntil: Date | null };
/** After the directory refused this server (`server_blocked`), a lookup starts no new registration for this long. */
const BLOCKED_RETRY_MS = 3_600_000;
const suspensionOf = (acc: { suspendedUntil: string | null }): Date | null => (acc.suspendedUntil ? new Date(acc.suspendedUntil) : null);
const sameDate = (a: Date | null, b: Date | null): boolean => (a?.getTime() ?? null) === (b?.getTime() ?? null);
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/**
 * Integration with the directory service (M6). The server has its own Ed25519 key (server_settings.directory_private_key,
 * generated at startup) and registers with the directory using it: signature over host + nonce, and the directory verifies
 * via /api/health (serverKey) that the server controls its host. The issued token (kept in memory only)
 * allows reading the handle and display name of its own users (`?server=PUBLIC_DOMAIN`); without a token the
 * directory returns only handle and key. On a 401 it re-registers once. Best effort with a short timeout; if the service
 * is unreachable, the last known state stays. The chat server never depends on the service at runtime (apps/server/AGENTS.md, directory service).
 */
export class DirectoryClient {
  /** Public server key (hex), published in /api/health; null before init(). */
  serverKey: string | null = null;
  private privateKey: Uint8Array | null = null;
  private token: string | null = null;
  private registering: Promise<boolean> | null = null;
  /** After a failed registration, lookups do not try again before this time (see ensureToken). */
  private registerRetryAt = 0;
  /** Why the last registration failed (the setup check shows it, docs/features/doctor.md); null after a success. */
  lastRegisterProblem: { kind: "unreachable" | "refused" | "challenge"; status: number | null; error: string | null; detail: string | null } | null = null;
  /** When the last registration succeeded (null = never since the start). */
  registeredAt: Date | null = null;
  /**
   * The directory told of a suspension this server did not know of (users/suspension.ts): index.ts ends the user's
   * connections. Called from every place that stores the date, for a date that lies ahead.
   */
  onSuspended: ((userId: string, until: Date) => void) | null = null;
  private noteSuspension(userId: string, before: Date | null, now: Date | null): void {
    if (now && now.getTime() > Date.now() && !sameDate(before, now)) this.onSuspended?.(userId, now);
  }

  constructor(private readonly db: Db, private readonly config: Config, private readonly log: FastifyBaseLogger) {}

  get enabled(): boolean { return !!this.config.DIRECTORY_URL; }
  private get host(): string { return this.config.PUBLIC_DOMAIN.toLowerCase(); }

  /** Load the server key or generate it once (stays the same across restarts; the directory binds the host to it). */
  async init(): Promise<void> {
    const [s] = await this.db.select({ key: serverSettings.directoryPrivateKey }).from(serverSettings).where(eq(serverSettings.id, SETTINGS_ID)).limit(1);
    let hex = s?.key ?? null;
    if (!hex) {
      hex = Buffer.from(ed.utils.randomPrivateKey()).toString("hex");
      await this.db.update(serverSettings).set({ directoryPrivateKey: hex }).where(eq(serverSettings.id, SETTINGS_ID));
      this.log.info("Server-Schluessel fuer das Verzeichnis erzeugt");
    }
    this.privateKey = hexToBytes(hex);
    this.serverKey = Buffer.from(await ed.getPublicKeyAsync(this.privateKey)).toString("hex");
  }

  /** Register with the directory and fetch a token. Call after app.listen: the directory reads /api/health back. */
  register(): Promise<boolean> {
    if (!this.registering) this.registering = this.doRegister().finally(() => { this.registering = null; });
    return this.registering;
  }
  /**
   * A token for a lookup: registers when there is none, but after a failure not again for a minute. Unauthenticated pushes
   * (notify, leave) lead to lookups, and without the pause each one would start a registration, i.e. a call to the directory
   * and the directory's call back (security review, 25 September 2026). Explicit register() calls are not held back.
   */
  private async ensureToken(): Promise<boolean> {
    if (this.token) return true;
    if (Date.now() < this.registerRetryAt) return false;
    const ok = await this.register();
    // A refusal by the directory's operator (`server_blocked`) has set a longer pause already.
    if (!ok) this.registerRetryAt = Math.max(this.registerRetryAt, Date.now() + 60_000);
    return ok;
  }
  private async doRegister(): Promise<boolean> {
    const url = this.config.DIRECTORY_URL;
    if (!url || !this.privateKey || !this.serverKey) return false;
    try {
      const chRes = await fetch(`${url}/api/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKey: this.serverKey }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!chRes.ok) { this.lastRegisterProblem = { kind: "challenge", status: chRes.status, error: null, detail: null }; this.log.warn({ status: chRes.status }, "Verzeichnis: Challenge fuer die Server-Registrierung fehlgeschlagen"); return false; }
      const ch = ChallengeResponse.parse(await chRes.json());
      const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.json()) as { host?: string };
      if (!health.host) return false;
      // Server directory (M6d): name, listing, description, open join and member count are sent along; the icon is fetched by the
      // directory itself from our /api/server-icon. That is why the server re-registers after every change to it.
      const [s] = await this.db.select({ name: serverSettings.name, listed: serverSettings.listed, description: serverSettings.description, openJoin: serverSettings.openJoin })
        .from(serverSettings).where(eq(serverSettings.id, SETTINGS_ID)).limit(1);
      const [mc] = await this.db.select({ n: count() }).from(members);
      const signature = Buffer.from(await ed.signAsync(new TextEncoder().encode(directoryServerRegisterMessage(health.host, this.host, ch.nonce)), this.privateKey)).toString("hex");
      const body = {
        host: this.host, name: s?.name ?? null, listed: s?.listed ?? false, description: s?.description ?? null, openJoin: s?.openJoin ?? false, memberCount: mc?.n ?? null,
        publicKey: this.serverKey, challengeId: ch.challengeId, signature, proofUrl: this.config.directoryProofUrl,
      };
      // The proof takes longer: the directory calls our /api/health.
      const res = await fetch(`${url}/api/servers/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        this.lastRegisterProblem = { kind: "refused", status: res.status, error: err.error ?? null, detail: err.detail ?? null };
        if (err.error === "server_blocked") {
          // The directory's operator refused this server (docs/features/reports.md): nothing about the address is wrong,
          // and asking again changes nothing. Lookups leave the directory alone for an hour.
          this.token = null;
          this.registerRetryAt = Date.now() + BLOCKED_RETRY_MS;
          this.log.warn({ status: res.status, reason: err.detail, directory: url },
            "Verzeichnis: der Betreiber des Verzeichnisses hat diesen Server abgelehnt. Handles, Anzeigenamen und Profilbilder werden nicht uebernommen, der Server steht nicht im Serververzeichnis, und die Squorli-Clients oeffnen ihn nicht. Kontakt: das Impressum des Verzeichnisses.");
          return false;
        }
        this.log.warn({ status: res.status, error: err.error, detail: err.detail, proofUrl: this.config.directoryProofUrl },
          "Verzeichnis: Server-Registrierung abgelehnt; Anzeigenamen werden nicht uebernommen (DIRECTORY_PROOF_URL muss vom Verzeichnis aus erreichbar sein und serverKey liefern)");
        return false;
      }
      const reg = ServerRegisterResponse.parse(await res.json());
      this.token = reg.token;
      this.registerRetryAt = 0;
      this.lastRegisterProblem = null;
      this.registeredAt = new Date();
      this.log.info({ host: reg.host, expiresAt: reg.expiresAt }, "beim Verzeichnis als Server registriert");
      return true;
    } catch (err) {
      const message = err instanceof Error ? (err.cause as { code?: string } | undefined)?.code ?? err.message : String(err);
      this.lastRegisterProblem = { kind: "unreachable", status: null, error: null, detail: message };
      this.log.warn({ err: message }, "Verzeichnis fuer die Server-Registrierung nicht erreichbar");
      return false;
    }
  }

  /**
   * Look up key -> handle and display name and cache it on the user. Display name: the one set in the directory for this
   * server, otherwise the global one; if none is set (or there is no token), the local name stays unchanged. The avatar is public
   * at the directory; cached is only its address (with the cache version), the clients load the image from there.
   */
  /**
   * `member`: whether the key has a membership here. The directory records a lookup with our token as a sign-in on this server
   * (the server list on the account page and in the client's rail); with `member = false` it records nothing and drops an entry
   * it has (22 September 2026: a sign-in refused for want of an invite had listed the server for that account).
   */
  async refresh(user: { id: string; publicKey: string; displayName: string | null }, member = true, proof: LoginProof | null = null): Promise<DirectoryProfile | null> {
    const url = this.config.DIRECTORY_URL;
    if (!url) return null;
    try {
      await this.ensureToken();
      let res = await this.lookup(url, user.publicKey, member, proof);
      if (res.status === 401 && this.token) {
        // Token expired (24 h) or directory reinstalled: re-register once.
        this.token = null;
        if (await this.register()) res = await this.lookup(url, user.publicKey, member, proof);
      }
      // Only an answer to our token says anything about a suspension; a public lookup always says "none".
      let withToken = !!this.token;
      if (res.status === 401 || res.status === 403) {
        // Without a valid token, at least the handle (which is public).
        this.log.warn({ status: res.status }, "Verzeichnis: kein gueltiges Server-Token, nur Handle wird uebernommen");
        this.token = null;
        withToken = false;
        res = await fetch(`${url}/api/keys/${user.publicKey}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      }
      const [cached] = await this.db.select({ suspendedUntil: users.suspendedUntil }).from(users).where(eq(users.id, user.id)).limit(1);
      let handle: string | null = null;
      let displayName = user.displayName;
      let avatarUrl: string | null = null;
      let suspendedUntil: Date | null = cached?.suspendedUntil ?? null;
      if (res.status === 200) {
        const acc = DirectoryAccount.parse(await res.json());
        // The answer must be about the key asked for (security review, 25 September 2026): never take another account's name.
        if (acc.publicKey !== user.publicKey) { this.log.warn("Verzeichnis: Antwort fuer einen anderen Schluessel"); return null; }
        handle = acc.handle;
        displayName = acc.serverDisplayName ?? acc.displayName ?? user.displayName;
        avatarUrl = directoryAvatarUrl(url, acc.publicKey, acc.avatarUpdatedAt);
        if (withToken) suspendedUntil = suspensionOf(acc);
      } else if (res.status !== 404) { this.log.warn({ status: res.status }, "Verzeichnisdienst antwortet unerwartet"); return null; }
      else suspendedUntil = null; // no account at the directory: nothing to be suspended
      await this.db.update(users).set({ handle, displayName, avatarUrl, suspendedUntil, handleCheckedAt: new Date() }).where(eq(users.id, user.id));
      this.noteSuspension(user.id, cached?.suspendedUntil ?? null, suspendedUntil);
      return { handle, displayName, avatarUrl, suspendedUntil };
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "Verzeichnisdienst nicht erreichbar; Handle und Name bleiben wie zuletzt bekannt");
      return null;
    }
  }
  /**
   * Reconcile all users with the directory (bulk query with a token): changed handles/names are stored and
   * reported via onChanged (callers: rename voice presence, send the member list). Returns the number of changes.
   */
  async syncAll(onChanged: (u: { userId: string; publicKey: string; handle: string | null; displayName: string | null }) => void): Promise<number> {
    const url = this.config.DIRECTORY_URL;
    if (!url) return 0;
    if (!(await this.ensureToken())) return 0;
    const all = await this.db.select({ id: users.id, publicKey: users.publicKey, handle: users.handle, displayName: users.displayName, avatarUrl: users.avatarUrl, suspendedUntil: users.suspendedUntil }).from(users);
    let changed = 0;
    try {
      for (let i = 0; i < all.length; i += SYNC_CHUNK) {
        const chunk = all.slice(i, i + SYNC_CHUNK);
        let res = await this.resolveMany(url, chunk.map((u) => u.publicKey));
        if (res.status === 401) { this.token = null; if (!(await this.register())) return changed; res = await this.resolveMany(url, chunk.map((u) => u.publicKey)); }
        if (!res.ok) { this.log.warn({ status: res.status }, "Verzeichnis: Abgleich fehlgeschlagen"); return changed; }
        const byKey = new Map(ServerResolveResponse.parse(await res.json()).map((a) => [a.publicKey, a]));
        const now = new Date();
        for (const u of chunk) {
          const acc = byKey.get(u.publicKey);
          if (!acc) continue; // no account: the local state stays
          const displayName = acc.serverDisplayName ?? acc.displayName ?? u.displayName;
          const avatarUrl = directoryAvatarUrl(url, acc.publicKey, acc.avatarUpdatedAt);
          // The suspension is nothing the member list shows: stored and acted on, but no change for the broadcast.
          const suspendedUntil = suspensionOf(acc);
          if (!sameDate(suspendedUntil, u.suspendedUntil)) {
            await this.db.update(users).set({ suspendedUntil }).where(eq(users.id, u.id));
            this.noteSuspension(u.id, u.suspendedUntil, suspendedUntil);
          }
          if (acc.handle === u.handle && displayName === u.displayName && avatarUrl === u.avatarUrl) continue;
          await this.db.update(users).set({ handle: acc.handle, displayName, avatarUrl, handleCheckedAt: now }).where(eq(users.id, u.id));
          onChanged({ userId: u.id, publicKey: u.publicKey, handle: acc.handle, displayName });
          changed++;
        }
        const ids = chunk.filter((u) => byKey.has(u.publicKey)).map((u) => u.id);
        if (ids.length) await this.db.update(users).set({ handleCheckedAt: now }).where(inArray(users.id, ids));
      }
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "Verzeichnis: Abgleich abgebrochen");
    }
    if (changed) this.log.info({ changed }, "Namen aus dem Verzeichnis uebernommen");
    return changed;
  }
  /** Push from the directory (POST /api/directory/notify): reload one user via a bulk query (does not count as a sign-in). */
  async syncOne(publicKey: string, onChanged: (u: { userId: string; publicKey: string; handle: string | null; displayName: string | null }) => void): Promise<boolean> {
    const url = this.config.DIRECTORY_URL;
    if (!url) return false;
    const [u] = await this.db.select({ id: users.id, publicKey: users.publicKey, handle: users.handle, displayName: users.displayName, avatarUrl: users.avatarUrl, suspendedUntil: users.suspendedUntil }).from(users).where(eq(users.publicKey, publicKey)).limit(1);
    if (!u) return false;
    try {
      if (!(await this.ensureToken())) return false;
      let res = await this.resolveMany(url, [publicKey]);
      if (res.status === 401) { this.token = null; if (!(await this.register())) return false; res = await this.resolveMany(url, [publicKey]); }
      if (!res.ok) return false;
      // Only the account of the key asked for (security review, 25 September 2026).
      const acc = ServerResolveResponse.parse(await res.json()).find((a) => a.publicKey === publicKey);
      if (!acc) return false;
      const displayName = acc.serverDisplayName ?? acc.displayName ?? u.displayName;
      const avatarUrl = directoryAvatarUrl(url, acc.publicKey, acc.avatarUpdatedAt);
      const suspendedUntil = suspensionOf(acc);
      await this.db.update(users).set({ handle: acc.handle, displayName, avatarUrl, suspendedUntil, handleCheckedAt: new Date() }).where(eq(users.id, u.id));
      this.noteSuspension(u.id, u.suspendedUntil, suspendedUntil);
      if (acc.handle === u.handle && displayName === u.displayName && avatarUrl === u.avatarUrl) return false;
      onChanged({ userId: u.id, publicKey, handle: acc.handle, displayName });
      return true;
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "Verzeichnis: Einzelabgleich fehlgeschlagen");
      return false;
    }
  }
  /**
   * Account deletion requested through the directory (push POST /api/directory/leave or the pending list): confirm with our
   * token via POST /api/servers/leave/confirm. Only a 200 (the directory had a pending request of this user for exactly our host,
   * signed by the user) allows deleting; "not_pending" = nothing to do (a stranger or a stale push), null = directory unreachable.
   */
  async confirmLeave(publicKey: string): Promise<"confirmed" | "not_pending" | null> {
    const url = this.config.DIRECTORY_URL;
    if (!url) return null;
    try {
      if (!(await this.ensureToken())) return null;
      let res = await this.postConfirm(url, publicKey);
      if (res.status === 401) { this.token = null; if (!(await this.register())) return null; res = await this.postConfirm(url, publicKey); }
      if (res.status === 200) return "confirmed";
      if (res.status === 404) return "not_pending";
      this.log.warn({ status: res.status }, "Verzeichnis: Bestaetigung der Konto-Loeschung fehlgeschlagen");
      return null;
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "Verzeichnis: Bestaetigung der Konto-Loeschung nicht moeglich");
      return null;
    }
  }
  /** Pending deletions for this server (missed pushes), fetched during the periodic reconciliation. */
  async pendingLeaves(): Promise<string[]> {
    const url = this.config.DIRECTORY_URL;
    if (!url || !this.token) return [];
    try {
      const res = await fetch(`${url}/api/servers/leaves`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return [];
      return ServerLeavesResponse.parse(await res.json()).publicKeys;
    } catch { return []; }
  }
  /**
   * The setup check from outside (docs/features/doctor.md): the directory tries our public address from where it stands.
   * "unsupported" = the directory has no such route (older directory), null = no token or the directory did not answer.
   */
  async probe(tcpPort: number): Promise<ServerProbeResponse | "unsupported" | null> {
    const url = this.config.DIRECTORY_URL;
    if (!url) return null;
    try {
      if (!(await this.ensureToken())) return null;
      const post = () => fetch(`${url}/api/servers/probe`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ tcpPort }), signal: AbortSignal.timeout(20_000),
      });
      let res = await post();
      if (res.status === 401) { this.token = null; if (!(await this.register())) return null; res = await post(); }
      if (res.status === 404) return "unsupported";
      if (!res.ok) { this.log.warn({ status: res.status }, "Verzeichnis: Pruefung von aussen fehlgeschlagen"); return null; }
      return ServerProbeResponse.parse(await res.json());
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "Verzeichnis: Pruefung von aussen nicht moeglich");
      return null;
    }
  }
  private postConfirm(url: string, publicKey: string): Promise<Response> {
    return fetch(`${url}/api/servers/leave/confirm`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ publicKey }), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
  private resolveMany(url: string, publicKeys: string[]): Promise<Response> {
    return fetch(`${url}/api/servers/resolve`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ publicKeys }), signal: AbortSignal.timeout(8000),
    });
  }
  /** `proof`: the user's signature from this sign-in; without it the directory refreshes an existing entry but adds none. */
  private lookup(url: string, publicKey: string, member: boolean, proof: LoginProof | null = null): Promise<Response> {
    const headers: Record<string, string> = this.token ? { authorization: `Bearer ${this.token}` } : {};
    const withProof = member && proof ? `&nonce=${proof.nonce}&sig=${proof.signature}` : "";
    const q = this.token ? `?server=${encodeURIComponent(this.host)}${member ? "" : "&member=0"}${withProof}` : "";
    return fetch(`${url}/api/keys/${publicKey}${q}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }
}

/** Whether the cached state is old enough to be refreshed on GET /api/me. */
export function directoryStale(checkedAt: Date | null): boolean {
  return checkedAt === null || Date.now() - checkedAt.getTime() > REFRESH_AFTER_MS;
}
