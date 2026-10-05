import { BACKUP_NEW_MIN_PASSWORD, type InvitePreview } from "@squorli/protocol";
import { useEffect, useState } from "react";
import * as api from "./api";
import { askConfirm } from "./dialogs";
import { homeState, type State, type Store } from "./store";
import { LOCALES, locale, t } from "./i18n";
import { DOWNLOAD_URL } from "./appUpdates";
import { platform } from "./platform";
import { formatDeepLink, parseDeepLink } from "./platform/deepLink";
import { ClaimAccount, CreateAccount, LocalRegisterForm, SignInForm, type DeviceChoice } from "./AccountForms";
import { PasswordInput } from "./PasswordInput";
import { safeHref } from "./safeHref";

/** Invite code from /invite/<code> or ?invite=<code>. */
export function inviteFromUrl(): string | null {
  const m = window.location.pathname.match(/^\/invite\/([A-Za-z0-9_-]{6,32})/);
  if (m) return m[1]!;
  return new URLSearchParams(window.location.search).get("invite");
}

/**
 * Login of the server that serves the page (docs/features/local-accounts.md, 25 September 2026). There are no temporary users:
 * every sign-in is an account. One sign-in form whose prefix decides (`@name` = the directory account, `~name` = a server
 * account of this server); a key that has a directory handle already continues with one click. Creating an account has tabs:
 * the directory's account first where the server has one, the server account where the server allows it.
 */
