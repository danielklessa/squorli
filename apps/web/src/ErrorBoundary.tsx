import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "./i18n";

/**
 * An error while rendering takes down every component up to the nearest boundary. Without one React removes the whole
 * client and only the window's background is left, with nothing to press (user's report, 28 September 2026,
 * docs/features/ui-admin.md). This boundary stands around the whole client (main.tsx) and shows `fallback` in its place.
 * Free of the platform, so it can be tested; main.tsx hands in what belongs to the desktop app.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback: (error: unknown) => ReactNode; onError?: () => void }, { failed: boolean; error: unknown }> {
  // `failed` of its own: anything can be thrown, also null.
  state = { failed: false, error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { failed: true, error }; }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("the client's interface failed", error, info.componentStack);
    this.props.onError?.();
  }
  render() { return this.state.failed ? this.props.fallback(this.state.error) : this.props.children; }
}

/** What went wrong, in one line for a report to the developers; never longer than 500 characters. */
export function describeError(error: unknown): string {
  let text: string;
  try { text = error instanceof Error ? `${error.name}: ${error.message}` : String(error); } catch { text = "?"; }
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

/**
 * The notice in the client's place, in the look of the start and offline cards. Reloading is the way back: the store and
 * the voice client live outside of React and are still there, so mounting the client once more would put a second pair
 * next to them. A voice connection keeps running behind this notice and ends with the reload, which the text says.
 */
export function CrashScreen({ error, onReload }: { error: unknown; onReload: () => void }) {
  return (
    <div className="app-starting server-offline app-crashed" role="alert">
      <div className="app-starting-card">
        <img src="/brand/squorli-icon.svg" alt="" />
        <h2>{t("crash.title")}</h2>
        <p>{t("crash.text")}</p>
        <div className="row"><button autoFocus onClick={onReload}>{t("crash.reload")}</button></div>
        <details className="crash-details"><summary>{t("crash.details")}</summary><pre>{describeError(error)}</pre></details>
      </div>
    </div>
  );
}
