import { BACKUP_MIN_PASSWORD, DIRECTORY_HANDLE_PREFIX, LOCAL_HANDLE_PREFIX, LocalHandle, type DeviceInfo } from "@squorli/protocol";
import { useState, type ReactNode } from "react";
import { DevicePicker } from "./DevicePicker";
import { locale, t } from "./i18n";
import { createTabs, loginPrefix, signInUnavailable, type CreateTab, type LoginKind } from "./loginView";
import { PasswordInput } from "./PasswordInput";
import { platform } from "./platform";
import { safeHref } from "./safeHref";

/**
 * The account forms of a server's login (docs/features/local-accounts.md, 25 September 2026), shared by the web client's
 * login (LoginScreen.tsx), the join view of a server added by address (App.tsx `ServerStatus`) and the registration a member
 * from before server accounts owes (`ClaimAccount`). Signing in is one form: the prefix decides, `@name` = the directory
 * account, `~name` = the server account. Only creating an account has tabs.
 */

/**
 * A sign-in failure the form handles itself: the directory's second factor, and the limit of devices (docs/features/devices.md:
 * the account's devices come with it, from the directory in `body` with a ticket, from a chat server in `limit`).
 */
type SignInError = { code?: string | null; body?: { email?: unknown; devices?: unknown; ticket?: unknown }; limit?: { devices: DeviceInfo[]; ticket: string | null } };
/** At the limit of devices: the one the user picked to make way, and the directory's ticket for the second try. */
export type DeviceChoice = { replaceDevice: string; ticket: string | null };
/** The devices and the ticket out of such a failure; null for any other. */
export function deviceLimitOf(err: unknown): { devices: DeviceInfo[]; ticket: string | null } | null {
  const e = err as SignInError;
  if (e?.code !== "too_many_devices") return null;
  if (e.limit) return e.limit;
  return { devices: Array.isArray(e.body?.devices) ? (e.body.devices as DeviceInfo[]) : [], ticket: typeof e.body?.ticket === "string" ? e.body.ticket : null };
}

