import type { ReactionRoleOverviewEntry, ServerState } from "@squorli/protocol";
import { useCallback, useEffect, useState } from "react";
import type { ServerApi } from "./api";
import { reactionRuleErrorText } from "./apiErrorText";
import { askConfirm } from "./dialogs";
import { Icon } from "./Icon";
import { fmtDateTime, t } from "./i18n";

type RunFn = (fn: () => Promise<unknown>) => Promise<void>;

/**
 * Verwaltung > Reaktionsrollen (docs/features/reactions.md): every rule "emoji gives role" of the channels the user sees,
 * grouped by channel, with the message's first words, its author and when the rule was made, and a delete button. New rules
 * are made on the message itself (the shield in its toolbar); this is the place to find them again.
 */
export function ReactionRolesTab({ api, server, run }: { api: ServerApi; server: ServerState; run: RunFn }) {
  const [rules, setRules] = useState<ReactionRoleOverviewEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api.reactionRoleOverview().then((r) => { setRules(r.rules); setErr(null); }, (e) => setErr(reactionRuleErrorText(e))), [api]);
  useEffect(() => { void load(); }, [load]);
  const roleOf = (id: string) => server.roles.find((r) => r.id === id);
  const nameOf = (id: string) => server.members.find((m) => m.userId === id)?.displayName ?? t("chat.formerMember");
  const byChannel = new Map<string, ReactionRoleOverviewEntry[]>();
  for (const r of rules ?? []) (byChannel.get(r.channelName) ?? byChannel.set(r.channelName, []).get(r.channelName)!).push(r);

  return (
    <div className="stack">
      <h3>{t("admin.tab.reactionRoles")}</h3>
      <p className="muted small">{t("admin.rr.intro")}</p>
      {err && <p className="error">{err}</p>}
      {rules === null ? <p className="muted">{t("common.loading")}</p> : rules.length === 0 ? <p className="muted">{t("admin.rr.none")}</p> : (
        [...byChannel].map(([channelName, list]) => (
          <section key={channelName} className="stack rr-channel">
            <h4><Icon name="hash" /> {channelName}</h4>
            <ul className="rr-list">
              {list.map((r) => {
                const role = roleOf(r.roleId);
                return (
                  <li key={r.id} className="rr-row rr-overview">
                    <span className="emoji rr-emoji">{r.emoji}</span>
                    <span className="rr-arrow"><Icon name="arrow-right" /></span>
                    <span className="rr-rolename" style={role?.color ? { color: role.color } : undefined}>{role?.name ?? t("chat.formerRole")}</span>
                    {r.removeOnUnreact && <span className="badge small">{t("rr.removeOnUnreact.short")}</span>}
                    <q className="muted small rr-excerpt">{r.excerpt || t("admin.rr.noText")}</q>
                    <span className="muted small">{t("admin.rr.by", { name: nameOf(r.authorId) })} · {fmtDateTime(r.createdAt)}</span>
                    <button className="icon" title={t("common.delete")} onClick={() => {
                      void askConfirm({ title: t("admin.rr.deleteTitle"), text: t("admin.rr.deleteText", { emoji: r.emoji, role: role?.name ?? "?" }), confirmLabel: t("common.delete"), danger: true })
                        .then((ok) => { if (ok) return run(() => api.deleteReactionRule(r.id).then(load)); });
                    }}><Icon name="trash-2" /></button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
