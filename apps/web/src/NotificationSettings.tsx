import { useState } from "react";
import { t } from "./i18n";
import { loadNotificationSettings, saveNotificationSettings, type NotificationSettings as Settings } from "./notifications";
import { platform } from "./platform";
import type { NotifyPermission } from "./platform/types";

/**
 * Settings > Töne, "Benachrichtigungen" (docs/features/notifications.md): a choice of this device, not of the account,
 * because whether the system may show them is one too. A browser asks for the permission inside the click that switches them on.
 */
export function NotificationSettings() {
  const desktop = platform.kind === "desktop";
  const [settings, setSettings] = useState<Settings>(() => loadNotificationSettings(desktop));
  const [permission, setPermission] = useState<NotifyPermission>(() => platform.notifications.permission());
  const change = (next: Settings) => { setSettings(next); saveNotificationSettings(next); };
  const toggle = async (on: boolean) => {
    let p = permission;
    if (on && p === "default") { p = await platform.notifications.request(); setPermission(p); }
    if (on && p !== "granted") return;
    change({ ...settings, on });
  };
  const usable = permission === "granted" || permission === "default";
  const active = settings.on && permission === "granted";
  const hint = permission === "unsupported" ? t(desktop ? "notify.unsupportedApp" : platform.mobile ? "notify.unsupportedMobile" : "notify.unsupported")
    : permission === "denied" ? t(desktop ? "notify.deniedApp" : "notify.denied")
    : t("notify.hint");
  return (
    <>
      <h3>{t("notify.head")}</h3>
      <label className="check">
        <input type="checkbox" checked={active} disabled={!usable} onChange={(e) => void toggle(e.target.checked)} />
        {t("notify.on")}
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.preview} disabled={!active} onChange={(e) => change({ ...settings, preview: e.target.checked })} />
        {t("notify.preview")}
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.dmPreview} disabled={!active} onChange={(e) => change({ ...settings, dmPreview: e.target.checked })} />
        {t("notify.previewDm")}
      </label>
      {platform.notifications.knowsFullscreen && (
        <label className="check">
          <input type="checkbox" checked={settings.fullscreen} disabled={!active} onChange={(e) => change({ ...settings, fullscreen: e.target.checked })} />
          {t("notify.fullscreen")}
        </label>
      )}
      <div className="row">
        <button disabled={!active} onClick={() => platform.notifications.show({ title: "Squorli", body: t("notify.testBody"), tag: "test", inFullscreen: true })}>{t("notify.test")}</button>
      </div>
      <span className="muted small">{hint}</span>
    </>
  );
}