export function SignInForm({ hasDirectory, localAccounts, busy, onDirectory, onLocal, onEmailCode, idPrefix }: {
  hasDirectory: boolean; localAccounts: boolean; busy: boolean;
  /** `choice`: the second try of a sign-in that met the limit of devices. */
  onDirectory: (handle: string, password: string, code?: string, choice?: DeviceChoice) => Promise<void>;
  onLocal: (handle: string, password: string, replaceDevice?: string) => Promise<void>;
  /** Mail a code for the directory's second factor; returns what to show. */
  onEmailCode: ((handle: string, password: string) => Promise<string>) | null;
  idPrefix: string;
}) {
  // What the user chose (a typed prefix, the switch); until then it follows the server, whose directory may arrive after the first render.
  const [picked, setKind] = useState<LoginKind | null>(null);
  const kind: LoginKind = picked ?? (hasDirectory ? "directory" : "local");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [emailOffered, setEmailOffered] = useState(false);
  const [emailNote, setEmailNote] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  // The account has as many devices as it may: the user picks the one that makes way (DevicePicker.tsx).
  const [limit, setLimit] = useState<{ devices: DeviceInfo[]; ticket: string | null } | null>(null);
  const both = hasDirectory && localAccounts;
  // What the typed prefix asks for, and whether this server offers it.
  const unavailable = signInUnavailable(kind, hasDirectory) ? t("login.noDirectoryForAt") : null;
  const prefix = kind === "directory" ? DIRECTORY_HANDLE_PREFIX : LOCAL_HANDLE_PREFIX;

  function type(value: string) {
    // Typing @ or ~ at the start switches the kind; the prefix itself is shown in front of the field, not in it.
    const p = loginPrefix(value);
    if (p) setKind(p);
    setName(value.replace(/^[@~]+/, "").trimStart());
    if (needCode && p) setNeedCode(false);
  }
  async function submit(replaceDevice?: string) {
    if (unavailable) return;
    try {
      if (kind === "directory") await onDirectory(name.trim(), password, code.trim() || undefined, replaceDevice && limit ? { replaceDevice, ticket: limit.ticket } : undefined);
      else await onLocal(name.trim(), password, replaceDevice);
      setPassword(""); setCode(""); setNeedCode(false); setEmailOffered(false); setEmailNote(null); setLimit(null);
    } catch (err) {
      const e = err as SignInError;
      if (kind === "directory" && e.code === "totp_required") { setNeedCode(true); setEmailOffered(e.body?.email === true && !!onEmailCode); }
      setLimit(deviceLimitOf(err));
    }
  }
  async function sendEmailCode() {
    if (!onEmailCode) return;
    setEmailBusy(true); setEmailNote(null);
    try { setEmailNote(await onEmailCode(name.trim(), password)); } finally { setEmailBusy(false); }
  }

  if (limit) return <DevicePicker devices={limit.devices} busy={busy} onPick={(id) => void submit(id)} onCancel={() => setLimit(null)} />;
  return (
    <div className="stack handle-box">
      <h2>{t("login.signInTitle")}</h2>
      <span className="muted small">{hasDirectory ? t(both ? "login.prefixHintBoth" : "login.prefixHintDirectory") : t("login.prefixHintLocal")}</span>
      <div className="login-fields">
        <label className="stack"><span>{t("login.username")}</span>
          <span className="login-handle-field">
            {both
              ? <button type="button" className="login-prefix" onClick={() => setKind(kind === "directory" ? "local" : "directory")} title={t(kind === "directory" ? "login.prefixToLocal" : "login.prefixToDirectory")} aria-label={t(kind === "directory" ? "login.prefixToLocal" : "login.prefixToDirectory")} disabled={busy}>{prefix}</button>
              : <span className="muted" aria-hidden="true">{prefix}</span>}
            <input value={name} onChange={(e) => type(e.target.value)} placeholder={t("login.handleExample")} maxLength={33} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy} aria-describedby={`${idPrefix}-handle-hint`} />
          </span>
          <small id={`${idPrefix}-handle-hint`} className={unavailable ? "error" : "muted"}>{unavailable ?? t(kind === "directory" ? "login.usernameHint" : "login.usernameHintLocal")}</small>
        </label>
        <label className="stack"><span>{t("login.password")}</span>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={busy}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
        </label>
      </div>
      {needCode && (
        <div className="login-fields">
          <label className="stack"><span>{t("login.codePlaceholder")}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={20} autoFocus disabled={busy}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          </label>
          {emailOffered && <button type="button" className="secondary" onClick={() => void sendEmailCode()} disabled={busy || emailBusy}>{emailBusy ? t("login.emailCodeSending") : t("login.emailCode")}</button>}
        </div>
      )}
      {needCode && emailNote && <span className="muted small">{emailNote}</span>}
      <button className="login-primary" onClick={() => void submit()} disabled={busy || !!unavailable || name.trim().length < 3 || password.length < BACKUP_MIN_PASSWORD || (needCode && code.trim().length < 6)}>{busy ? t("login.connecting") : t("login.signIn")}</button>
    </div>
  );
}

/** A link out of the client: a new tab in the browser, the system's browser in the desktop app (like "Konto anlegen"). */
function ExternalLink({ url, children }: { url: string; children: ReactNode }) {
  const href = safeHref(url);
  if (href === undefined) return <>{children}</>;
  return <a href={href} target="_blank" rel="noreferrer" onClick={platform.home ? undefined : (e) => { e.preventDefault(); platform.links.openExternal(href); }}>{children}</a>;
}

/** The directory's privacy policy and rules of use: its redirects to the operator's website, in the client's language. */
const directoryPageUrl = (directoryUrl: string, page: "datenschutz" | "regeln"): string => `${directoryUrl.replace(/\/+$/, "")}/${page}?lang=${locale}`;

/**
 * The sentence under a form that creates an account (2 October 2026, docs/features/local-accounts.md): by creating it the
 * user accepts the privacy policy, a link, no checkbox (the directory's account page says the same). `text` holds `{link}`.
 */
function PrivacyNote({ text, url, rulesUrl }: { text: string; url: string; rulesUrl?: string }) {
  // `{rules}` (the directory's rules of use, 2 October 2026) is optional; the server's sentence has only `{link}`.
  const parts = text.split(/(\{link\}|\{rules\})/);
  return <p className="muted small">{parts.map((part, i) => part === "{link}" ? <ExternalLink key={i} url={url}>{t("login.privacyPolicy")}</ExternalLink>
    : part === "{rules}" && rulesUrl ? <ExternalLink key={i} url={rulesUrl}>{t("login.rulesOfUse")}</ExternalLink> : part)}</p>;
}

