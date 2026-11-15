import { pluginText, type PluginActionResult, type PluginField, type PluginText } from "@squorli/protocol";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { pluginProblem, type PluginProblem } from "./apiErrorText";
import { useBackClose } from "./backStack";
import { Icon } from "./Icon";
import { locale, t } from "./i18n";
import { PluginForm, type PluginFormContext } from "./PluginForm";
import { blockedByUnknown, initialValues, submitValues } from "./pluginFields";

/**
 * The fixed line on top of everything a plugin causes on screen (docs/features/plugins.md): "Plugin: <name>" with the one
 * icon all plugins share. It is the client's own, a plugin cannot change or leave it out, so a plugin's dialog can never
 * pass for one of the app's (a password prompt, a confirmation). A plugin supplies no icon and no markup.
 */
export function PluginChrome({ name, children }: { name: PluginText; children?: ReactNode }) {
  return <header className="modal-head plugin-chrome"><Icon name="puzzle" /><span className="plugin-chrome-name">{t("plugin.chrome", { name: pluginText(name, locale) })}</span><span className="spacer" />{children}</header>;
}

/** A refusal of the plugin routes: the catalog's sentence, and below it the server's own technical line where it sent one. */
export function PluginProblemText({ problem }: { problem: PluginProblem | null }) {
  if (!problem) return null;
  return <div className="plugin-problem" role="alert"><p className="error">{problem.text}</p>{problem.detail && <pre className="plugin-problem-detail">{problem.detail}</pre>}</div>;
}

/**
 * The dialog of a member action or of a command with a form: the fixed chrome, a title, the plugin's fields, one button.
 * `onSubmit` gets the values of the fields this app drew and answers with the plugin's result: its `message` is shown here
 * (to the caller only), `fieldErrors` under their fields; a refusal of the server (ApiError) as its mapped sentence.
 * After a success the form makes way for the message and a close button.
 */
export function PluginFormDialog({ pluginName, title, intro, fields, submitLabel, context, onSubmit, onClose }: {
  pluginName: PluginText; title: string; intro?: ReactNode; fields: readonly PluginField[]; submitLabel?: PluginText | undefined; context: PluginFormContext;
  onSubmit: (values: Record<string, unknown>) => Promise<PluginActionResult>; onClose: () => void;
}) {
  const titleId = useId();
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(fields));
  const [fieldErrors, setFieldErrors] = useState<Record<string, PluginText>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<PluginActionResult | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [problem, setProblem] = useState<PluginProblem | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const blocked = blockedByUnknown(fields);
  useBackClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  useEffect(() => { if (done) closeRef.current?.focus(); }, [done]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || blocked) return;
    setBusy(true); setProblem(null); setRefused(null); setFieldErrors({});
    try {
      const r = await onSubmit(submitValues(fields, values));
      if (r.ok) setDone(r);
      else {
        setFieldErrors(r.fieldErrors ?? {});
        const said = pluginText(r.message, locale);
        setRefused(said || (r.fieldErrors && Object.keys(r.fieldErrors).length > 0 ? t("plugin.checkFields") : t("plugin.notDone")));
      }
    } catch (err) { setProblem(pluginProblem(err)); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={onClose}>
      <div className="modal dialog plugin-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
        <PluginChrome name={pluginName}><button type="button" className="icon" onClick={onClose} title={t("common.close")}><Icon name="x" /></button></PluginChrome>
        <form className="dialog-body stack" onSubmit={(e) => void submit(e)}>
          <h2 id={titleId}>{title}</h2>
          {intro}
          {done ? (
            <>
              <p className="plugin-result" role="status"><Icon name="check" /> <span>{pluginText(done.message, locale) || t("plugin.done")}</span></p>
              <div className="dialog-actions"><button ref={closeRef} type="button" onClick={onClose}>{t("common.close")}</button></div>
            </>
          ) : (
            <>
              <PluginForm fields={fields} values={values} errors={fieldErrors} context={context} disabled={busy} onChange={(key, v) => setValues((cur) => ({ ...cur, [key]: v }))} />
              {blocked && <p className="warn-box small">{t("plugin.blockedByNewer")}</p>}
              {refused && <p className="error" role="alert">{refused}</p>}
              <PluginProblemText problem={problem} />
              <div className="dialog-actions">
                <button type="button" className="secondary" onClick={onClose}>{t("common.cancel")}</button>
                <button type="submit" disabled={busy || blocked}>{busy ? t("plugin.running") : pluginText(submitLabel, locale) || t("plugin.submit")}</button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
