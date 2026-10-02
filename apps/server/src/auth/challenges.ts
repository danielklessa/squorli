import { randomBytes, randomUUID } from "node:crypto";

/**
 * Short-lived login challenges. In-memory is enough for a single node;
 * for multi-node operation, move this to Redis later.
 */
export class ChallengeStore {
  private readonly items = new Map<string, { publicKey: string; nonce: string; expiresAt: number }>();
  constructor(private readonly ttlMs = 60_000) {}

  create(publicKey: string) {
    const challengeId = randomUUID();
    const nonce = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + this.ttlMs;
    this.items.set(challengeId, { publicKey, nonce, expiresAt });
    return { challengeId, nonce, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Single-use: returns and deletes. */
  consume(challengeId: string, publicKey: string): string | null {
    const item = this.items.get(challengeId);
    this.items.delete(challengeId);
    if (!item || item.publicKey !== publicKey || item.expiresAt < Date.now()) return null;
    return item.nonce;
  }

  sweep() {
    const now = Date.now();
    for (const [id, item] of this.items) if (item.expiresAt < now) this.items.delete(id);
  }
}

/** Counting window per key (client IP, handle): `limit` hits per `windowMs`, as at the directory. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  allow(key: string): boolean {
    if (this.blocked(key)) return false;
    this.hit(key);
    return true;
  }
  /** Check only, without counting (failed attempts count through hit()). */
  blocked(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list.length >= this.limit;
  }
  hit(key: string) {
    const list = this.hits.get(key) ?? [];
    list.push(Date.now());
    this.hits.set(key, list);
  }
  /**
   * Password checks: count the attempt before the first await, so parallel requests cannot all pass one `blocked()` check
   * (security review, 25 September 2026); a correct password gives the attempt back with `refund()`.
   */
  attempt(...keys: string[]): boolean {
    if (keys.some((k) => this.blocked(k))) return false;
    for (const k of keys) this.hit(k);
    return true;
  }
  /** Forget a key's hits (the escalating limiter starts a block and begins counting again after it). */
  clear(key: string) { this.hits.delete(key); }
  refund(...keys: string[]) {
    for (const k of keys) {
      const list = this.hits.get(k);
      if (!list) continue;
      list.pop();
      if (!list.length) this.hits.delete(k);
    }
  }
  sweep() {
    const now = Date.now();
    for (const [k, list] of this.hits) {
      const kept = list.filter((t) => now - t < this.windowMs);
      if (kept.length) this.hits.set(k, kept); else this.hits.delete(k);
    }
  }
}

/**
 * A password limiter whose blocks grow (security audit, 2 October 2026, S12): `limit` wrong passwords within `windowMs`
 * block the key for the first step (5 minutes), the next time for the second (15 minutes), then for an hour; a key that has
 * not been blocked for a day starts from the first step again. With a plain window (10 a minute) a guess could go on for
 * ever at 14,400 a day; now it is about ten an hour once the third block is reached. The longest block is an hour on
 * purpose: every block is also a way to keep the account's owner from signing in on a new device, by anybody who knows
 * the handle. In memory like the other limiters, so a restart forgets it.
 */
export class EscalatingLimiter {
  private readonly inner: RateLimiter;
  private readonly locks = new Map<string, { level: number; until: number; lastAt: number }>();
  constructor(
    limit: number, windowMs = 60_000,
    private readonly steps: readonly number[] = [5 * 60_000, 15 * 60_000, 60 * 60_000],
    private readonly forgetMs = 24 * 60 * 60_000,
  ) { this.inner = new RateLimiter(limit, windowMs); }

  /** Check only: true while a block lasts, and the moment the window is full a new (longer) block starts. */
  blocked(key: string): boolean {
    const now = Date.now();
    const lock = this.locks.get(key);
    if (lock && lock.until > now) return true;
    if (this.inner.blocked(key)) {
      const level = Math.min((lock && now - lock.lastAt < this.forgetMs ? lock.level : 0) + 1, this.steps.length);
      this.locks.set(key, { level, until: now + this.steps[level - 1]!, lastAt: now });
      this.inner.clear(key);
      return true;
    }
    return false;
  }
  /** Seconds until the key may try again, 0 when it may. */
  retryAfter(key: string): number {
    const lock = this.locks.get(key);
    return lock && lock.until > Date.now() ? Math.ceil((lock.until - Date.now()) / 1000) : 0;
  }
  hit(key: string) { this.inner.hit(key); }
  /** Count the attempt before the first await, as RateLimiter.attempt; a right password gives it back with `refund`. */
  attempt(...keys: string[]): boolean {
    if (keys.some((k) => this.blocked(k))) return false;
    for (const k of keys) this.inner.hit(k);
    return true;
  }
  refund(...keys: string[]) { this.inner.refund(...keys); }
  sweep() {
    this.inner.sweep();
    const now = Date.now();
    for (const [k, l] of this.locks) if (l.until < now && now - l.lastAt >= this.forgetMs) this.locks.delete(k);
  }
}
