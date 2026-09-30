import type { DoctorCheck, DoctorReport, ProbeResult } from "@squorli/protocol";
import { isInternalAddress } from "@squorli/link-preview";
import type { FastifyBaseLogger } from "fastify";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import type { Config } from "./config";
import type { DirectoryClient } from "./directory";
import type { LivekitAdmin } from "./livekit/admin";

/**
 * Setup self-diagnosis (docs/features/doctor.md, 25 September 2026; docs/PLAN.md 2.1, the user's decision): the checks an
 * operator gets wrong most often, each with a text that names the likely fault in both languages. The same report serves
 * `squorli doctor` on the host (through the loopback route) and Verwaltung > Server in the client. The known faults are the
 * ones of `deploy/AGENTS.md`, "Known pitfalls: LiveKit connectivity", and of the proxy README.
 *
 * What runs from where: this process reaches its own public address (DNS, certificate, proxy, WebSocket upgrade, /rtc),
 * LiveKit internally (key and secret) and the TCP media port; a registered directory repeats the address checks from
 * outside (`POST /api/servers/probe`), because a machine cannot tell whether its own ports are open from the internet.
 * UDP is never probed here: nothing answers a bare packet on LiveKit's port; the client's media test is the UDP check.
 */

type Text = { de: string; en: string };
const T = (de: string, en: string): Text => ({ de, en });
const TIMEOUT_MS = 6000;

/**
 * An installation from the package for Windows (deploy/windows) runs Windows services, not containers, and its `squorli`
 * command has no `up`: where a text names what the operator has to look at, it has two wordings. A server on Windows is
 * always such an installation (or a developer's machine); a container is Linux (tested).
 */
export const onPlatform = <V>(docker: V, windows: V, platform: string = process.platform): V => (platform === "win32" ? windows : docker);

const mk = (status: DoctorCheck["status"]) => (id: string, text: Text, detail: string | null = null): DoctorCheck => ({ id, status, text, detail });
const ok = mk("ok");
const warn = mk("warn");
const fail = mk("fail");
const skip = mk("skip");

/** What the request that asked for the report looked like to this server (null for the loopback call of `squorli doctor`). */
export type RequestView = { hostname: string; protocol: string; ip: string; remoteAddress: string | null; forwardedFor: string | null } | null;

/** The error code of a failed fetch or socket (undici puts it into `cause`). */
export function errorCode(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: unknown } | undefined;
  if (cause && typeof cause.code === "string") return cause.code;
  if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : err.message;
}

export type FailureKind = "dns" | "tls" | "refused" | "timeout" | "reset" | "other";
/** Sorts a connection error into what an operator can do about it (tested). */
export function classifyFailure(code: string): FailureKind {
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)$/.test(code)) return "dns";
  if (/^(CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|HOSTNAME_MISMATCH|ERR_SSL_)/.test(code)) return "tls";
  if (code === "ECONNREFUSED") return "refused";
  if (/^(timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|EHOSTUNREACH|ENETUNREACH)$/.test(code)) return "timeout";
  if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") return "reset";
  return "other";
}

/**
 * Where the media ports are probed (tested; docs/features/limits.md): LIVEKIT_NODE_IP when the operator set it (the address
 * LiveKit announces), else the host of LIVEKIT_PUBLIC_URL when it names another machine than PUBLIC_DOMAIN, else
 * PUBLIC_DOMAIN. A media node on another host than the app server would otherwise be probed at the wrong address.
 */
export function mediaHost(config: Pick<Config, "PUBLIC_DOMAIN" | "livekitPublicUrl" | "LIVEKIT_NODE_IP">): string {
  if (config.LIVEKIT_NODE_IP) return config.LIVEKIT_NODE_IP;
  try {
    const host = new URL(config.livekitPublicUrl).hostname.replace(/^\[|\]$/g, "");
    if (host && host !== "localhost" && host !== "127.0.0.1" && host.toLowerCase() !== config.PUBLIC_DOMAIN.toLowerCase()) return host;
  } catch { /* an address that is no URL: the domain decides */ }
  return config.PUBLIC_DOMAIN;
}

