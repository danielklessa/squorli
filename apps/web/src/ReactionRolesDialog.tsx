import { emojiKey, type Member, type Message, type ReactionRole, type Role } from "@squorli/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerApi } from "./api";
import { reactionRuleErrorText } from "./apiErrorText";
import { EmojiPicker } from "./EmojiPicker";
import { Icon } from "./Icon";
import { assignableRoles } from "./memberRank";
import { SaveButton } from "./SaveButton";
import { t } from "./i18n";

/**
 * The reaction roles of one message (docs/features/reactions.md): a list of rules "emoji gives role", each with the switch
 * that takes the role away again when the reaction goes. Opened from the shield in a message's toolbar (MANAGE_ROLES).
 * The roles offered are the ones the user may give (`assignableRoles`, the server's `canTouchRole` and `canGrant`), never
 * the default role; a change of role or switch writes at once (an upsert), the new rule with the save button. A plain
 * modal, one section, so no categories.
 */
export function ReactionRolesDialog({ message, roles, me, api, onClose }: { message: Message; roles: readonly Role[]; me: Member; api: ServerApi; onClose: () => void }) {
  const [rules, setRules] = useState<ReactionRole[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const offered = assignableRoles(me, roles);
  const [emoji, setEmoji] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string>(offered[0]?.id ?? "");
  const [remove, setRemove] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickButton = useRef<HTMLButtonElement>(null);
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "?";

  const load = useCallback(() => api.reactionRules(message.id).then((r) => setRules(r.rules), (e) => setErr(reactionRuleErrorText(e))), [api, message.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !pickerOpen) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pickerOpen]);

  const write = async (rule: { emoji: string; roleId: string; removeOnUnreact: boolean }) => {
    setErr(null);
    try { setRules((await api.setReactionRule(message.id, rule)).rules); } catch (e) { setErr(reactionRuleErrorText(e)); throw e; }
  };
  const remove1 = async (rule: ReactionRole) => {
    setErr(null);
    try { await api.deleteReactionRule(rule.id); setRules((cur) => cur?.filter((r) => r.id !== rule.id) ?? cur); } catch (e) { setErr(reactionRuleErrorText(e)); }
  };
  const add = async () => {
    if (!emoji || !roleId) return;
    await write({ emoji, roleId, removeOnUnreact: remove });
    setEmoji(null); setRemove(false);
  };
  const taken = new Set((rules ?? []).map((r) => emojiKey(r.emoji)));

  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={onClose}>
      <div className="modal dialog rr-dialog" role="dialog" aria-modal="true" aria-labelledby="rr-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="rr-title">{t("rr.title")}</h2>
          <span className="spacer" />
          <button className="icon" onClick={onClose} title={t("common.close")}><Icon name="x" /></button>
        </header>
        <div className="dialog-body stack">
          <blockquote className="report-excerpt muted">{message.content ? message.content.slice(0, 200) : t("chat.attachments", { n: message.attachments.length })}</blockquote>
          <p className="muted small">{t("rr.hint")}</p>
          {rules === null ? <p className="muted">{t("common.loading")}</p> : rules.length === 0 ? <p className="muted">{t("rr.none")}</p> : (
            <ul className="rr-list">
              {rules.map((rule) => {
                const mayEdit = offered.some((r) => r.id === rule.roleId);
                return (
                  <li key={rule.id} className="rr-row">
                    <span className="emoji rr-emoji">{rule.emoji}</span>
                    <select className="rr-role" aria-label={t("rr.role")} value={rule.roleId} disabled={!mayEdit} onChange={(e) => void write({ emoji: rule.emoji, roleId: e.target.value, removeOnUnreact: rule.removeOnUnreact }).catch(() => undefined)}>
                      {!mayEdit && <option value={rule.roleId}>{roleName(rule.roleId)}</option>}
                      {offered.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                    <label className="check small"><input type="checkbox" checked={rule.removeOnUnreact} disabled={!mayEdit} onChange={(e) => void write({ emoji: rule.emoji, roleId: rule.roleId, removeOnUnreact: e.target.checked }).catch(() => undefined)} /> {t("rr.removeOnUnreact")}</label>
                    <button className="icon" title={t("common.delete")} disabled={!mayEdit} onClick={() => void remove1(rule)}><Icon name="trash-2" /></button>
                  </li>
                );
              })}
            </ul>
          )}
          <fieldset className="rr-add stack">
            <legend>{t("rr.add")}</legend>
            {offered.length === 0 ? <p className="muted small">{t("rr.noRoles")}</p> : (
              <>
                <div className="rr-row">
                  <button ref={pickButton} type="button" className={`rr-pick${emoji ? "" : " secondary"}`} aria-haspopup="dialog" aria-expanded={pickerOpen} onClick={() => setPickerOpen((o) => !o)}>
                    {emoji ? <span className="emoji">{emoji}</span> : <><Icon name="smile-plus" /> {t("rr.pickEmoji")}</>}
                  </button>
                  <select className="rr-role" aria-label={t("rr.role")} value={roleId} onChange={(e) => setRoleId(e.target.value)}>{offered.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                  <label className="check small"><input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> {t("rr.removeOnUnreact")}</label>
                  <SaveButton label={t("rr.addButton")} disabled={!emoji || !roleId || (emoji !== null && taken.has(emojiKey(emoji)))} onSave={add} />
                </div>
                {emoji && taken.has(emojiKey(emoji)) && <p className="muted small">{t("rr.taken")}</p>}
                {pickerOpen && pickButton.current && <EmojiPicker anchor={pickButton.current} onPick={(e) => { setEmoji(e); setPickerOpen(false); }} onClose={() => setPickerOpen(false)} onDismiss={() => setPickerOpen(false)} />}
              </>
            )}
          </fieldset>
          {err && <p className="error">{err}</p>}
          <div className="dialog-actions"><button onClick={onClose}>{t("common.close")}</button></div>
        </div>
      </div>
    </div>
  );
}
