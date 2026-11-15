import { pluginText, type Channel, type Member, type PluginField, type PluginText, type Role } from "@squorli/protocol";
import { useEffect, useId, useState } from "react";
import { DateInput } from "./DateInput";
import { DurationInput } from "./DurationInput";
import { Icon } from "./Icon";
import { locale, t } from "./i18n";
import { channelOptions, isKnownFieldType, roleOptions } from "./pluginFields";

/** What the fields of a plugin's form choose from: the server's state as this member sees it. */
export type PluginFormContext = { roles: readonly Role[]; channels: readonly Channel[]; members: readonly Member[]; me: Member | null };

const TEXT_MAX = 2000;
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A number as it is typed: the field keeps the text, the form gets a number or nothing. */
function NumberInput({ id, value, min, max, disabled, onChange }: { id: string; value: unknown; min?: number | undefined; max?: number | undefined; disabled: boolean; onChange: (n: number | undefined) => void }) {
  const [draft, setDraft] = useState(() => (typeof value === "number" ? String(value) : ""));
  const parsed = (s: string): number | undefined => { const n = Number(s.trim().replace(",", ".")); return s.trim() && Number.isFinite(n) ? n : undefined; };
  useEffect(() => { if (value !== parsed(draft)) setDraft(typeof value === "number" ? String(value) : ""); }, [value]);
  return <input id={id} type="text" inputMode="decimal" autoComplete="off" value={draft} disabled={disabled} aria-describedby={min !== undefined || max !== undefined ? `${id}-range` : undefined}
    onChange={(e) => { setDraft(e.target.value); onChange(parsed(e.target.value)); }} />;
}

/**
 * The fields a plugin declares (its settings, a member action's dialog, a command's form), drawn with the client's own
 * controls (docs/features/plugins.md). A plugin ships no client code and no markup: labels, help and errors are
 * `PluginText`, shown as plain text. A field type this app does not know shows one line saying so and takes no value.
 *
 * `settings` = the plugin's settings in Verwaltung: role and channel fields offer what the admin may put into the plugin's
 * scope (pluginFields.ts `roleOptions`), a dialog offers only what the server's `allowed` list names.
 */