/**
 * The fields of a new server account: `~handle` (checked while typing), the password twice, the warning that nobody can reset
 * it, and the server's privacy policy where the operator named one (`privacyPolicyUrl`, health; nothing otherwise).
 */
export function LocalRegisterForm({ busy, checkFree, onRegister, submitLabel, idPrefix, ownerSetup = false, privacyPolicyUrl = null }: {
  busy: boolean; checkFree: ((handle: string) => Promise<boolean>) | null;
  /** `ownerCode`: the setup code the owner typed (only with `ownerSetup`); empty = none, an ordinary registration. */
  onRegister: (handle: string, password: string, ownerCode?: string) => Promise<void>; submitLabel?: string; idPrefix: string;
  /** The server waits for its owner (health `ownerSetup`): a field for the setup code from the installation. */
  ownerSetup?: boolean;
  /** The server's privacy policy (health `privacyPolicyUrl`); null = none named. */
  privacyPolicyUrl?: string | null;
}) {
  const [handle, setHandle] = useState("");
  const [ownerCode, setOwnerCode] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [taken, setTaken] = useState<string | null>(null);
  const clean = handle.trim().toLowerCase();
  const valid = LocalHandle.safeParse(clean).success;
  const mismatch = pw2.length > 0 && pw !== pw2;
  async function check() {
    if (!checkFree || !valid) return;
    const free = await checkFree(clean).catch(() => true);
    setTaken(free ? null : clean);
  }
  async function submit() {
    if (!valid || pw.length < BACKUP_MIN_PASSWORD || pw !== pw2) return;
    try { await onRegister(clean, pw, ownerSetup && ownerCode.trim() ? ownerCode.trim() : undefined); setPw(""); setPw2(""); }
    catch (err) { if ((err as { code?: string | null }).code === "handle_taken") setTaken(clean); }
  }
  return (
    <div className="stack">
      <div className="login-fields">
        <label className="stack"><span>{t("login.chooseHandle")}</span>
          <span className="login-handle-field">
            <span className="muted" aria-hidden="true">{LOCAL_HANDLE_PREFIX}</span>
            <input value={handle} onChange={(e) => { setHandle(e.target.value.trimStart().replace(/^~+/, "")); setTaken(null); }} onBlur={() => void check()}
              placeholder={t("login.handleExample")} maxLength={32} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy} aria-describedby={`${idPrefix}-new-handle`} />
          </span>
          <small id={`${idPrefix}-new-handle`} className={taken === clean && clean ? "error" : "muted"}>{taken === clean && clean ? t("local.handle_taken") : t("login.localHandleRules")}</small>
        </label>
        <label className="stack"><span>{t("login.password")}</span>
          <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t("login.passwordMin", { n: BACKUP_MIN_PASSWORD })} autoComplete="new-password" disabled={busy} />
        </label>
        <label className="stack"><span>{t("login.passwordRepeat")}</span>
          <PasswordInput value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" disabled={busy} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          {mismatch && <small className="error">{t("login.passwordMismatch")}</small>}
        </label>
        {ownerSetup && (
          <label className="stack"><span>{t("login.ownerCode")}</span>
            <input value={ownerCode} onChange={(e) => setOwnerCode(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128} disabled={busy} aria-describedby={`${idPrefix}-owner-code`} />
            <small id={`${idPrefix}-owner-code`} className="muted">{t("login.ownerCodeHint")}</small>
          </label>
        )}
      </div>
      <p className="muted small">{t("login.localPasswordWarning")}</p>
      {privacyPolicyUrl && <PrivacyNote text={t("login.privacyServer")} url={privacyPolicyUrl} />}
      <button className="login-primary" onClick={() => void submit()} disabled={busy || !valid || taken === clean || pw.length < BACKUP_MIN_PASSWORD || pw !== pw2}>{busy ? t("login.registering") : submitLabel ?? t("login.createLocal")}</button>
    </div>
  );
}

/**
 * Creating an account. With a directory its account is the main way (the first tab, a link to the directory's page, or
 * `directoryTab` where the form lives here); the server account is a second tab where the server allows them. Without a
 * directory only the server account's form, no tabs.
 */