export function LoginScreen({ store, state }: { store: Store; state: State }) {
  // Only a client with a home server shows this login (App.tsx); one without has DesktopLogin.tsx.
  const home = homeState(state)!;
  const [invite, setInvite] = useState(() => inviteFromUrl() ?? "");
  const [needInvite, setNeedInvite] = useState(() => !!inviteFromUrl());
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const busy = home.connection === "logging-in" || home.connection === "connecting";
  const dirHost = state.directoryUrl ? new URL(state.directoryUrl).host : null;
  // The server account this browser keeps for this server wins: the server signs in with its key (store.identityFor).
  const savedLocal = state.serverAccounts[home.host] ?? null;
  const saved = savedLocal ? null : state.directoryAccount;

  // Existing directory account: create a password backup when it is still missing.
  const [backupPw, setBackupPw] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);

  useEffect(() => {
    const code = invite.trim();
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(code)) { setPreview(null); return; }
    let alive = true;
    store.home!.api.getInvitePreview(code).then((p) => { if (alive) setPreview(p); }).catch(() => { if (alive) setPreview(null); });
    return () => { alive = false; };
  }, [invite]);

  function afterLogin() {
    if (window.location.pathname.startsWith("/invite/")) window.history.replaceState(null, "", "/");
  }
  function onLoginError(err: unknown) {
    const code = (err as { code?: string | null }).code;
    if (code === "invite_required" || code === "invite_invalid") setNeedInvite(true);
    throw err;
  }
  const inviteCode = () => invite.trim() || undefined;

  async function continueSaved() {
    try { await store.login(inviteCode()); afterLogin(); }
    catch (err) { try { onLoginError(err); } catch { /* shown by the server's state */ } }
  }
  async function signInDirectory(handle: string, password: string, code?: string, choice?: DeviceChoice) {
    // Another directory account replaces this browser's key; the same handle only fetches the key it already has.
    if (saved && !choice && saved.handle.toLowerCase() !== handle.toLowerCase()) {
      const ok = await askConfirm({
        title: t("login.replaceKeyTitle"),
        text: t(saved.hasBackup ? "login.replaceKeyText" : "login.replaceKeyTextNoBackup", { handle: saved.handle }),
        confirmLabel: t("login.replace"), danger: true,
      });
      if (!ok) return;
    }
    try { await store.loginWithHandle(handle, password, inviteCode(), code, choice); afterLogin(); }
    catch (err) { onLoginError(err); }
  }
  async function signInLocal(handle: string, password: string, replaceDevice?: string) {
    try { await store.loginLocal(home.host, handle, password, inviteCode(), replaceDevice); afterLogin(); }
    catch (err) { onLoginError(err); }
  }
  async function registerLocal(handle: string, password: string, ownerCode?: string) {
    try { await store.registerLocal(home.host, handle, password, inviteCode(), ownerCode); afterLogin(); }
    catch (err) { onLoginError(err); }
  }
  async function backup() {
    setBackupBusy(true);
    try { if (await store.createBackup(backupPw)) setBackupPw(""); } finally { setBackupBusy(false); }
  }

  // "Open in the desktop app": a plain link the user clicks (never a redirect: without the app nothing would happen), always
  // next to the download. Offered where the app exists (Windows, Linux). The link goes through the parser, so it is only
  // shown when the app will accept it.
  const appLink = (() => {
    if (platform.kind !== "web" || (platform.os !== "windows" && platform.os !== "linux")) return null;
    const host = home.serverDomain ?? window.location.host;
    const code = invite.trim();
    const raw = /^[A-Za-z0-9_-]{6,32}$/.test(code) ? `squorli://invite/${host}/${code}` : `squorli://server/${host}`;
    const link = parseDeepLink(raw);
    return link ? formatDeepLink(link) : null;
  })();

  const showInvite = needInvite || !!invite || home.inviteRequired;
  const claim = home.me?.registrationRequired === true;
  // Without a directory every account here is a server account; the server reports it as allowed then.
  // The owner registers a server account with the setup code even where server accounts are off (health `ownerSetup`).
  const localAccounts = home.localAccounts || !state.directoryUrl || home.ownerSetup;

  const savedBox = saved && !claim && (
    <div className="stack handle-box">
      <h2>{t("login.savedAccount")}</h2>
      <p>{t("login.handle")}: <strong>@{saved.handle}</strong> <span className="muted small">{t("login.verifiedAt", { host: dirHost ?? "" })}</span></p>
      {saved.hasBackup ? (
        <span className="muted small">{t("login.backupPresent", { handle: saved.handle })}</span>
      ) : (
        <>
          <label className="stack"><span>{t("login.setPasswordFor", { handle: saved.handle })}</span>
            <PasswordInput value={backupPw} onChange={(e) => setBackupPw(e.target.value)} placeholder={t("login.passwordMin", { n: BACKUP_NEW_MIN_PASSWORD })} autoComplete="new-password" disabled={backupBusy}
              onKeyDown={(e) => { if (e.key === "Enter") void backup(); }} />
          </label>
          <button className="secondary" onClick={() => void backup()} disabled={backupBusy || backupPw.length < BACKUP_NEW_MIN_PASSWORD}>{backupBusy ? t("login.saving") : t("login.setPassword")}</button>
          <span className="muted small">{t("login.backupHint")}</span>
        </>
      )}
      <button className="login-primary" onClick={() => void continueSaved()} disabled={!state.identity || busy}>{busy ? t("login.connecting") : t("desktopLogin.continueAs", { handle: saved.handle })}</button>
      {state.directoryAccount && <p className="muted small"><a href={safeHref(`${state.directoryUrl ?? ""}/?handle=${encodeURIComponent(saved.handle)}`)} target="_blank" rel="noreferrer">{t("login.manageAccount")}</a> {t("login.manageAccountHint")}</p>}
    </div>
  );

  return (
    <main className="login auth-login">
      <div className="login-card">
        <header className="login-head">
          <img className="login-icon" src={home.iconUrl ?? "/brand/squorli-icon.svg"} alt="" width="72" height="72" />
          <h1>{home.serverName ?? "Squorli"}</h1>
        </header>
        {preview && (
          <p className="invite-preview">
            {t("login.inviteTo")} <strong>{preview.serverName}</strong> · {t("login.memberCount", { n: preview.memberCount })}
            {!preview.valid && <span className="error"> · {t("login.inviteInvalid")}</span>}
          </p>
        )}
        {home.removed && (
          <p className="error">
            {home.removed.reason === "banned" ? t("login.bannedShort") : t("login.removedShort")}
            {home.removed.message ? `: ${home.removed.message}` : "."}
          </p>
        )}
        {!claim && home.error && <p className="error">{home.error}</p>}
        {!claim && home.accountNeeded && <p className="muted">{t("login.accountNeeded")}</p>}

        {claim ? (
          <ClaimAccount serverName={home.serverName ?? home.host} directoryUrl={state.directoryUrl} localAccounts={localAccounts} emailRequired={state.directoryEmailRequired} error={home.error}
            onClaimLocal={(handle, pw) => store.claimLocal(home.host, handle, pw)} onClaimDirectory={(handle, email, code) => store.claimDirectory(home.host, handle, email, code)}
            onLogout={() => store.logout()} checkFree={(h) => store.home!.api.localHandleFree(h)} privacyPolicyUrl={home.privacyPolicyUrl} />
        ) : <>
          {/* Always there when the server takes new members by invite only (user's wish, 19 September 2026); it holds the code of an invite link. */}
          {showInvite && (
            <label className="stack">
              <span>{t("login.inviteCode")}</span>
              <input value={invite} maxLength={32} onChange={(e) => setInvite(e.target.value)} placeholder={t("login.invitePlaceholder")} autoFocus={needInvite && !invite} />
              {home.inviteRequired && <span className="muted small">{t("login.inviteRequiredHint")}</span>}
            </label>
          )}
          {savedBox}
          {savedLocal && (
            <div className="stack handle-box">
              <h2>{t("login.savedAccount")}</h2>
              <p>{t("login.handle")}: <strong>~{savedLocal}</strong> <span className="muted small">{t("login.localAccountOf", { server: home.serverName ?? home.host })}</span></p>
              <button className="login-primary" onClick={() => void continueSaved()} disabled={busy}>{busy ? t("login.connecting") : t("login.continueAsLocal", { handle: savedLocal })}</button>
            </div>
          )}
          <SignInForm idPrefix="login" hasDirectory={!!state.directoryUrl} localAccounts={localAccounts} busy={busy}
            onDirectory={signInDirectory} onLocal={signInLocal}
            onEmailCode={state.directoryUrl ? async (handle, pw) => {
              try { return t("login.emailCodeSent", { to: (await api.directoryEmailCode(state.directoryUrl!, handle, pw)).sentTo }); }
              catch (err) { return api.explainDirectoryError(err); }
            } : null} />
          <CreateAccount directoryUrl={state.directoryUrl} localAccounts={localAccounts} busy={busy} openExternal={null}
            local={<LocalRegisterForm idPrefix="login" busy={busy} ownerSetup={home.ownerSetup} privacyPolicyUrl={home.privacyPolicyUrl} checkFree={(h) => store.home!.api.localHandleFree(h)} onRegister={registerLocal} />} />
          {state.directoryError && <p className="error small">{state.directoryError}</p>}
          <details className="login-details">
            <summary>{t("login.deviceKey")}</summary>
            <code className="key">{state.identity?.publicKey ?? "…"}</code>
            <button type="button" className="secondary" onClick={() => void store.forgetIdentity()} disabled={busy}>{t("login.forgetIdentity")}</button>
          </details>
          <div className="row">
            {!showInvite && <button className="secondary" onClick={() => setNeedInvite(true)}>{t("login.haveInvite")}</button>}
          </div>
        </>}
      </div>
      {appLink && <p className="login-app muted small">{t("login.appHint")} <a href={appLink}>{t("login.openInApp")}</a> · <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">{t("login.getApp")}</a><br />{t("login.keysHint")}</p>}
      <footer className="login-foot">
        <img src="/brand/squorli-icon-small.svg" alt="" width="18" height="18" />
        <span>{t("login.poweredBy")}{home.serverVersion ? ` · ${t("login.version", { v: home.serverVersion })}` : ""}</span>
        <div className="login-languages" role="group" aria-label={t("common.language")}>
          {LOCALES.map((l) => <button key={l} type="button" className="secondary" lang={l} aria-pressed={locale === l}
            onClick={() => { if (l !== locale) void store.setLocale(l); }}>{t(`lang.${l}`)}</button>)}
        </div>
      </footer>
    </main>
  );
}
