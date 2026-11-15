import { useEffect, useState } from "react";
import { DURATION_UNITS, durationRange, formatDuration, fromSeconds, parseAmount, toSeconds, usablePresets, type DurationLabelUnit, type DurationUnit } from "./duration";
import { localeTag, t } from "./i18n";

/** "3 Tage", "1 Woche", "1,5 Minuten": the catalog's words for duration.ts. */
export function durationLabel(seconds: number): string {
  return formatDuration(seconds, (unit: DurationLabelUnit, amount) => {
    const n = amount.toLocaleString(localeTag, { maximumFractionDigits: 2 });
    const one = amount === 1;
    switch (unit) {
      case "seconds": return t(one ? "plugin.duration.secondsOne" : "plugin.duration.secondsMany", { n });
      case "minutes": return t(one ? "plugin.duration.minutesOne" : "plugin.duration.minutesMany", { n });
      case "hours": return t(one ? "plugin.duration.hoursOne" : "plugin.duration.hoursMany", { n });
      case "days": return t(one ? "plugin.duration.daysOne" : "plugin.duration.daysMany", { n });
      case "weeks": return t(one ? "plugin.duration.weeksOne" : "plugin.duration.weeksMany", { n });
    }
  });
}

const unitName = (unit: DurationUnit): string =>
  unit === "minutes" ? t("plugin.duration.unitMinutes") : unit === "hours" ? t("plugin.duration.unitHours") : unit === "days" ? t("plugin.duration.unitDays") : t("plugin.duration.unitWeeks");

/**
 * A length of time: a number, a unit (minutes, hours, days, weeks) and the field's suggestions as buttons. The value is
 * whole seconds, undefined while nothing usable is typed (docs/features/plugins.md; the arithmetic is duration.ts).
 */
export function DurationInput({ value, onChange, min, max, presets, disabled = false, id, label }: {
  value: number | undefined; onChange: (seconds: number | undefined) => void; min?: number | undefined; max?: number | undefined; presets?: readonly number[] | undefined; disabled?: boolean; id?: string; label: string;
}) {
  const shown = (seconds: number | undefined): { text: string; unit: DurationUnit } => {
    if (seconds === undefined) return { text: "", unit: "days" };
    const { amount, unit } = fromSeconds(seconds);
    return { text: String(amount), unit };
  };
  const [draft, setDraft] = useState(() => shown(value));
  const typed = toSeconds(parseAmount(draft.text), draft.unit) ?? undefined;
  // A value from outside (a preset, the stored settings) replaces what is typed; what the typing itself produced does not.
  useEffect(() => { if (value !== typed) setDraft((cur) => (value === undefined ? { ...cur, text: "" } : shown(value))); }, [value]);
  const edit = (next: { text: string; unit: DurationUnit }) => { setDraft(next); onChange(toSeconds(parseAmount(next.text), next.unit) ?? undefined); };
  const range = durationRange(min, max);
  const offered = usablePresets(presets, min, max);
  const outside = value !== undefined && (value < range.min || value > range.max);
  return (
    <div className="duration-input">
      <div className="duration-row">
        <input id={id} type="text" inputMode="decimal" autoComplete="off" className="duration-amount" aria-label={label} value={draft.text} disabled={disabled} onChange={(e) => edit({ ...draft, text: e.target.value })} />
        <select className="duration-unit" aria-label={t("plugin.duration.unit")} value={draft.unit} disabled={disabled} onChange={(e) => edit({ ...draft, unit: e.target.value as DurationUnit })}>
          {DURATION_UNITS.map((u) => <option key={u} value={u}>{unitName(u)}</option>)}
        </select>
      </div>
      {offered.length > 0 && (
        <div className="duration-presets">
          {offered.map((p) => <button key={p} type="button" className={`secondary small${value === p ? " active" : ""}`} aria-pressed={value === p} disabled={disabled} onClick={() => onChange(p)}>{durationLabel(p)}</button>)}
        </div>
      )}
      {outside && <small className="muted">{value! < range.min ? t("plugin.duration.atLeast", { span: durationLabel(range.min) }) : t("plugin.duration.atMost", { span: durationLabel(range.max) })}</small>}
    </div>
  );
}