/** The request's own view: is PUBLIC_DOMAIN the host the users type, does the proxy pass the client's address and scheme (tested). */
export function requestCheck(view: RequestView, config: Pick<Config, "PUBLIC_DOMAIN" | "trustedProxies">): DoctorCheck | null {
  if (!view) return null;
  if (config.PUBLIC_DOMAIN === "localhost") return skip("request", T("Entwicklung (PUBLIC_DOMAIN=localhost): die Proxy-Header werden nicht geprüft.", "Development (PUBLIC_DOMAIN=localhost): the proxy headers are not checked."));
  const host = view.hostname.toLowerCase();
  const domain = config.PUBLIC_DOMAIN.toLowerCase();
  if (host !== domain) {
    return fail("request", T(
      `Diese Anfrage kam für ${host} an, PUBLIC_DOMAIN ist aber ${domain}. Anmeldungen schlagen so mit signature_invalid fehl: PUBLIC_DOMAIN muss genau der Hostname sein, den die Nutzer eingeben.`,
      `This request arrived for ${host}, but PUBLIC_DOMAIN is ${domain}. Sign-ins fail with signature_invalid this way: PUBLIC_DOMAIN has to be exactly the hostname the users type.`), `host ${host}`);
  }
  const trusted = view.forwardedFor !== null && view.remoteAddress !== null && view.ip !== view.remoteAddress;
  if (view.forwardedFor !== null && !trusted) {
    return warn("request", T(
      `Der Proxy (${view.remoteAddress ?? "?"}) schickt X-Forwarded-For, steht aber nicht in TRUSTED_PROXIES (${config.trustedProxies.join(", ")}). Der Server sieht dann alle Mitglieder unter der Adresse des Proxys: die Rate-Limits treffen alle gemeinsam, und das Log nennt niemanden. Die Adresse in der .env eintragen und ${onPlatform("squorli up -d", "squorli restart server")}.`,
      `The proxy (${view.remoteAddress ?? "?"}) sends X-Forwarded-For but is not in TRUSTED_PROXIES (${config.trustedProxies.join(", ")}). The server then sees every member under the proxy's address: the rate limits hit everybody together, and the log names nobody. Add the address in .env and run ${onPlatform("squorli up -d", "squorli restart server")}.`), `remote ${view.remoteAddress ?? "?"}`);
  }
  if (view.forwardedFor === null && view.remoteAddress && isInternalAddress(view.remoteAddress)) {
    return warn("request", T(
      `Die Anfrage kam von ${view.remoteAddress} ohne X-Forwarded-For: der Proxy gibt die Adresse der Nutzer nicht weiter (nginx: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; Vorlagen in deploy/proxies/). Folgen: gemeinsame Rate-Limits für alle, kein Nutzer im Log.`,
      `The request came from ${view.remoteAddress} without X-Forwarded-For: the proxy does not pass the users' addresses on (nginx: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; templates in deploy/proxies/). Consequences: shared rate limits for everybody, no user in the log.`), `remote ${view.remoteAddress}`);
  }
  if (view.protocol !== "https") {
    return warn("request", T(
      `Der Server sieht diese Anfrage als http, nicht als https: der Proxy setzt kein X-Forwarded-Proto (nginx: proxy_set_header X-Forwarded-Proto $scheme) oder gilt nicht als vertrauenswürdig.`,
      `The server sees this request as http, not https: the proxy sets no X-Forwarded-Proto (nginx: proxy_set_header X-Forwarded-Proto $scheme) or is not trusted.`), `protocol ${view.protocol}`);
  }
  return ok("request", T(
    `Anfragen kommen für ${host} über https an; der Proxy${view.remoteAddress ? ` (${view.remoteAddress})` : ""} gilt als vertrauenswürdig, und die Adresse der Nutzer wird erkannt (${view.ip}).`,
    `Requests arrive for ${host} over https; the proxy${view.remoteAddress ? ` (${view.remoteAddress})` : ""} is trusted, and the users' address is recognised (${view.ip}).`));
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect({ host, port });
    let done = false;
    const finish = (r: { ok: true; ms: number } | { ok: false; error: string }) => { if (done) return; done = true; socket.destroy(); resolve(r); };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: "timeout" }));
    socket.once("connect", () => finish({ ok: true, ms: Date.now() - started }));
    socket.once("error", (err) => finish({ ok: false, error: errorCode(err) }));
  });
}

