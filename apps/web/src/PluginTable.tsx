import { pluginText, type Channel, type Member, type PluginViewResponse, type Role } from "@squorli/protocol";
import type { ReactNode } from "react";
import { durationLabel } from "./DurationInput";
import { fmtDateTime, locale, t } from "./i18n";

const TEXT_MAX = 300;

/** A cell without a type, or of a type this app does not know: its value as plain text. */
function plain(value: unknown): string {
  if (value === null || value === undefined || value === "") return "–";
  const s = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value) ?? "";
  return s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s;
}

/** A point in time as a plugin hands it over: milliseconds or an ISO string; null when it is neither. */
export function timeOf(value: unknown): string | null {
  const ms = typeof value === "number" ? value : typeof value === "string" && value ? Date.parse(value) : Number.NaN;
  // A Date takes ±8.64e15 ms; beyond that toISOString throws.
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}

/**
 * A plugin's view (Verwaltung > Plugins, docs/features/plugins.md): the columns its manifest declares, the rows its
 * handler returned. The plugin supplies data only: a `member`, `role` or `channel` cell holds an id this client resolves
 * with its own state (a member who left and a deleted role get the words they get everywhere), a `time` cell milliseconds
 * or an ISO string shown in the client's locale, a `duration` cell seconds. A column type of a later version is text.
 */
export function PluginTable({ view, members, roles, channels }: { view: PluginViewResponse; members: readonly Member[]; roles: readonly Role[]; channels: readonly Channel[] }) {
  const cell = (type: string, value: unknown): ReactNode => {
    if (value === null || value === undefined || value === "") return "–";
    if (type === "member") return members.find((m) => m.userId === value)?.displayName ?? <em className="muted">{t("chat.formerMember")}</em>;
    if (type === "role") { const r = roles.find((x) => x.id === value); return r ? <span style={r.color ? { color: r.color } : undefined}>{r.name}</span> : <em className="muted">{t("chat.formerRole")}</em>; }
    if (type === "channel") { const c = channels.find((x) => x.id === value); return c ? (c.kind === "voice" ? c.name : `# ${c.name}`) : <em className="muted">{t("plugin.field.hiddenChannel")}</em>; }
    if (type === "time") { const iso = timeOf(value); return iso ? <time dateTime={iso}>{fmtDateTime(iso)}</time> : plain(value); }
    if (type === "duration") return typeof value === "number" && Number.isFinite(value) && value >= 0 ? durationLabel(value) : plain(value);
    return plain(value);
  };
  if (view.rows.length === 0) return <p className="muted small">{t("admin.plugins.viewEmpty")}</p>;
  return (
    <div className="plugin-table-wrap">
      <table className="plugin-table">
        <thead><tr>{view.columns.map((c) => <th key={c.key} scope="col">{pluginText(c.label, locale)}</th>)}</tr></thead>
        <tbody>
          {view.rows.map((row, i) => <tr key={i}>{view.columns.map((c) => <td key={c.key}>{cell(c.type, row[c.key])}</td>)}</tr>)}
        </tbody>
      </table>
      {view.truncated && <p className="muted small">{t("admin.plugins.viewTruncated", { n: view.rows.length })}</p>}
    </div>
  );
}
