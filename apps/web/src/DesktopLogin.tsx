import { BACKUP_MIN_PASSWORD, type DeviceInfo } from "@squorli/protocol";
import { useState } from "react";
import * as api from "./api";
import { deviceLimitOf } from "./AccountForms";
import { DevicePicker } from "./DevicePicker";
import { askConfirm } from "./dialogs";
import type { State, Store } from "./store";
import { LOCALES, locale, t } from "./i18n";
import { platform } from "./platform";
import { PasswordInput } from "./PasswordInput";
import { loginView, type LoginChoice } from "./loginView";
import { safeHref } from "./safeHref";

/**
 * Login of a client without a home server (the desktop app, docs/features/desktop.md). The directory account comes first:
 * handle + password fetch the key from the directory (code with an active authenticator), then the account's servers are
 * connected and the one viewed last is shown. Below it: go on with server accounts only (docs/features/local-accounts.md):
 * servers are added by address and each one wants an account of its own (`~name`), made or signed in to in its join view;
 * signing in with the directory account later keeps them. The web client's login (`LoginScreen.tsx`) signs in on the server
 * that serves the page instead.
 */
export function DesktopLogin({ store, state }: { store: Store; state: State }) {
  const busy = state.clientLogin.busy;
  const dirHost = state.directoryUrl ? new URL(state.directoryUrl).host : null;
  const account = state.directoryAccount;
  const [choice, setChoice] = useState<LoginChoice | null>(null);
  const { showAccount, showDevice } = loginView(!!state.directoryUrl, !!account, false, choice);
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  // Code by e-mail: offered when the directory says (after the correct password) that the account has a confirmed address.
  const [emailOffered, setEmailOffered] = useState(false);
  const [emailNote, setEmailNote] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const cleanHandle = handle.trim().replace(/^@/, "");
  // The account has as many devices as it may (docs/features/devices.md): the user picks the one that makes way.
  const [limit, setLimit] = useState<{ devices: DeviceInfo[]; ticket: string | null } | null>(null);

  async function signIn(replaceDevice?: string) {
    // Another account replaces this device's key; the same handle only fetches the key it already has.
    if (account && !replaceDevice && account.handle.toLowerCase() !== cleanHandle.toLowerCase()) {
      const ok = await askConfirm({ title: t("login.replaceKeyTitle"), text: t(account.hasBackup ? "login.replaceKeyText" : "login.replaceKeyTextNoBackup", { handle: account.handle }), confirmLabel: t("login.replace"), danger: true });
      if (!ok) return;
    }
    try {
      await store.loginDirectoryAccount(cleanHandle, password, code.trim() || undefined, replaceDevice && limit ? { replaceDevice, ticket: limit.ticket } : undefined);
      setPassword(""); setCode(""); setNeedCode(false); setEmailOffered(false); setEmailNote(null); setLimit(null);
    } catch (err) {
      const e = err as { code?: string | null; body?: { email?: unknown } };
      if (e.code === "totp_required") { setNeedCode(true); setEmailOffered(e.body?.email === true); }
      setLimit(deviceLimitOf(err));
    }
  }
  async function sendEmailCode() {
    const url = state.directoryUrl;
    if (!url) return;
    setEmailBusy(true); setEmailNote(null);
    try { setEmailNote(t("login.emailCodeSent", { to: (await api.directoryEmailCode(url, cleanHandle, password)).sentTo })); }
    catch (err) { setEmailNote(api.explainDirectoryError(err)); }
    finally { setEmailBusy(false); }
  }

  return (
    <main className="login auth-login">
      <div className="login-card">
        <header className="login-head">
          <img className="login-icon" src="/brand/squorli-icon.svg" alt="" width="72" height="72" />
          <h1>Squorli</h1>
        </header>
        {state.clientLogin.error && <p className="error">{state.clientLogin.error}</p>}

        {state.directoryUrl && <>
          <nav className="login-choices" aria-label={t("login.accessChoice")}>
            <button type="button" className="secondary" aria-pressed={showAccount} disabled={busy} onClick={() => setChoice("account")}>{t("login.withAccount")}</button>
            <button type="button" className="secondary" aria-pressed={showDevice} disabled={busy} onClick={() => setChoice("device")}>{t(account ? "login.savedAccount" : "desktopLogin.serverAccountsOnly")}</button>
          </nav>
          <div className="login-create-row">
            <a href={safeHref(state.directoryUrl)} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); platform.links.openExternal(state.directoryUrl!); }}>{t("login.createAccount")}</a>
            <p className="muted small">{t("login.createDirectoryHint", { host: dirHost ?? "" })}</p>
          </div>
        </>}

        {showAccount && limit && <DevicePicker devices={limit.devices} busy={busy} onPick={(id) => void signIn(id)} onCancel={() => setLimit(null)} />}
        {showAccount && !limit && (
          <div className="stack handle-box">
            <h2>{t("login.withAccount")}</h2>
            <span className="muted small">{t("desktopLogin.accountHint", { host: dirHost ?? "" })}</span>
            <div className="login-fields">
              <label className="stack"><span>{t("login.username")}</span>
                <span className="login-handle-field">
                  <span className="muted" aria-hidden="true">@</span>
                  <input value={handle} onChange={(e) => setHandle(e.target.value.trimStart().replace(/^@+/, ""))} placeholder={t("login.handleExample")} maxLength={33} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus disabled={busy} aria-describedby="desktop-handle-hint" />
                </span>
                <small id="desktop-handle-hint" className="muted">{t("login.usernameHint")}</small>
              </label>
              <label className="stack"><span>{t("login.password")}</span>
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={busy}
                onKeyDown={(e) => { if (e.key === "Enter") void signIn(); }} />
              </label>
            </div>
            {needCode && (
              <div className="login-fields">
                <label className="stack"><span>{t("login.codePlaceholder")}</span>
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("login.codePlaceholder")} inputMode="numeric" autoComplete="one-time-code" maxLength={20} autoFocus disabled={busy}
                  onKeyDown={(e) => { if (e.key === "Enter") void signIn(); }} />
                </label>
                {emailOffered && <button type="button" className="secondary" onClick={() => void sendEmailCode()} disabled={busy || emailBusy}>{emailBusy ? t("login.emailCodeSending") : t("login.emailCode")}</button>}
              </div>
            )}
            {needCode && emailNote && <span className="muted small">{emailNote}</span>}
            <button className="login-primary" onClick={() => void signIn()} disabled={busy || cleanHandle.length < 3 || password.length < BACKUP_MIN_PASSWORD || (needCode && code.trim().length < 6)}>{busy ? t("login.connecting") : t("login.signIn")}</button>
          </div>
        )}

        {showDevice && <div className="stack handle-box">
          <h2>{t(account ? "login.savedAccount" : "desktopLogin.serverAccountsOnly")}</h2>
          <p className="muted small">{t(account ? "login.savedHint" : "desktopLogin.serverAccountsHint")}</p>
          {account && <p className="muted small">{t("login.savedSignOutHint")}</p>}
          {account
            ? <p>{t("login.handle")}: <strong>@{account.handle}</strong> <span className="muted small">{t("login.verifiedAt", { host: dirHost ?? "" })}</span></p>
            : null}
          {state.directoryError && <p className="error small">{state.directoryError}</p>}
          <details className="login-details">
            <summary>{t("desktopLogin.deviceKey")}</summary>
            <code className="key">{state.identity?.publicKey ?? "…"}</code>
            <button className="secondary" onClick={() => void store.forgetIdentity()} disabled={busy}>{t("login.forgetIdentity")}</button>
          </details>
          <button className="login-primary" onClick={() => store.continueWithDeviceKey()} disabled={!state.identity || busy}>{account ? t("desktopLogin.continueAs", { handle: account.handle }) : t("desktopLogin.serverAccountsOnly")}</button>
        </div>}
        {!showDevice && state.directoryError && <p className="error small">{state.directoryError}</p>}
      </div>
      <footer className="login-foot">
        <img src="/brand/squorli-icon-small.svg" alt="" width="18" height="18" />
        <span>{t("desktopLogin.app")}{platform.app ? ` · ${t("login.version", { v: platform.app.version })}` : ""}</span>
        <div className="login-languages" role="group" aria-label={t("common.language")}>
          {LOCALES.map((l) => <button key={l} type="button" className="secondary" lang={l} aria-pressed={locale === l}
            onClick={() => { if (l !== locale) void store.setLocale(l); }}>{t(`lang.${l}`)}</button>)}
        </div>
      </footer>
    </main>
  );
}
