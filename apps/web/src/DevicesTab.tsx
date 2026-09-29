import { DESKTOP_APP_ORIGIN, type DeviceInfo } from "@squorli/protocol";
import { useCallback, useEffect, useState } from "react";
import { fmtDateTime, t } from "./i18n";
import { PasswordInput } from "./PasswordInput";

/** Where a device signed in from, as the lists say it: the site's host, or the desktop app by its name; "" if unknown. */
export const deviceOrigin = (origin: string | null): string => (origin === DESKTOP_APP_ORIGIN ? t("devices.viaApp") : origin ? t("devices.via", { origin }) : "");
/** What a device is called in the lists: browser and system, and where it signed in from. */
export const deviceLabel = (d: Pick<DeviceInfo, "label" | "origin">): string => [d.label ?? t("profile.unknownDevice"), deviceOrigin(d.origin)].filter(Boolean).join(" ");
/** When it signed in and when it was last used, in one line. */
export const deviceTimes = (d: Pick<DeviceInfo, "createdAt" | "lastSeenAt">): string => `${t("profile.signedIn", { date: fmtDateTime(d.createdAt) })}${d.lastSeenAt ? ` · ${t("profile.lastActive", { date: fmtDateTime(d.lastSeenAt) })}` : ""}`;

/**
 * Einstellungen > Geräte (docs/features/devices.md, 29 September 2026; until then the sessions of one server): the devices
 * that are signed in with the account, and signing them out for good. A directory account's list is the directory's and
 * holds for every server; a server account's is that server's. Signing another device out asks for the password (and, for
 * a directory account with the authenticator on, a code): whoever sits at an unlocked device must not sign the owner out.
 */
export function DevicesTab({ scope, account, canRevoke, hasPassword, load, revoke }: {
  scope: "directory" | "local";
  /** `@handle` or `~handle`, as it is shown. */
  account: string;
  /** The directory signs devices out (its `features.deviceRevoke`); a server account's server always does. */
  canRevoke: boolean;
  /** The account has a password; without one nothing proves the owner, and nothing can be signed out. */
  hasPassword: boolean;
  load: () => Promise<DeviceInfo[]>;
  /** `target` = a device's id or "others"; throws with a translated message and the code (`totp_required`, `auth_invalid`). */
  revoke: (target: string, password: string, code?: string) => Promise<DeviceInfo[]>;
}) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The sign-out that waits for the password: a device, or all others.
  const [asking, setAsking] = useState<{ target: string; label: string } | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setDevices(await load()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [load]);
  useEffect(() => { void refresh(); }, [refresh]);

  function ask(target: string, label: string) {
    setAsking({ target, label }); setPassword(""); setCode(""); setNeedCode(false); setFormError(null); setNote(null);
  }
  function cancel() { setAsking(null); setPassword(""); setCode(""); setFormError(null); }
  async function submit() {
    if (!asking || busy) return;
    setBusy(true); setFormError(null);
    try {
      const before = devices?.length ?? 0;
      const list = await revoke(asking.target, password, code.trim() || undefined);
      setDevices(list);
      setNote(asking.target === "others" ? t("devices.doneOthers", { n: Math.max(before - list.length, 0) }) : t("devices.doneOne", { label: asking.label }));
      cancel();
    } catch (e) {
      const c = (e as { code?: string | null }).code;
      if (c === "totp_required") setNeedCode(true);
      setFormError(c === "auth_invalid" ? t("devices.wrongPassword") : e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const others = devices?.filter((d) => !d.current).length ?? 0;
  const offered = canRevoke && hasPassword;
  return (
    <>
      <h3>{t("profile.devices")}</h3>
      <span className="muted small">{t(scope === "directory" ? "devices.hintDirectory" : "devices.hintLocal", { account })}</span>
      {!canRevoke && <span className="muted small">{t("devices.soon")}</span>}
      {canRevoke && !hasPassword && <span className="muted small">{t("devices.noPassword")}</span>}
      {error && <p className="error small">{error}</p>}
      {devices === null ? (!error && <span className="muted">{t("common.loading")}</span>) : (
        <ul className="session-list">
          {devices.length === 0 && <li className="muted">{t("devices.none")}</li>}
          {devices.map((d) => (
            <li key={d.id}>
              <div className="stack">
                <span><strong>{deviceLabel(d)}</strong>{d.current && <span className="badge">{t("profile.thisDevice")}</span>}{d.kind === "page" && <span className="badge">{t("devices.page")}</span>}</span>
                <span className="muted small">{deviceTimes(d)}</span>
              </div>
              <span className="spacer" />
              {!d.current && offered && <button className="secondary small" disabled={busy} aria-pressed={asking?.target === d.id} onClick={() => ask(d.id, deviceLabel(d))}>{t("profile.signOut")}</button>}
            </li>
          ))}
        </ul>
      )}
      {asking ? (
        <form className="stack handle-box device-ask" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <strong>{asking.target === "others" ? t("profile.revokeOthersTitle") : t("profile.revokeDeviceTitle")}</strong>
          <span>{asking.target === "others" ? t("devices.askOthers") : t("devices.askOne", { label: asking.label })}</span>
          <label className="stack"><span>{t("devices.password", { account })}</span>
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus disabled={busy} />
          </label>
          {needCode && (
            <label className="stack"><span>{t("login.codePlaceholder")}</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={20} autoFocus disabled={busy} />
            </label>
          )}
          {formError && <span className="error small" role="alert">{formError}</span>}
          <div className="row">
            <button type="submit" className="danger" disabled={busy || password.length === 0 || (needCode && code.trim().length < 6)}>{busy ? t("devices.working") : asking.target === "others" ? t("profile.signOutAll") : t("profile.signOut")}</button>
            <button type="button" className="secondary" disabled={busy} onClick={cancel}>{t("common.cancel")}</button>
          </div>
        </form>
      ) : (
        <div className="row">
          {offered && <button className="secondary" disabled={busy || others === 0} onClick={() => ask("others", "")}>{t("profile.signOutOthers")}{others ? ` (${others})` : ""}</button>}
          <button className="secondary" disabled={busy} onClick={() => void refresh()}>{t("common.refresh")}</button>
          {note && <span className="muted small" role="status">{note}</span>}
        </div>
      )}
    </>
  );
}
