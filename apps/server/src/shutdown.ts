/**
 * Stop on a signal: close Fastify (its hooks end the timers, close the WebSockets and the database connection), then let
 * the process end. SIGTERM is what Docker and systemd send, SIGINT is Ctrl+C and what a Windows service wrapper sends on a
 * stop, SIGBREAK is Ctrl+Break (Windows only). Without a handler Node ends at once in the middle of a request, and as the
 * first process of a container it ignores SIGTERM until Docker kills it ten seconds later.
 */
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;
/** How long the close may take before the process ends anyway (a connection that never answers its close). */
export const SHUTDOWN_TIMEOUT_MS = 10_000;
/** After a clean close the process ends by itself; this ends it when something still holds it. */
const LINGER_MS = 2_000;

type Closable = { close: () => Promise<unknown>; log: { info: (o: object, msg: string) => void; error: (o: object, msg: string) => void } };
export type ShutdownProcess = {
  on: (signal: string, listener: () => void) => unknown;
  exit: (code: number) => void;
  exitCode?: number | string | null | undefined;
};

export function installShutdown(app: Closable, proc: ShutdownProcess = process, timeoutMs = SHUTDOWN_TIMEOUT_MS): void {
  let closing = false;
  const stop = (signal: string) => {
    // A second signal while closing: the operator does not want to wait.
    if (closing) { proc.exit(1); return; }
    closing = true;
    app.log.info({ signal }, "Server wird beendet");
    const force = setTimeout(() => { app.log.error({ timeoutMs }, "Beenden dauert zu lange, Prozess endet jetzt"); proc.exit(1); }, timeoutMs);
    force.unref();
    app.close().then(() => {
      clearTimeout(force);
      // No process.exit() right here: on Windows it trips a libuv assertion while sockets are still closing.
      proc.exitCode = 0;
      setTimeout(() => proc.exit(0), LINGER_MS).unref();
    }, (err: unknown) => {
      clearTimeout(force);
      app.log.error({ err }, "Fehler beim Beenden");
      proc.exit(1);
    });
  };
  for (const signal of SHUTDOWN_SIGNALS) proc.on(signal, () => stop(signal));
}
