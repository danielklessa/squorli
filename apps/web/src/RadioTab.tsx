import { RadioUrl, type RadioStation, type ServerState } from "@squorli/protocol";
import { useEffect, useState } from "react";
import type { ServerApi } from "./api";
import { askConfirm } from "./dialogs";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { platform } from "./platform";

type RunFn = (fn: () => Promise<unknown>) => Promise<void>;

/** Admin area > Radio: the server's list of web radio stations (name + stream or playlist address). Changes come back via the structure event. */
export function RadioTab({ api, server, run }: { api: ServerApi; server: ServerState; run: RunFn }) {
  const stations = server.radioStations ?? [];
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const urlOk = RadioUrl.safeParse(url).success;
  const insecure = [url, ...stations.map((s) => s.url)].some((u) => u.trim().toLowerCase().startsWith("http://")) && platform.media.blocksInsecureMedia;
  const add = () => run(async () => { await api.createRadioStation({ name: name.trim(), url: url.trim() }); setName(""); setUrl(""); });
  return (
    <div className="stack">
      <p className="muted small">{t("admin.radio.intro")}</p>
      {server.settings.radioAutoStop !== undefined && (
        <label className="check">
          <input type="checkbox" className="switch" role="switch" checked={server.settings.radioAutoStop} onChange={(e) => run(() => api.updateSettings({ radioAutoStop: e.target.checked }))} />
          {t("admin.radio.autoStop")}
        </label>
      )}
      <form className="radio-station-row" onSubmit={(e) => { e.preventDefault(); if (name.trim() && urlOk) void add(); }}>
        <input value={name} maxLength={64} placeholder={t("admin.radio.name")} aria-label={t("admin.radio.name")} onChange={(e) => setName(e.target.value)} />
        <input value={url} maxLength={2048} type="url" inputMode="url" placeholder="https://…" aria-label={t("admin.radio.url")} onChange={(e) => setUrl(e.target.value)} />
        <button type="submit" disabled={!name.trim() || !urlOk}>{t("admin.radio.add")}</button>
      </form>
      {url.trim() !== "" && !urlOk && <span className="error small">{t("admin.radio.invalidUrl")}</span>}
      {insecure && <span className="muted small">{t("admin.radio.httpHint")}</span>}
      {stations.length === 0 && <p className="muted">{t("admin.radio.none")}</p>}
      {stations.map((s) => <StationRow key={s.id} api={api} station={s} run={run} />)}
    </div>
  );
}

function StationRow({ api, station, run }: { api: ServerApi; station: RadioStation; run: RunFn }) {
  const [name, setName] = useState(station.name);
  const [url, setUrl] = useState(station.url);
  // Somebody else saved this station meanwhile: show their values.
  useEffect(() => { setName(station.name); setUrl(station.url); }, [station.name, station.url]);
  const changed = name.trim() !== station.name || url.trim() !== station.url;
  const valid = name.trim() !== "" && RadioUrl.safeParse(url).success;
  const remove = async () => {
    if (await askConfirm({ title: t("admin.radio.deleteTitle", { name: station.name }), text: t("admin.radio.deleteText"), confirmLabel: t("common.delete"), danger: true })) await run(() => api.deleteRadioStation(station.id));
  };
  return (
    <form className="radio-station-row" onSubmit={(e) => { e.preventDefault(); if (changed && valid) void run(() => api.updateRadioStation(station.id, { name: name.trim(), url: url.trim() })); }}>
      <input value={name} maxLength={64} aria-label={t("admin.radio.name")} onChange={(e) => setName(e.target.value)} />
      <input value={url} maxLength={2048} type="url" inputMode="url" aria-label={t("admin.radio.url")} onChange={(e) => setUrl(e.target.value)} />
      <span className="radio-station-actions">
        <button type="submit" className="secondary small" disabled={!changed || !valid}>{t("common.save")}</button>
        <button type="button" className="icon danger" title={t("common.delete")} aria-label={t("common.delete")} onClick={() => { void remove(); }}><Icon name="trash-2" /></button>
      </span>
    </form>
  );
}
