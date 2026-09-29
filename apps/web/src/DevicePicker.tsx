import { DEVICE_MAX, type DeviceInfo } from "@squorli/protocol";
import { useState } from "react";
import { deviceLabel, deviceTimes } from "./DevicesTab";
import { t } from "./i18n";

/**
 * A sign-in that met the limit of devices (docs/features/devices.md; the user's decision of 29 September 2026: at most ten
 * devices, and the user picks which one makes way). The password and the second factor were right already; the list came
 * with the refusal. Picking a device signs it out and enrols this one in its place. Shown inside the sign-in form that
 * holds the password (AccountForms.tsx `SignInForm`, DesktopLogin.tsx).
 */
export function DevicePicker({ devices, busy, onPick, onCancel }: { devices: DeviceInfo[]; busy: boolean; onPick: (id: string) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="stack handle-box device-picker" role="group" aria-label={t("devices.limitTitle")}>
      <h2>{t("devices.limitTitle")}</h2>
      <span className="muted small">{t("devices.limitText", { n: DEVICE_MAX })}</span>
      <ul className="session-list">
        {devices.map((d) => (
          <li key={d.id}>
            <label className="device-choice">
              <input type="radio" name="device-makes-way" checked={picked === d.id} disabled={busy} onChange={() => setPicked(d.id)} />
              <span className="stack">
                <strong>{deviceLabel(d)}</strong>
                <span className="muted small">{deviceTimes(d)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="danger" disabled={busy || picked === null} onClick={() => { if (picked) onPick(picked); }}>{busy ? t("login.connecting") : t("devices.limitPick")}</button>
        <button className="secondary" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}