/** Opens a WebSocket and reports whether the upgrade went through (Node's own WebSocket, no dependency). */
function wsOpens(url: string, timeoutMs: number): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let ws: WebSocket;
    let done = false;
    const finish = (r: { ok: true; ms: number } | { ok: false; error: string }) => { if (done) return; done = true; clearTimeout(timer); try { ws?.close(); } catch { /* already closed */ } resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    try { ws = new WebSocket(url); } catch (err) { finish({ ok: false, error: errorCode(err) }); return; }
    ws.addEventListener("open", () => finish({ ok: true, ms: Date.now() - started }));
    ws.addEventListener("error", () => { /* the close event carries the code */ });
    ws.addEventListener("close", (ev) => finish({ ok: false, error: `close ${ev.code}` }));
  });
}

const describe = (p: ProbeResult) => p.error ?? (p.status !== null ? `HTTP ${p.status}` : "?");

/** Why the directory's operator refused a server: the reasons of the reports' list (protocol `REPORT_REASONS`), in words. */
const BLOCKED_REASONS: Record<string, { de: string; en: string }> = {
  spam: { de: "Spam oder Werbung", en: "spam or advertising" },
  harassment: { de: "Belästigung oder Mobbing", en: "harassment or bullying" },
  hate: { de: "Hass oder Hetze", en: "hate speech" },
  sexual: { de: "sexuelle Inhalte", en: "sexual content" },
  violence: { de: "Gewalt oder Drohungen", en: "violence or threats" },
  illegal: { de: "illegale Inhalte", en: "illegal content" },
  other: { de: "ein Verstoß gegen die Regeln", en: "a violation of the rules" },
};

export class Doctor {
  private running: Promise<Omit<DoctorReport, "checks"> & { checks: DoctorCheck[] }> | null = null;

  constructor(private readonly config: Config, private readonly directory: DirectoryClient, private readonly lk: LivekitAdmin, private readonly version: string, private readonly log: FastifyBaseLogger) {}

  /** The whole report. One run at a time: a second caller while one runs gets the same result, only the request check is its own. */
  async run(view: RequestView): Promise<DoctorReport> {
    if (!this.running) this.running = this.doRun().finally(() => { this.running = null; });
    const shared = await this.running;
    const own = requestCheck(view, this.config);
    return { ...shared, checks: own ? [own, ...shared.checks] : shared.checks };
  }

  private async doRun(): Promise<Omit<DoctorReport, "checks"> & { checks: DoctorCheck[] }> {
    const c = this.config;
    const started = Date.now();
    const [self, livekit, directory, tcp] = await Promise.all([this.checkSelf(), this.checkLivekit(), this.checkDirectory(), this.checkTcp()]);
    const reachable = self.status === "ok";
    // /rtc goes where LIVEKIT_PUBLIC_URL points; only when that is the public origin does its result depend on the self check.
    const rtcViaOrigin = this.config.livekitPublicUrl.replace(/^ws/, "http") === c.publicOrigin;
    const [websocket, rtc] = await Promise.all([
      reachable ? this.checkWebSocket() : skip("websocket", T("WebSocket nicht geprüft: die eigene Adresse ist von hier nicht erreichbar (siehe oben).", "WebSocket not checked: the server's own address is not reachable from here (see above).")),
      reachable || !rtcViaOrigin ? this.checkRtc() : skip("rtc", T("/rtc nicht geprüft: die eigene Adresse ist von hier nicht erreichbar (siehe oben).", "/rtc not checked: the server's own address is not reachable from here (see above).")),
    ]);
    const checks = [self, websocket, rtc, livekit, tcp, directory.check];
    if (directory.registered) checks.push(...await this.checkOutside());
    this.log.info({ ms: Date.now() - started, failed: checks.filter((x) => x.status === "fail").map((x) => x.id) }, "Setup-Prüfung gelaufen");
    return {
      time: new Date().toISOString(), domain: c.PUBLIC_DOMAIN, proxyMode: c.PROXY_MODE,
      mediaPorts: { tcp: c.LIVEKIT_TCP_PORT, udp: c.LIVEKIT_UDP_PORT }, livekitPublicUrl: c.livekitPublicUrl, directoryUrl: c.DIRECTORY_URL ?? null,
      checks,
    };
  }