export function CreateAccount({ directoryUrl, localAccounts, busy, local, directoryTab, openExternal }: {
  directoryUrl: string | null; localAccounts: boolean; busy: boolean;
  /** The server account's form (LocalRegisterForm). */
  local: ReactNode;
  /** What the directory tab shows instead of the link to the directory's page. */
  directoryTab?: ReactNode;
  openExternal: ((url: string) => void) | null;
}) {
  const tabs = createTabs(!!directoryUrl, localAccounts);
  // The tab the user chose; until then the first one, which follows the directory once the server has named it.
  const [tab, setTab] = useState<CreateTab | null>(null);
  const dirHost = directoryUrl ? new URL(directoryUrl).host : "";
  if (tabs.length === 0) return null;
  const shown = tab && tabs.includes(tab) ? tab : tabs[0]!;
  return (
    <div className="stack handle-box">
      <h2>{t("login.createTitle")}</h2>
      {tabs.length > 1 && (
        <nav className="login-choices" aria-label={t("login.createChoice")}>
          <button type="button" className="secondary" aria-pressed={shown === "directory"} disabled={busy} onClick={() => setTab("directory")}>{t("login.createDirectoryTab")}</button>
          <button type="button" className="secondary" aria-pressed={shown === "local"} disabled={busy} onClick={() => setTab("local")}>{t("login.createLocalTab")}</button>
        </nav>
      )}
      {shown === "directory" && directoryUrl && (directoryTab ?? (
        <div className="login-create-row">
          <a href={safeHref(directoryUrl)} target="_blank" rel="noreferrer" onClick={openExternal ? (e) => { e.preventDefault(); openExternal(directoryUrl); } : undefined}>{t("login.createAccount")}</a>
          <p className="muted small">{t("login.createDirectoryHint", { host: dirHost })}</p>
        </div>
      ))}
      {shown === "local" && <>
        <span className="muted small">{t(directoryUrl ? "login.createLocalHint" : "login.createLocalHintOnly")}</span>
        {local}
      </>}
    </div>
  );
}

/** A directory handle for the key this member is signed in with (the directory tab of `ClaimAccount`). */
function DirectoryClaimForm({ directoryUrl, busy, emailRequired, onRegister }: {
  directoryUrl: string; busy: boolean; emailRequired: boolean;
  onRegister: (handle: string, email?: string, code?: string) => Promise<"done" | "failed" | { sentTo: string }>;
}) {
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const clean = handle.trim().toLowerCase();
  async function submit() {
    const r = await onRegister(clean, emailRequired ? email.trim() : undefined, sentTo ? code.trim() : undefined);
    if (typeof r === "object") setSentTo(r.sentTo);
  }
  return (
    <div className="stack">
      <span className="muted small">{t("claim.directoryHint")}</span>
      <label className="stack"><span>{t("login.chooseHandle")}</span>
        <span className="login-handle-field">
          <span className="muted" aria-hidden="true">{DIRECTORY_HANDLE_PREFIX}</span>
          <input value={handle} onChange={(e) => setHandle(e.target.value.trimStart().replace(/^@+/, ""))} maxLength={32} autoCapitalize="none" spellCheck={false} disabled={busy || !!sentTo} />
        </span>
        <small className="muted">{t("login.handleRules")}</small>
      </label>
      {emailRequired && (
        <label className="stack"><span>{t("login.registerEmail")}</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" disabled={busy || !!sentTo} />
          <small className="muted">{t("login.registerEmailHint")}</small>
        </label>
      )}
      {sentTo && (
        <label className="stack"><span>{t("login.registerCode")}</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={8} autoComplete="one-time-code" autoFocus disabled={busy} />
          <small className="muted">{t("login.registerCodeSent", { to: sentTo })}</small>
        </label>
      )}
      <PrivacyNote text={t("login.privacyDirectory")} url={directoryPageUrl(directoryUrl, "datenschutz")} rulesUrl={directoryPageUrl(directoryUrl, "regeln")} />
      <button className="login-primary" onClick={() => void submit()} disabled={busy || !LocalHandle.safeParse(clean).success || (emailRequired && !email.includes("@")) || (!!sentTo && code.trim().length !== 8)}>
        {busy ? t("login.registering") : emailRequired && !sentTo ? t("login.registerSendCode") : t("login.registerHandle")}
      </button>
    </div>
  );
}

/**
 * A member from before server accounts (`me.registrationRequired`, docs/features/local-accounts.md): their key, messages and
 * roles stay, but the server lets them in only with an account. Same tabs as creating one; the account is made for the key
 * they are signed in with.
 */