export function PluginForm({ fields, values, onChange, errors = {}, context, settings = false, disabled = false }: {
  fields: readonly PluginField[]; values: Record<string, unknown>; onChange: (key: string, value: unknown) => void;
  errors?: Record<string, PluginText>; context: PluginFormContext; settings?: boolean; disabled?: boolean;
}) {
  const base = useId();
  return (
    <div className="stack plugin-form">
      {fields.map((f) => {
        const id = `${base}-${f.key}`;
        const label = pluginText(f.label, locale);
        const value = values[f.key];
        const set = (v: unknown) => onChange(f.key, v);
        const error = errors[f.key];
        const help = f.help ? <small className="muted plugin-help">{pluginText(f.help, locale)}</small> : null;
        const problem = error ? <small className="error" role="alert">{pluginText(error, locale)}</small> : null;
        const title = <span className="plugin-label">{label}{f.required && <span className="plugin-required" title={t("plugin.field.required")} aria-label={t("plugin.field.required")}> *</span>}</span>;

        if (!isKnownFieldType(f.type)) {
          return <div key={f.key} className="plugin-field"><span className="plugin-label">{label}</span><small className="muted plugin-newer"><Icon name="circle-alert" /> {t(f.required ? "plugin.field.needsNewerAppRequired" : "plugin.field.needsNewerApp")}</small></div>;
        }
        if (f.type === "boolean") {
          return (
            <div key={f.key} className="plugin-field">
              <label className="check"><input type="checkbox" className="switch" role="switch" checked={value === true} disabled={disabled} onChange={(e) => set(e.target.checked)} /> {label}</label>
              {help}{problem}
            </div>
          );
        }
        if (f.type === "roles" || f.type === "channels") {
          const picked = list(value);
          const toggle = (optionId: string) => set(picked.includes(optionId) ? picked.filter((x) => x !== optionId) : [...picked, optionId]);
          const options = f.type === "roles"
            ? roleOptions(f, context.me, context.roles, { settings, stored: settings ? value : undefined }).map((o) => ({ id: o.id, node: o.role ? <span style={o.role.color ? { color: o.role.color } : undefined}>{o.role.name}</span> : <em className="muted">{t("chat.formerRole")}</em> }))
            : channelOptions(f, context.channels, { stored: settings ? value : undefined }).map((o) => ({ id: o.id, node: o.channel ? <span>{o.channel.kind === "voice" ? <Icon name="volume-2" /> : <Icon name="hash" />} {o.channel.name}</span> : <em className="muted">{t("plugin.field.hiddenChannel")}</em> }));
          return (
            <fieldset key={f.key} className="plugin-field plugin-ticks" disabled={disabled}>
              <legend>{title}</legend>
              {options.length === 0 && <span className="muted small">{t(f.type === "roles" ? "plugin.field.noRoles" : "plugin.field.noChannels")}</span>}
              {options.map((o) => <label key={o.id} className="check"><input type="checkbox" checked={picked.includes(o.id)} onChange={() => toggle(o.id)} /> {o.node}</label>)}
              {help}{problem}
            </fieldset>
          );
        }
        let control;
        if (f.type === "text") {
          const maxLength = Math.min(TEXT_MAX, f.maxLength ?? TEXT_MAX);
          control = f.multiline
            ? <textarea id={id} rows={4} value={text(value)} maxLength={maxLength} disabled={disabled} onChange={(e) => set(e.target.value)} />
            : <input id={id} type="text" value={text(value)} maxLength={maxLength} disabled={disabled} onChange={(e) => set(e.target.value)} />;
        } else if (f.type === "number") {
          control = <>
            <NumberInput id={id} value={value} min={f.min} max={f.max} disabled={disabled} onChange={set} />
            {(f.min !== undefined || f.max !== undefined) && <small id={`${id}-range`} className="muted">{f.min !== undefined && f.max !== undefined ? t("plugin.field.range", { min: f.min, max: f.max }) : f.min !== undefined ? t("plugin.field.min", { min: f.min }) : t("plugin.field.max", { max: f.max! })}</small>}
          </>;
        } else if (f.type === "duration") {
          control = <DurationInput id={id} label={label} value={typeof value === "number" ? value : undefined} min={f.min} max={f.max} presets={f.presets} disabled={disabled} onChange={set} />;
        } else if (f.type === "date") {
          control = <DateInput id={id} label={label} value={typeof value === "string" ? value : undefined} yearOptional={f.yearOptional === true} disabled={disabled} onChange={set} />;
        } else {
          // One of a list: the field's own options, a role, a channel or a member.
          const options: { id: string; label: string }[] =
            f.type === "select" ? (f.options ?? []).map((o) => ({ id: o.value, label: pluginText(o.label, locale) }))
            : f.type === "role" ? roleOptions(f, context.me, context.roles, { settings, stored: settings ? value : undefined }).map((o) => ({ id: o.id, label: o.role?.name ?? t("chat.formerRole") }))
            : f.type === "channel" ? channelOptions(f, context.channels, { stored: settings ? value : undefined }).map((o) => ({ id: o.id, label: o.channel ? (o.channel.kind === "voice" ? o.channel.name : `# ${o.channel.name}`) : t("plugin.field.hiddenChannel") }))
            : [...context.members].sort((a, b) => a.displayName.localeCompare(b.displayName)).map((m) => ({ id: m.userId, label: m.displayName }));
          const current = text(value);
          const empty = f.type === "role" ? "plugin.field.noRoles" : f.type === "channel" ? "plugin.field.noChannels" : null;
          control = <>
            <select id={id} value={options.some((o) => o.id === current) ? current : ""} disabled={disabled || options.length === 0} onChange={(e) => set(e.target.value || undefined)}>
              <option value="">{t("plugin.field.choose")}</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            {options.length === 0 && empty && <small className="muted">{t(empty)}</small>}
          </>;
        }
        return <div key={f.key} className="plugin-field"><label htmlFor={id}>{title}</label>{control}{help}{problem}</div>;
      })}
    </div>
  );
}