  /** The server reaches its own public address: DNS, certificate, the proxy's target, and the answer is this server. */
  private async checkSelf(): Promise<DoctorCheck> {
    const { publicOrigin: origin, PUBLIC_DOMAIN: domain } = this.config;
    const tls = origin.startsWith("https:");
    let res: Response;
    try {
      res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual", headers: { accept: "application/json" } });
    } catch (err) {
      const code = errorCode(err);
      switch (classifyFailure(code)) {
        case "dns": return fail("self", T(
          `${domain} löst nicht auf. Der DNS-Eintrag (A- oder AAAA-Record) muss auf diesen Rechner zeigen; ohne ihn gibt es auch kein Zertifikat.`,
          `${domain} does not resolve. The DNS record (A or AAAA) has to point to this machine; without it there is no certificate either.`), code);
        case "tls": return fail("self", T(
          `Das Zertifikat von ${domain} ist ungültig (${code}). Mit dem mitgelieferten Caddy müssen Port 80 und 443 von außen erreichbar sein und der DNS-Eintrag hierher zeigen, dann holt Caddy das Zertifikat selbst (squorli logs caddy). Mit eigenem Proxy: dessen Zertifikat für ${domain} prüfen.`,
          `The certificate of ${domain} is invalid (${code}). With the bundled Caddy, ports 80 and 443 have to be reachable from outside and the DNS record has to point here, then Caddy fetches the certificate itself (squorli logs caddy). With your own proxy: check its certificate for ${domain}.`), code);
        case "refused": return fail("self", T(
          `Unter ${origin} lauscht nichts (Verbindung abgelehnt): der Proxy oder Caddy läuft nicht, oder Port 443 wird nicht an diesen Rechner weitergeleitet. squorli status zeigt die ${onPlatform("Container", "Dienste")}.`,
          `Nothing listens at ${origin} (connection refused): the proxy or Caddy is not running, or port 443 is not forwarded to this machine. squorli status shows the ${onPlatform("containers", "services")}.`), code);
        case "timeout": return warn("self", T(
          `${origin} antwortet nicht (Zeitüberschreitung). Entweder lässt eine Firewall Port 443 nicht durch, oder dieser Rechner erreicht seine eigene öffentliche Adresse nicht (Hairpin-NAT, häufig hinter einem Heimrouter). Dann zählt nur die Prüfung von außen oder die aus dem Browser.`,
          `${origin} does not answer (timeout). Either a firewall blocks port 443, or this machine cannot reach its own public address (hairpin NAT, common behind a home router). Then only the check from outside or the one from the browser counts.`), code);
        default: return fail("self", T(`${origin} ist von hier nicht erreichbar (${code}).`, `${origin} is not reachable from here (${code}).`), code);
      }
    }
    const body = await res.json().catch(() => null) as { serverKey?: unknown } | null;
    if (res.status >= 500) {
      return fail("self", T(
        `Der Proxy unter ${domain} antwortet mit HTTP ${res.status}: er erreicht den App-Server nicht. Prüfe, wohin er weiterleitet (${onPlatform("App-Server, Port 3000 im Container bzw. APP_PORT", "App-Server, APP_PORT")}) und ob ${onPlatform("der Container", "der Dienst SquorliServer")} läuft (squorli status).`,
        `The proxy at ${domain} answers HTTP ${res.status}: it does not reach the app server. Check where it forwards to (${onPlatform("the app server, port 3000 in the container or APP_PORT", "the app server, APP_PORT")}) and whether ${onPlatform("the container", "the service SquorliServer")} runs (squorli status).`), `status ${res.status}`);
    }
    if (!res.ok || !body || typeof body.serverKey !== "string") {
      return fail("self", T(
        `${origin}/api/health liefert keine Squorli-Antwort (HTTP ${res.status}). Unter dieser Adresse antwortet ein anderer Dienst, oder der Proxy leitet an ein falsches Ziel.`,
        `${origin}/api/health gives no Squorli answer (HTTP ${res.status}). Another service answers at this address, or the proxy forwards to the wrong target.`), `status ${res.status}`);
    }
    if (this.directory.serverKey && body.serverKey !== this.directory.serverKey) {
      return fail("self", T(
        `Unter ${origin} antwortet ein anderer Squorli-Server (anderer Server-Schlüssel): DNS-Eintrag oder Proxy zeigen auf eine andere Installation.`,
        `Another Squorli server answers at ${origin} (a different server key): the DNS record or the proxy points at another installation.`), "key mismatch");
    }
    return ok("self", tls
      ? T(`${origin} antwortet, das Zertifikat ist gültig, und es ist dieser Server.`, `${origin} answers, the certificate is valid, and it is this server.`)
      : T(`${origin} antwortet, und es ist dieser Server.`, `${origin} answers, and it is this server.`));
  }

