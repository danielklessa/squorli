import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  PUBLIC_DOMAIN: z.string().min(1),
  DATABASE_URL: z.string().url(),
  PROXY_MODE: z.enum(["bundled", "external"]).default("bundled"),
  TRUSTED_PROXIES: z.string().default("127.0.0.1"),
  /** Internal URL to the LiveKit server (server-to-server, e.g. RoomService). */
  LIVEKIT_URL: z.string().url(),
  /**
   * URL that clients receive for the media connection (without a path, the SDK appends /rtc).
   * Default: wss://PUBLIC_DOMAIN, i.e. through the proxy. In dev without a proxy: ws://localhost:7880.
   */
  LIVEKIT_PUBLIC_URL: z.string().url().optional(),
  /**
   * LiveKit's media ports as published on the host (compose.yml passes the same values to LiveKit). The app server never
   * touches them; the setup check names and probes them (docs/features/doctor.md).
   */
  LIVEKIT_TCP_PORT: z.coerce.number().int().min(1).max(65535).default(7881),
  LIVEKIT_UDP_PORT: z.coerce.number().int().min(1).max(65535).default(7882),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(16),
  STATIC_DIR: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  /** Directory for attachments (Docker: volume). */
  DATA_DIR: z.string().default("./data"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(25),
  /**
   * Public key that becomes the owner on first sign-in. Empty = the first user
   * who signs in while no owner exists yet.
   */
  OWNER_PUBLIC_KEY: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Initial name of the server; changeable later in the settings. */
  SERVER_NAME: z.string().min(1).max(64).default("Community"),
  /**
   * Directory service (M6): public base URL, e.g. https://chat.example.org/id. At sign-in the server resolves
   * key -> handle and passes the URL on to clients (registration in the browser). Empty = no directory.
   */
  DIRECTORY_URL: z.string().url().optional(),
  /**
   * URL at which the directory reaches this server's /api/health (host proof during server registration).
   * Default: https://PUBLIC_DOMAIN/api/health; with PUBLIC_DOMAIN=localhost, http://localhost:PORT/api/health (dev).
   */
  DIRECTORY_PROOF_URL: z.string().url().optional(),
  /**
   * Deprecated since 25 September 2026: every sign-in needs an account now (a directory handle or a server account,
   * docs/features/local-accounts.md). Still parsed so an old .env does not stop the server; the startup log warns.
   */
  REQUIRE_ACCOUNT: z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1").optional(),
  /**
   * Server accounts (`~name`, docs/features/local-accounts.md): true/false pins whether they may be registered here (the admin
   * area's switch is then locked). Empty = the admin area decides. Without DIRECTORY_URL they are always allowed.
   */
  LOCAL_ACCOUNTS: z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1").optional(),
  /**
   * For tests only (the smoke test cannot wait two minutes): how long a voice channel may be empty before its radio is
   * turned off. Not for operators: the admin area tells people "two minutes" (protocol RADIO_IDLE_STOP_MS).
   */
  RADIO_IDLE_STOP_MS: z.coerce.number().int().positive().optional(),
  /**
   * Link previews (docs/features/link-previews.md): the server fetches the pages members link to (public hosts only, title,
   * description and one picture) and keeps the pictures under DATA_DIR/previews. false = no previews and no such requests.
   */
  LINK_PREVIEWS: z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1").default("true"),
  /** Log level of the app server (docs/features/logging.md); default info in production, debug otherwise. */
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  /**
   * true = one log line per request with the caller's IP address, for troubleshooting only (docs/features/logging.md).
   * Default false: no request log, only requests that end in a server error, without the address.
   */
  LOG_REQUESTS: z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1").default("false"),
  /** Scales every rate limit (rateLimits.ts, docs/features/rate-limits.md): 2 = twice as many requests, 0 = no limits (load tests only). */
  RATE_LIMIT_FACTOR: z.coerce.number().min(0).default(1),
  /**
   * For tests only: one origin (e.g. http://127.0.0.1:3198) the preview fetcher may reach although it is not public, so the
   * smoke test can play the linked website. Never set it on a real server: it opens that address to every member.
   */
  LINK_PREVIEW_TEST_ORIGIN: z.string().url().optional(),
});

/** `publicOrigin`: where the outside reaches this server (absolute links in the status API): https://PUBLIC_DOMAIN, in dev http://localhost:PORT. */
export type Config = z.infer<typeof Env> & { trustedProxies: string[]; livekitPublicUrl: string; directoryProofUrl: string; publicOrigin: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const parsed = Env.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Ungueltige Konfiguration:\n${issues}`);
  }
  const c = parsed.data;
  const publicOrigin = c.PUBLIC_DOMAIN === "localhost" ? `http://localhost:${c.PORT}` : `https://${c.PUBLIC_DOMAIN}`;
  return {
    ...c,
    publicOrigin,
    trustedProxies: c.TRUSTED_PROXIES.split(",").map((s) => s.trim()).filter(Boolean),
    livekitPublicUrl: (c.LIVEKIT_PUBLIC_URL ?? `wss://${c.PUBLIC_DOMAIN}`).replace(/\/+$/, ""),
    ...(c.DIRECTORY_URL ? { DIRECTORY_URL: c.DIRECTORY_URL.replace(/\/+$/, "") } : {}),
    directoryProofUrl: c.DIRECTORY_PROOF_URL ?? `${publicOrigin}/api/health`,
  };
}