export function ClaimAccount({ serverName, directoryUrl, localAccounts, emailRequired, error, onClaimLocal, onClaimDirectory, onLogout, checkFree, privacyPolicyUrl }: {
  serverName: string; directoryUrl: string | null; localAccounts: boolean; emailRequired: boolean; error: string | null;
  onClaimLocal: (handle: string, password: string) => Promise<void>;
  onClaimDirectory: (handle: string, email?: string, code?: string) => Promise<"done" | "failed" | { sentTo: string }>;
  onLogout: () => void;
  checkFree: ((handle: string) => Promise<boolean>) | null;
  /** The server's privacy policy (health `privacyPolicyUrl`), for the server account's form. */
  privacyPolicyUrl: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => { setBusy(true); try { return await fn(...a); } finally { setBusy(false); } };
  return (
    <div className="stack">
      <h2>{t("claim.title")}</h2>
      <p className="muted">{t("claim.text", { server: serverName })}</p>
      {error && <p className="error">{error}</p>}
      <CreateAccount directoryUrl={directoryUrl} localAccounts={localAccounts} busy={busy} openExternal={null}
        directoryTab={directoryUrl ? <DirectoryClaimForm directoryUrl={directoryUrl} busy={busy} emailRequired={emailRequired} onRegister={wrap(onClaimDirectory)} /> : undefined}
        local={<LocalRegisterForm idPrefix="claim" busy={busy} checkFree={checkFree} onRegister={wrap(onClaimLocal)} submitLabel={t("claim.submit")} privacyPolicyUrl={privacyPolicyUrl} />} />
      <button type="button" className="secondary" onClick={onLogout} disabled={busy}>{t("profile.signOut")}</button>
    </div>
  );
}

/** Einstellungen > Konto for a server account: a new password (the old one proves it), and deleting the account on this server. */
export function LocalAccountSettings({ handle, serverName, onChangePassword, onDelete }: {
  handle: string; serverName: string;
  onChangePassword: (oldPassword: string, newPassword: string) => Promise<void>;
  onDelete: (password: string) => Promise<void>;
}) {
  const [oldPw, setOldPw] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [delPw, setDelPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true); setNote(null);
    try { await fn(); setNote({ ok: true, text: done }); }
    catch (err) { setNote({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(false); }
  }
  return (
    <div className="stack">
      <p>{t("login.handle")}: <strong>{LOCAL_HANDLE_PREFIX}{handle}</strong> <span className="muted small">{t("login.localAccountOf", { server: serverName })}</span></p>
      <h3>{t("local.changePassword")}</h3>
      <label className="stack"><span>{t("local.oldPassword")}</span>
        <PasswordInput value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" disabled={busy} />
      </label>
      <label className="stack"><span>{t("local.newPassword")}</span>
        <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t("login.passwordMin", { n: BACKUP_MIN_PASSWORD })} autoComplete="new-password" disabled={busy} />
      </label>
      <label className="stack"><span>{t("login.passwordRepeat")}</span>
        <PasswordInput value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" disabled={busy} />
        {pw2.length > 0 && pw !== pw2 && <small className="error">{t("login.passwordMismatch")}</small>}
      </label>
      <div className="row">
        <button className="secondary" disabled={busy || !oldPw || pw.length < BACKUP_MIN_PASSWORD || pw !== pw2}
          onClick={() => void run(async () => { await onChangePassword(oldPw, pw); setOldPw(""); setPw(""); setPw2(""); }, t("local.passwordChanged"))}>{t("local.changePassword")}</button>
      </div>
      <p className="muted small">{t("login.localPasswordWarning")}</p>
      <h3>{t("local.deleteTitle")}</h3>
      <p className="muted small">{t("local.deleteText", { server: serverName })}</p>
      <label className="stack"><span>{t("login.password")}</span>
        <PasswordInput value={delPw} onChange={(e) => setDelPw(e.target.value)} autoComplete="current-password" disabled={busy} />
      </label>
      <div className="row">
        <button className="danger" disabled={busy || !delPw} onClick={() => void run(() => onDelete(delPw), t("local.deleted"))}>{t("local.delete")}</button>
      </div>
      {note && <p className={note.ok ? "muted small" : "error small"} role="status">{note.text}</p>}
    </div>
  );
}
