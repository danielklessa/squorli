import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  /**
   * Address the server listens on. Default: every interface, which a container needs (its port is only reachable through
   * Docker's network). An installation without Docker (deploy/windows/) sets 127.0.0.1 when the proxy runs on the same
   * machine, so that only the proxy reaches the port, or the machine's LAN/VPN address for a proxy on another one.
   */
  LISTEN_HOST: z.string().min(1).default("0.0.0.0"),
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
   * Operator limits (docs/features/limits.md, 30 September 2026): every one of them is off when unset. STORAGE_QUOTA_MB
   * bounds every file the server keeps for its members (attachments, link preview pictures, report copies, avatars, the
   * server icon; 413 storage_full), VOICE_SEATS_MAX how many people sit in voice channels at the same time (409
   * voice_seats_full), MEMBER_MAX how many members the server admits (403 server_full). DB_POOL_MAX is the size of the
   * PostgreSQL connection pool (held open for good; 4 is plenty for a small server, 10 was the fixed value before).
   */
  STORAGE_QUOTA_MB: z.coerce.number().positive().optional(),
  VOICE_SEATS_MAX: z.coerce.number().int().positive().optional(),
  MEMBER_MAX: z.coerce.number().int().positive().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /**
   * The address LiveKit announces for media (its `rtc.node_ip`; in `deploy/compose.yml` the same variable configures
   * LiveKit itself). The setup check probes the media ports there when it is set; otherwise it uses the host of
   * LIVEKIT_PUBLIC_URL when that differs from PUBLIC_DOMAIN, else PUBLIC_DOMAIN (a media node on another machine).
   */
  LIVEKIT_NODE_IP: z.string().min(1).optional(),
  /**
   * The announced address changes (a home connection; docs/features/dynamic-ip.md): a job of the installation keeps
   * LIVEKIT_NODE_IP current and restarts LiveKit, while this process keeps the value it started with. The setup check then
   * probes PUBLIC_DOMAIN (its DNS record follows the address) instead of the value it has.
   */
  LIVEKIT_DYNAMIC_IP: z.enum(["true", "false", "1", "0", ""]).transform((v) => v === "true" || v === "1").optional(),
  /**
   * Public key that becomes the owner on first sign-in. Empty = the first user
   * who signs in while no owner exists yet.
   */
  OWNER_PUBLIC_KEY: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /**
   * The owner as a server account (~name; docs/features/local-accounts.md, 27 September 2026): while no owner exists, the
   * registration of a server account that carries this code becomes the owner, also where server accounts are off. A
   * name alone would not do: on a fresh server anybody could register it first. Set with OWNER_PUBLIC_KEY, either way works;
   * set alone, a sign-in without the code never becomes the owner. The installer makes one (`openssl rand`).
   */
  OWNER_SETUP_CODE: z.string().trim().min(12).max(128).optional(),
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
   * Who may read the setup check without a session (`squorli doctor`, docs/features/doctor.md). Empty (Docker): a request
   * from loopback without a forwarding header, which only `docker compose exec` can send. Set (an installation without
   * containers, deploy/windows/): whoever sends this value in the header x-squorli-doctor; loopback proves nothing there,
   * a proxy on the same machine arrives from 127.0.0.1 too. The setup for Windows makes one.
   */
  DOCTOR_TOKEN: z.string().min(32).max(256).optional(),
  /**
   * For tests only: one origin (e.g. http://127.0.0.1:3198) the preview fetcher may reach although it is not public, so the
   * smoke test can play the linked website. Never set it on a real server: it opens that address to every member.
   */
  LINK_PREVIEW_TEST_ORIGIN: z.string().url().optional(),
});

/** `publicOrigin`: where the outside reaches this server (absolute links in the status API): https://PUBLIC_DOMAIN, in dev http://localhost:PORT. */
export type Config = z.infer<typeof Env> & { trustedProxies: string[]; livekitPublicUrl: string; directoryProofUrl: string; publicOrigin: string };

/**
 * Secrets that stand in a template of this repository (`.env.example`, `.env.development`, the Windows template): they are
 * public, so whoever knows them can mint LiveKit tokens for any room and listen to every voice channel (security audit,
 * 2 October 2026, S7). The installers replace them by a random value; an installation by hand that copied the template
 * and never changed the line would run with them.
 */
const PLACEHOLDER_SECRET = /change-?me|^secret-secret-secret|^devsecret|^your-/i;

/** What stops a production start: a LiveKit secret that is a template's placeholder. Empty outside production. */
export function placeholderSecretProblems(c: { NODE_ENV: string; LIVEKIT_API_SECRET: string }): string[] {
  if (c.NODE_ENV !== "production") return [];
  return PLACEHOLDER_SECRET.test(c.LIVEKIT_API_SECRET)
    ? ["LIVEKIT_API_SECRET ist der Platzhalter aus der Vorlage (.env.example) und damit oeffentlich bekannt: jeder koennte Tokens fuer jeden Raum ausstellen und alle Sprachkanaele mithoeren. Setze einen zufaelligen Wert (z. B. `openssl rand -hex 32`) in der .env und starte neu; derselbe Wert gehoert in die LiveKit-Konfiguration (LIVEKIT_KEYS)."]
    : [];
}

/** What only deserves a line in the log: weak but not public (a shorter secret, the database's template password). */
export function configWarnings(c: { NODE_ENV: string; LIVEKIT_API_SECRET: string; DATABASE_URL: string }): string[] {
  if (c.NODE_ENV !== "production") return [];
  const out: string[] = [];
  if (c.LIVEKIT_API_SECRET.length < 32) out.push("LIVEKIT_API_SECRET hat weniger als 32 Zeichen: in Produktion sollten es mindestens 32 zufaellige sein (`openssl rand -hex 32`).");
  let dbPassword = "";
  try { dbPassword = decodeURIComponent(new URL(c.DATABASE_URL).password); } catch { /* the schema checked the address already */ }
  if (PLACEHOLDER_SECRET.test(dbPassword)) out.push("Das Passwort der Datenbank (DATABASE_URL) ist der Platzhalter aus der Vorlage: setze ein zufaelliges Passwort (POSTGRES_PASSWORD in der .env und in der Datenbank).");
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const parsed = Env.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Ungueltige Konfiguration:\n${issues}`);
  }
  const c = parsed.data;
  const problems = placeholderSecretProblems(c);
  if (problems.length) throw new Error(`Unsichere Konfiguration:\n${problems.map((p) => `  ${p}`).join("\n")}`);
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
