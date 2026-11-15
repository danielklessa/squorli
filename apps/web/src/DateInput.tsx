import { useEffect, useState } from "react";
import { localeTag, t } from "./i18n";
import { dateDraftOf, dateValueOf, daysWithoutYear, pickerValueOf, withDayMonth, withPicked, type DateDraft } from "./pluginFields";

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const monthName = (month: number): string => new Date(Date.UTC(2000, month - 1, 1)).toLocaleDateString(localeTag, { month: "long", timeZone: "UTC" });

/**
 * A plugin's `date` field (docs/features/plugins.md): the browser's date picker, value "YYYY-MM-DD". A field with
 * `yearOptional` has a switch below it, "Ohne Jahr angeben": on, the picker makes way for a day and a month and the value
 * is "--MM-DD". No year stands on screen while none is given (a picker would have to show one), and nobody has to type a
 * year they do not want to give. The year picked before is kept while the dialog is open, so the switch off again brings
 * the whole date back; without one the picker comes back empty, never with an invented year. undefined = nothing picked.
 * The rules are pluginFields.ts (`DateDraft`, tested).
 */
export function DateInput({ value, onChange, yearOptional = false, disabled = false, id, label }: {
  value: string | undefined; onChange: (value: string | undefined) => void; yearOptional?: boolean; disabled?: boolean; id?: string; label: string;
}) {
  const [draft, setDraft] = useState<DateDraft>(() => dateDraftOf(value, yearOptional));
  const own = dateValueOf(draft, yearOptional);
  // A value from outside (the stored settings, a default) replaces the draft; what the draft itself produced does not.
  useEffect(() => { if (value !== own) setDraft(dateDraftOf(value, yearOptional)); }, [value]);
  const edit = (next: DateDraft) => { setDraft(next); onChange(dateValueOf(next, yearOptional)); };
  const noYear = yearOptional && draft.noYear;
  return (
    <div className="date-input">
      {noYear ? (
        <div className="date-row" role="group" aria-label={label}>
          <select id={id} className="date-day" aria-label={t("plugin.date.day")} value={draft.day ?? ""} disabled={disabled} onChange={(e) => edit(withDayMonth(draft, { day: e.target.value ? Number(e.target.value) : null }))}>
            <option value="">{t("plugin.date.day")}</option>
            {Array.from({ length: daysWithoutYear(draft.month) }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select className="date-month" aria-label={t("plugin.date.month")} value={draft.month ?? ""} disabled={disabled} onChange={(e) => edit(withDayMonth(draft, { month: e.target.value ? Number(e.target.value) : null }))}>
            <option value="">{t("plugin.date.month")}</option>
            {MONTHS.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
        </div>
      ) : (
        // Four-digit years only: the value's form is YYYY-MM-DD (Chromium would take six digits).
        <input id={id} type="date" className="date-picker" aria-label={label} min="0001-01-01" max="9999-12-31" value={pickerValueOf(draft)} disabled={disabled} onChange={(e) => edit(withPicked(draft, e.target.value))} />
      )}
      {yearOptional && (
        <label className="check date-no-year">
          <input type="checkbox" className="switch" role="switch" checked={draft.noYear} disabled={disabled} onChange={(e) => edit({ ...draft, noYear: e.target.checked })} />
          {t("plugin.date.noYear")}
        </label>
      )}
    </div>
  );
}
