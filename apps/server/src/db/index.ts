import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];

/** What PostgreSQL says without it being an error, e.g. "schema ... already exists, skipping" on every start after the first. */
export type DbNotice = { severity?: string; code?: string; message?: string };

/**
 * `onNotice` gets PostgreSQL's notices. postgres-js would print them with `console.log` as plain text of several lines,
 * in the middle of a log that is JSON line by line (seen in the log of a Windows installation, 28 September 2026; the
 * same in a container's). Without a handler they are dropped.
 */
export function createDb(url: string, onNotice: (notice: DbNotice) => void = () => {}) {
  const client = postgres(url, { max: 10, onnotice: onNotice });
  const db = drizzle(client, { schema });
  return { db, client };
}

/** Migrations live in ./drizzle and are applied at startup. */
export async function runMigrations(db: Db, folder: string) {
  await migrate(db, { migrationsFolder: folder });
}