  private async checkWebSocket(): Promise<DoctorCheck> {
    const url = `${this.config.publicOrigin.replace(/^http/, "ws")}/api/ws`;
    const r = await wsOpens(url, TIMEOUT_MS);
    if (r.ok) return ok("websocket", T(`Der WebSocket-Upgrade durch den Proxy funktioniert (${url}).`, `The WebSocket upgrade through the proxy works (${url}).`), `${r.ms} ms`);
    return fail("websocket", T(
      `Der Proxy reicht das WebSocket-Upgrade nicht weiter (${url}, ${r.error}). Clients bleiben bei „verbinde …“. nginx: proxy_http_version 1.1 und die Header Upgrade und Connection; Apache/Plesk: mod_proxy_wstunnel; Nginx Proxy Manager: „Websockets Support“. Vorlagen in deploy/proxies/.`,
      `The proxy does not pass the WebSocket upgrade (${url}, ${r.error}). Clients stay at "connecting…". nginx: proxy_http_version 1.1 and the Upgrade and Connection headers; Apache/Plesk: mod_proxy_wstunnel; Nginx Proxy Manager: "Websockets Support". Templates in deploy/proxies/.`), r.error);
  }

  /** /rtc where the clients go (LIVEKIT_PUBLIC_URL, through the proxy in production): LiveKit answers 401 to a validate request without a token. */
  private async checkRtc(): Promise<DoctorCheck> {
    const url = `${this.config.livekitPublicUrl.replace(/^ws/, "http")}/rtc/validate`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
      await res.body?.cancel().catch(() => {});
      if (res.status === 401) return ok("rtc", T(`Der Proxy leitet /rtc an LiveKit weiter (${url} antwortet 401, wie erwartet).`, `The proxy forwards /rtc to LiveKit (${url} answers 401, as expected).`));
      if (res.status >= 502 && res.status <= 504) return fail("rtc", T(
        `Der Proxy erreicht LiveKit nicht (${url} antwortet HTTP ${res.status}): Ziel für /rtc muss LiveKit auf Port 7880 (LIVEKIT_HTTP_PORT) sein, und ${onPlatform("der Container livekit", "der Dienst SquorliLiveKit")} muss laufen.`,
        `The proxy does not reach LiveKit (${url} answers HTTP ${res.status}): the target for /rtc has to be LiveKit on port 7880 (LIVEKIT_HTTP_PORT), and ${onPlatform("the livekit container", "the service SquorliLiveKit")} has to run.`), `status ${res.status}`);
      return fail("rtc", T(
        `Der Proxy leitet /rtc nicht an LiveKit weiter (${url} antwortet HTTP ${res.status} statt 401): Sprachkanäle verbinden so nicht („could not establish signal connection“). Route /rtc* zu LiveKit ergänzen, mit WebSocket-Upgrade (deploy/proxies/).`,
        `The proxy does not forward /rtc to LiveKit (${url} answers HTTP ${res.status} instead of 401): voice channels cannot connect this way ("could not establish signal connection"). Add the route /rtc* to LiveKit, with the WebSocket upgrade (deploy/proxies/).`), `status ${res.status}`);
    } catch (err) {
      const code = errorCode(err);
      return fail("rtc", T(`${url} ist nicht erreichbar (${code}).`, `${url} is not reachable (${code}).`), code);
    }
  }

  private async checkLivekit(): Promise<DoctorCheck> {
    const r = await this.lk.ping();
    const url = this.config.LIVEKIT_URL;
    if (r.ok) return ok("livekit", T(`LiveKit antwortet intern (${url}) und nimmt den API-Schlüssel an.`, `LiveKit answers internally (${url}) and accepts the API key.`));
    if (r.kind === "auth") return fail("livekit", T(
      `LiveKit lehnt den API-Schlüssel ab (${r.detail}): LIVEKIT_API_KEY und LIVEKIT_API_SECRET in der .env müssen zu ${onPlatform("LIVEKIT_KEYS des LiveKit-Containers", "keys in config\\livekit.yaml")} passen. Nach einer Änderung ${onPlatform("beide Container neu starten (squorli up -d)", "beide Dienste neu starten (squorli restart)")}.`,
      `LiveKit refuses the API key (${r.detail}): LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env have to match ${onPlatform("LIVEKIT_KEYS of the LiveKit container", "keys in config\\livekit.yaml")}. After a change restart ${onPlatform("both containers (squorli up -d)", "both services (squorli restart)")}.`), r.detail);
    return fail("livekit", T(
      `LiveKit antwortet nicht unter ${url} (${r.detail}): ${onPlatform("Container livekit", "Dienst SquorliLiveKit")} prüfen (squorli status, squorli logs livekit).`,
      `LiveKit does not answer at ${url} (${r.detail}): check the ${onPlatform("livekit container", "service SquorliLiveKit")} (squorli status, squorli logs livekit).`), r.detail);
  }

  /** The TCP media port from this process; the result from the machine's own address is only a hint (hairpin NAT). */
  private async checkTcp(): Promise<DoctorCheck> {
    const port = this.config.LIVEKIT_TCP_PORT;
    // The media node's address, not necessarily the app server's (mediaHost above).
    const domain = mediaHost(this.config);
    let ip: string;
    try { ip = (await lookup(domain)).address; } catch (err) {
      return skip("mediaTcp", T(`${port}/tcp nicht geprüft: ${domain} löst nicht auf.`, `${port}/tcp not checked: ${domain} does not resolve.`), errorCode(err));
    }
    if (isInternalAddress(ip)) {
      return skip("mediaTcp", T(`${port}/tcp nicht geprüft: ${domain} zeigt auf die private Adresse ${ip} (Entwicklung oder LAN).`, `${port}/tcp not checked: ${domain} points at the private address ${ip} (development or LAN).`), ip);
    }
    const r = await tcpConnect(ip, port, 4000);
    if (r.ok) return ok("mediaTcp", T(`${ip}:${port}/tcp ist von diesem Rechner aus erreichbar.`, `${ip}:${port}/tcp is reachable from this machine.`), `${r.ms} ms`);
    return warn("mediaTcp", T(
      `${ip}:${port}/tcp ist von diesem Rechner aus nicht erreichbar (${r.error}). Von der eigenen öffentlichen Adresse aus kann das an Hairpin-NAT liegen; entscheidend ist die Prüfung von außen (Verzeichnis) oder die aus dem Browser. Ist der Port auch von außen zu: ${port}/tcp und ${this.config.LIVEKIT_UDP_PORT}/udp in der Firewall des Rechners, beim Hoster und im Router freigeben bzw. weiterleiten.`,
      `${ip}:${port}/tcp is not reachable from this machine (${r.error}). From the machine's own public address this can be hairpin NAT; the check from outside (directory) or from the browser decides. If the port is closed from outside too: open or forward ${port}/tcp and ${this.config.LIVEKIT_UDP_PORT}/udp in the machine's firewall, at the hosting provider and in the router.`), r.error);
  }

  /** Registration at the directory, fresh: it proves that the directory reached our /api/health from outside. */
  private async checkDirectory(): Promise<{ check: DoctorCheck; registered: boolean }> {
    const url = this.config.DIRECTORY_URL;
    if (!url) {
      return { registered: false, check: skip("directory", T(
        "Kein Verzeichnis eingetragen (DIRECTORY_URL leer): Anmeldung nur mit Serverkonten (~name), keine Freunde und Direktnachrichten. Eine Prüfung von außen gibt es ohne Verzeichnis nicht.",
        "No directory configured (DIRECTORY_URL empty): sign-in only with server accounts (~name), no friends and direct messages. Without a directory there is no check from outside.")) };
    }
    const proofUrl = this.config.directoryProofUrl;
    if (await this.directory.register()) {
      return { registered: true, check: ok("directory", T(
        `Beim Verzeichnis ${url} registriert: es hat ${proofUrl} von außen erreicht und diesen Server erkannt.`,
        `Registered at the directory ${url}: it reached ${proofUrl} from outside and recognised this server.`)) };
    }
    const p = this.directory.lastRegisterProblem;
    const detail = p ? [p.status ? `status ${p.status}` : null, p.error, p.detail].filter(Boolean).join(", ") : null;
    if (!p || p.kind === "unreachable") {
      return { registered: false, check: fail("directory", T(
        `Das Verzeichnis ${url} ist von diesem Server aus nicht erreichbar (${p?.detail ?? "?"}). Ausgehendes HTTPS und DNS ${onPlatform("im Container", "dieses Rechners")} prüfen.`,
        `The directory ${url} is not reachable from this server (${p?.detail ?? "?"}). Check outgoing HTTPS and DNS ${onPlatform("in the container", "of this machine")}.`), detail) };
    }
    if (p.kind === "challenge") {
      return { registered: false, check: fail("directory", T(
        `Das Verzeichnis ${url} antwortet unerwartet (HTTP ${p.status}). Stimmt die Adresse in DIRECTORY_URL?`,
        `The directory ${url} answers unexpectedly (HTTP ${p.status}). Is the address in DIRECTORY_URL right?`), detail) };
    }
    if (p.error === "host_unverified") {
      return { registered: false, check: fail("directory", T(
        `Das Verzeichnis konnte diesen Server nicht unter ${proofUrl} erreichen oder fand dort einen anderen Schlüssel (${p.detail ?? "kein Detail"}). Der Server muss von außen unter https://${this.config.PUBLIC_DOMAIN} antworten (siehe die Prüfungen oben); DIRECTORY_PROOF_URL nur setzen, wenn die Adresse wirklich eine andere ist.`,
        `The directory could not reach this server at ${proofUrl} or found another key there (${p.detail ?? "no detail"}). The server has to answer from outside at https://${this.config.PUBLIC_DOMAIN} (see the checks above); set DIRECTORY_PROOF_URL only when the address really differs.`), detail) };
    }
    if (p.error === "server_blocked") {
      // Refused by the directory's operator (docs/features/reports.md): nothing about this server's address is wrong.
      const why = BLOCKED_REASONS[p.detail ?? ""] ?? BLOCKED_REASONS.other!;
      return { registered: false, check: fail("directory", T(
        `Der Betreiber des Verzeichnisses ${url} hat diesen Server abgelehnt (Grund: ${why.de}). An der Adresse dieses Servers liegt es nicht. Solange das gilt, übernimmt der Server keine Handles, Anzeigenamen und Profilbilder, er steht nicht im Serververzeichnis, und die Squorli-Clients öffnen ihn nicht. Wende dich an den Betreiber des Verzeichnisses; die Adresse steht in dessen Impressum (${url}/impressum).`,
        `The operator of the directory ${url} refused this server (reason: ${why.en}). Nothing about this server's address is wrong. While that holds, the server takes over no handles, display names and profile pictures, it is not in the server directory, and the Squorli clients do not open it. Get in touch with the directory's operator; the address is in its legal notice (${url}/imprint).`), detail) };
    }
    if (p.status === 429) {
      return { registered: false, check: warn("directory", T(
        "Das Verzeichnis bremst gerade (zu viele Registrierungen von dieser Adresse): in einer Minute noch einmal prüfen.",
        "The directory is throttling right now (too many registrations from this address): check again in a minute."), detail) };
    }
    return { registered: false, check: fail("directory", T(
      `Das Verzeichnis lehnt die Registrierung ab (${detail}).`, `The directory refuses the registration (${detail}).`), detail) };
  }

  /** The address checks once more, from where the directory stands: the only view that tells whether the ports are open from the internet. */
  private async checkOutside(): Promise<DoctorCheck[]> {
    const { PUBLIC_DOMAIN: domain, publicOrigin: origin, LIVEKIT_TCP_PORT: tcpPort, LIVEKIT_UDP_PORT: udpPort } = this.config;
    let from = "Verzeichnis";
    try { from = new URL(this.config.DIRECTORY_URL!).host; } catch { /* keep */ }
    const r = await this.directory.probe(tcpPort);
    if (r === "unsupported") return [skip("outside", T(`Dieses Verzeichnis (${from}) bietet noch keine Prüfung von außen an.`, `This directory (${from}) offers no check from outside yet.`))];
    if (!r) return [warn("outside", T(`Die Prüfung von außen über das Verzeichnis ${from} kam nicht zustande (siehe Log).`, `The check from outside through the directory ${from} did not happen (see the log).`))];
    const out: DoctorCheck[] = [];
    const where = r.address ? `${r.address}` : domain;
    if (r.health.ok && r.health.keyMatches !== false) {
      out.push(ok("outsideHealth", T(`Von außen (${from}): ${origin} antwortet mit gültigem Zertifikat (Adresse ${where}).`, `From outside (${from}): ${origin} answers with a valid certificate (address ${where}).`), r.health.ms !== null ? `${r.health.ms} ms` : null));
    } else if (r.health.ok) {
      out.push(fail("outsideHealth", T(`Von außen (${from}): unter ${origin} antwortet ein anderer Squorli-Server.`, `From outside (${from}): another Squorli server answers at ${origin}.`), "key mismatch"));
    } else {
      const code = r.health.error ?? "";
      const hint = {
        dns: T("Der DNS-Eintrag ist von außen nicht zu sehen (noch nicht verbreitet, oder nur lokal gesetzt).", "The DNS record is not visible from outside (not propagated yet, or set only locally)."),
        tls: T("Das Zertifikat wird von außen nicht anerkannt.", "The certificate is not accepted from outside."),
        refused: T("Auf Port 443 lauscht von außen nichts: Weiterleitung oder Proxy prüfen.", "Nothing listens on port 443 from outside: check the forwarding or the proxy."),
        timeout: T("Port 443 ist von außen zu: Firewall des Rechners, Firewall beim Hoster oder Router.", "Port 443 is closed from outside: the machine's firewall, the hosting provider's firewall or the router."),
        reset: T("Die Verbindung wird von außen abgebrochen.", "The connection is cut from outside."),
        other: T("", ""),
      }[classifyFailure(code)];
      out.push(fail("outsideHealth", T(`Von außen (${from}): ${origin} ist nicht erreichbar (${describe(r.health)}). ${hint.de}`.trim(), `From outside (${from}): ${origin} is not reachable (${describe(r.health)}). ${hint.en}`.trim()), r.health.error));
    }
    if (!r.health.ok) {
      out.push(skip("outsideWs", T("Von außen: WebSocket nicht geprüft.", "From outside: WebSocket not checked.")), skip("outsideRtc", T("Von außen: /rtc nicht geprüft.", "From outside: /rtc not checked.")));
    } else {
      out.push(r.websocket.ok
        ? ok("outsideWs", T(`Von außen: der WebSocket-Upgrade funktioniert.`, `From outside: the WebSocket upgrade works.`), r.websocket.ms !== null ? `${r.websocket.ms} ms` : null)
        : fail("outsideWs", T(`Von außen: der WebSocket-Upgrade schlägt fehl (${describe(r.websocket)}). Clients bleiben bei „verbinde …“; die Proxy-Konfiguration prüfen (deploy/proxies/).`, `From outside: the WebSocket upgrade fails (${describe(r.websocket)}). Clients stay at "connecting…"; check the proxy configuration (deploy/proxies/).`), r.websocket.error));
      out.push(r.rtc.ok
        ? ok("outsideRtc", T(`Von außen: /rtc erreicht LiveKit.`, `From outside: /rtc reaches LiveKit.`), r.rtc.ms !== null ? `${r.rtc.ms} ms` : null)
        : fail("outsideRtc", T(`Von außen: ${origin}/rtc/validate antwortet nicht mit 401 (${describe(r.rtc)}): der Proxy leitet /rtc nicht an LiveKit weiter, Sprachkanäle verbinden nicht.`, `From outside: ${origin}/rtc/validate does not answer 401 (${describe(r.rtc)}): the proxy does not forward /rtc to LiveKit, voice channels cannot connect.`), r.rtc.error));
    }
    if (r.tcp) {
      out.push(r.tcp.ok
        ? ok("outsideTcp", T(`Von außen: ${where}:${r.tcp.port}/tcp ist offen. UDP ${udpPort} lässt sich von außen nicht prüfen; die Prüfung aus dem Browser zeigt, ob UDP ankommt.`, `From outside: ${where}:${r.tcp.port}/tcp is open. UDP ${udpPort} cannot be probed from outside; the check from the browser shows whether UDP arrives.`), r.tcp.ms !== null ? `${r.tcp.ms} ms` : null)
        : fail("outsideTcp", T(
          `Von außen: ${where}:${r.tcp.port}/tcp ist zu (${describe(r.tcp)}). Sprache und Video brauchen ${tcpPort}/tcp und ${udpPort}/udp bis zu diesem Rechner: in der Firewall des Rechners, beim Hoster und im Router freigeben bzw. weiterleiten (auf dieselbe Nummer). Teilnehmer fliegen sonst nach etwa 15 Sekunden aus dem Kanal.`,
          `From outside: ${where}:${r.tcp.port}/tcp is closed (${describe(r.tcp)}). Voice and video need ${tcpPort}/tcp and ${udpPort}/udp up to this machine: open or forward them in the machine's firewall, at the hosting provider and in the router (to the same number). Otherwise participants drop out of the channel after about 15 seconds.`), r.tcp.error));
    } else {
      out.push(skip("outsideTcp", T("Von außen: der TCP-Medienport wurde nicht geprüft (Adresse nicht öffentlich).", "From outside: the TCP media port was not probed (address not public).")));
    }
    return out;
  }
}
