import { sql } from "drizzle-orm";
import type { Db } from "../db";
import { pluginJobs } from "../db/schema";

/**
 * A plugin's schedules (docs/features/plugins.md): "call me at this time". One timer, armed to the next job that is due
 * (at most a minute ahead, so a row changed by hand or a clock that jumped is found too). A due job is claimed in the
 * database, handed to its plugin and deleted when the handler finished; a handler that failed gets the job again after 2
 * minutes, 10 minutes and an hour, then the job is dropped with a line in the plugin's log.
 *
 * **At least once:** a server that stops between the handler's work and the delete hands the job out again after the
 * start (every claim is cleared then; one node). A plugin's job handler must cope with a second call, as taking a role
 * that is gone already does. Jobs of a plugin that is disabled or suspended wait until it runs again.
 */

export type DueJob = { id: string; pluginId: string; key: string | null; name: string; payload: unknown; dueAt: Date; attempts: number };
const BATCH = 50;
const MAX_WAIT_MS = 60_000;
/** After the first, second and third failure; a fourth one drops the job. */
export const RETRY_SECONDS = [120, 600, 3600] as const;

/** Seconds until a job that failed `attempts` times is tried again; null = give up (pure, tested). */
export function retryDelay(attempts: number): number | null {
  return RETRY_SECONDS[attempts - 1] ?? null;
}

export class PluginScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again = false;
  private closed = false;

  constructor(
    private readonly db: Db,
    /** Hand the job to its plugin; resolves when the handler finished, rejects when it failed. */
    private readonly deliver: (job: DueJob) => Promise<void>,
    private readonly onDropped: (job: DueJob, reason: string) => void,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Every claim of a run before is void: whatever was handed out and not finished is due again. */
  async start(): Promise<void> {
    await this.db.update(pluginJobs).set({ claimedAt: null });
    this.poke();
  }

  /** Something changed (a job was scheduled or cancelled, a plugin enabled): look again now. */
  poke(): void {
    if (this.closed) return;
    if (this.running) { this.again = true; return; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.timer = setTimeout(() => { void this.tick(); }, 0);
  }

  close(): void {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private async tick(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    this.timer = null;
    try {
      for (;;) {
        this.again = false;
        // `now()` in SQL, never a Date parameter (postgres-js, apps/server/AGENTS.md). Only jobs of plugins that run.
        const due = await this.db.execute<{ id: string; plugin_id: string; key: string | null; name: string; payload: unknown; due_at: string; attempts: number }>(sql`
          UPDATE plugin_jobs SET claimed_at = now(), attempts = attempts + 1
          WHERE id IN (
            SELECT j.id FROM plugin_jobs j JOIN plugins p ON p.id = j.plugin_id
            WHERE j.due_at <= now() AND j.claimed_at IS NULL AND p.enabled AND p.state = 'ok'
            ORDER BY j.due_at LIMIT ${BATCH}
          )
          RETURNING id, plugin_id, key, name, payload, due_at, attempts`);
        const jobs: DueJob[] = [...due].map((r) => ({ id: r.id, pluginId: r.plugin_id, key: r.key, name: r.name, payload: r.payload, dueAt: new Date(r.due_at), attempts: r.attempts }));
        if (jobs.length === 0 || this.closed) break;
        jobs.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
        await Promise.all(jobs.map((job) => this.run(job)));
        if (jobs.length < BATCH && !this.again) break;
      }
    } catch (err) { this.onError(err); }
    this.running = false;
    await this.arm();
  }

  private async run(job: DueJob): Promise<void> {
    try {
      await this.deliver(job);
      await this.db.execute(sql`DELETE FROM plugin_jobs WHERE id = ${job.id}::uuid`);
    } catch (err) {
      if (this.closed) return; // the server is stopping: the claim is cleared at the next start
      const wait = retryDelay(job.attempts);
      try {
        if (wait === null) {
          await this.db.execute(sql`DELETE FROM plugin_jobs WHERE id = ${job.id}::uuid`);
          this.onDropped(job, String((err as Error)?.message ?? err));
        } else await this.db.execute(sql`UPDATE plugin_jobs SET claimed_at = NULL, due_at = now() + (${wait} * interval '1 second') WHERE id = ${job.id}::uuid`);
      } catch (inner) { this.onError(inner); }
    }
  }

  private async arm(): Promise<void> {
    if (this.closed) return;
    if (this.again) { this.again = false; this.poke(); return; }
    let wait = MAX_WAIT_MS;
    try {
      const [next] = [...await this.db.execute<{ seconds: number | null }>(sql`
        SELECT extract(epoch FROM (min(j.due_at) - now()))::float8 AS seconds
        FROM plugin_jobs j JOIN plugins p ON p.id = j.plugin_id
        WHERE j.claimed_at IS NULL AND p.enabled AND p.state = 'ok'`)];
      if (next?.seconds !== null && next?.seconds !== undefined) wait = Math.min(MAX_WAIT_MS, Math.max(0, Math.ceil(Number(next.seconds) * 1000) + 20));
    } catch (err) { this.onError(err); }
    if (this.closed || this.timer || this.running) return;
    this.timer = setTimeout(() => { void this.tick(); }, wait);
    this.timer.unref();
  }
}
