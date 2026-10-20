import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useBackClose } from "./backStack";
import { t } from "./i18n";

/**
 * Replacement for window.confirm/prompt: an own modal that sits above everything.
 * askConfirm() and askInput() return promises; DialogHost renders the currently active dialog.
 * There is only ever one dialog at a time; further ones wait in the queue.
 */
type Base = { title: string; text?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean };
export type ConfirmOptions = Base;
export type InputOptions = Base & { label?: string; placeholder?: string; initial?: string; maxLength?: number; optional?: boolean };
/** A message with one close button; a click beside the dialog or Escape closes it too (voice notices and errors, 22 September 2026). */
export type NoticeOptions = { title: string; text: string; closeLabel?: string };
/** One choice out of a short list (radio buttons); the ban's "delete messages of the last ..." (docs/features/reports.md). */
export type SelectOptions = Base & { options: { value: string; label: string }[]; initial?: string };

type Pending =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "input"; opts: InputOptions; resolve: (value: string | null) => void }
  | { kind: "notice"; opts: NoticeOptions; resolve: () => void }
  | { kind: "select"; opts: SelectOptions; resolve: (value: string | null) => void };

const queue: Pending[] = [];
let notify: (() => void) | null = null;
const enqueue = (p: Pending) => { queue.push(p); notify?.(); };
const finish = () => { queue.shift(); notify?.(); };

export const askConfirm = (opts: ConfirmOptions) => new Promise<boolean>((resolve) => enqueue({ kind: "confirm", opts, resolve }));
export const askInput = (opts: InputOptions) => new Promise<string | null>((resolve) => enqueue({ kind: "input", opts, resolve }));
export const showNotice = (opts: NoticeOptions) => new Promise<void>((resolve) => enqueue({ kind: "notice", opts, resolve }));
export const askSelect = (opts: SelectOptions) => new Promise<string | null>((resolve) => enqueue({ kind: "select", opts, resolve }));

export function DialogHost() {
  const [, rerender] = useState(0);
  useEffect(() => { notify = () => rerender((n) => n + 1); return () => { notify = null; }; }, []);
  const current = queue[0];
  if (!current) return null;
  return current.kind === "confirm"
    ? <ConfirmDialog key={queue.length} opts={current.opts} onDone={(ok) => { current.resolve(ok); finish(); }} />
    : current.kind === "notice"
      ? <NoticeDialog key={queue.length} opts={current.opts} onDone={() => { current.resolve(); finish(); }} />
      : current.kind === "select"
        ? <SelectDialog key={queue.length} opts={current.opts} onDone={(v) => { current.resolve(v); finish(); }} />
        : <InputDialog key={queue.length} opts={current.opts} onDone={(v) => { current.resolve(v); finish(); }} />;
}

function SelectDialog({ opts, onDone }: { opts: SelectOptions; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(opts.initial ?? opts.options[0]?.value ?? "");
  return (
    <Frame opts={opts} onCancel={() => onDone(null)}>
      <div className="stack" role="radiogroup">
        {opts.options.map((o, i) => (
          <label key={o.value} className="check"><input type="radio" name="dialog-select" autoFocus={i === 0} checked={value === o.value} onChange={() => setValue(o.value)} /> {o.label}</label>
        ))}
      </div>
      <div className="dialog-actions">
        <button className="secondary" onClick={() => onDone(null)}>{opts.cancelLabel ?? t("common.cancel")}</button>
        <button className={opts.danger ? "danger" : ""} onClick={() => onDone(value)}>{opts.confirmLabel ?? t("common.ok")}</button>
      </div>
    </Frame>
  );
}

function NoticeDialog({ opts, onDone }: { opts: NoticeOptions; onDone: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <Frame opts={opts} onCancel={onDone}>
      <div className="dialog-actions">
        <button ref={ref} className="secondary" onClick={onDone}>{opts.closeLabel ?? t("common.close")}</button>
      </div>
    </Frame>
  );
}

function Frame({ opts, onCancel, children }: { opts: Base; onCancel: () => void; children: ReactNode }) {
  useBackClose(onCancel);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={onCancel}>
      <div className="modal dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="dialog-title">{opts.title}</h2>
        {opts.text && <p className="dialog-text">{opts.text}</p>}
        {children}
      </div>
    </div>
  );
}

function ConfirmDialog({ opts, onDone }: { opts: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <Frame opts={opts} onCancel={() => onDone(false)}>
      <div className="dialog-actions">
        <button className="secondary" onClick={() => onDone(false)}>{opts.cancelLabel ?? t("common.cancel")}</button>
        <button ref={ref} className={opts.danger ? "danger" : ""} onClick={() => onDone(true)}>{opts.confirmLabel ?? t("common.ok")}</button>
      </div>
    </Frame>
  );
}

function InputDialog({ opts, onDone }: { opts: InputOptions; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(opts.initial ?? "");
  const ok = opts.optional || value.trim().length > 0;
  const submit = () => { if (ok) onDone(value.trim()); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
  return (
    <Frame opts={opts} onCancel={() => onDone(null)}>
      <label className="stack">{opts.label ?? ""}
        <input autoFocus value={value} placeholder={opts.placeholder} maxLength={opts.maxLength ?? 200} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} />
      </label>
      <div className="dialog-actions">
        <button className="secondary" onClick={() => onDone(null)}>{opts.cancelLabel ?? t("common.cancel")}</button>
        <button className={opts.danger ? "danger" : ""} disabled={!ok} onClick={submit}>{opts.confirmLabel ?? t("common.ok")}</button>
      </div>
    </Frame>
  );
}
