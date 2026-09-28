import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, type DbNotice } from "./index";

// No connection is opened: postgres-js connects with the first query.
const URL = "postgres://chat:chat@127.0.0.1:1/chat";

describe("createDb", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hands PostgreSQL's notices to the given handler", () => {
    const seen: DbNotice[] = [];
    const { client } = createDb(URL, (notice) => seen.push(notice));
    client.options.onnotice?.({ severity: "NOTICE", code: "42P06", message: 'schema "drizzle" already exists, skipping' } as never);
    expect(seen).toEqual([{ severity: "NOTICE", code: "42P06", message: 'schema "drizzle" already exists, skipping' }]);
  });

  it("prints nothing without a handler (postgres-js would use console.log)", () => {
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    const { client } = createDb(URL);
    expect(client.options.onnotice).not.toBe(console.log);
    client.options.onnotice?.({ severity: "NOTICE", code: "42P07", message: "relation exists" } as never);
    expect(printed).not.toHaveBeenCalled();
  });
});
