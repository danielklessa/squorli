import { AUDIO_BITRATES, CHANNEL_PERMISSION_GROUPS, Permission, hasPermission, type Channel, type ChannelNotification, type PermissionName, type PermissionOverwrite, type ServerState, type ChannelBlock } from "@squorli/protocol";
import { useEffect, useRef, useState } from "react";
import { ApiError, type ChannelPatch, type ServerApi } from "./api";
import { Avatar } from "./Avatar";
import { blockErrorText } from "./apiErrorText";
import { blockMinutes } from "./voteKick";
import { SHORTCUTS, SLOWMODE_STEPS, baseOf, emptyOverwrite, everyoneDenies, grantableIn, inheritedFrom, overwriteState, permissionsFor, resolveIn, setOverwriteState, slowmodeLabel, withEveryoneDeny, type OverwriteState } from "./channelPerms";
import { askConfirm, showNotice } from "./dialogs";
import { EntityPicker } from "./EntityPicker";
import { entryKey, type PickerEntry } from "./pickerEntries";
import { Icon } from "./Icon";
import { t, tOr } from "./i18n";
import type { MenuAnchor } from "./ContextMenu";
import { TriState } from "./TriState";

/**
 * The channel dialog (docs/features/channel-permissions.md): right-click a channel or category in the sidebar, or the
 * pencil in Verwaltung > Kanäle. One component for both; categories on the left like every categorized modal
 * (apps/web/AGENTS.md). The plain fields save with a button per tab; the permissions tab writes every switch at once (a
 * three-way switch with a collecting save would leave half-saved states, and the effect line must not lie). The object
 * is looked up on every render, never frozen: when it vanishes or the right to manage it goes, the dialog closes.
 */
export type ChannelDialogTarget = { kind: "channel" | "category"; id: string };
type Tab = "general" | "permissions" | "voice" | "blocks" | "text" | "notify";

export function ChannelDialog({ api, server, target, myUserId, onClose }: { api: ServerApi; server: ServerState; target: ChannelDialogTarget; myUserId: string; onClose: () => void }) {
  const channel = target.kind === "channel" ? server.channels.find((c) => c.id === target.id) ?? null : null;
  const category = target.kind === "category" ? server.categories.find((k) => k.id === target.id) ?? null : null;
  const exists = !!channel || !!category;
  const myPerms = server.myChannelPermissions?.[target.id] ?? server.myPermissions;
  const canManage = hasPermission(myPerms, Permission.MANAGE_CHANNELS);
  const [mobileFocus] = useState(() => window.matchMedia("(max-width: 700px), (pointer: coarse)").matches);
  const [tab, setTab] = useState<Tab>("general");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (exists && canManage) return;
    onClose();
    void showNotice({ title: t("chan.goneTitle"), text: t("chan.goneWhileEditing") });
  }, [exists, canManage, onClose]);
  if (!exists || !canManage) return null;
  const name = channel?.name ?? category?.name ?? "";
  const kind = channel?.kind ?? "category";
  const tabs: { id: Tab; icon: string; label: string }[] = [
    { id: "general", icon: kind === "text" ? "hash" : kind === "voice" ? "volume-2" : "folder", label: t("chan.tab.general") },
    { id: "permissions", icon: "shield", label: t("chan.tab.permissions") },
    ...(kind === "voice" ? [{ id: "voice" as const, icon: "audio-lines", label: t("chan.tab.voice") }] : []),
    // Channel blocks (docs/features/channel-blocks.md): whoever may move members here sees and lifts them.
    ...(kind === "voice" && hasPermission(myPerms, Permission.MOVE_MEMBERS) ? [{ id: "blocks" as const, icon: "ban", label: t("chan.tab.blocks") }] : []),
    ...(kind === "text" ? [{ id: "text" as const, icon: "timer", label: t("chan.tab.text") }, { id: "notify" as const, icon: "bell", label: t("chan.tab.notify") }] : []),
  ];
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(explain(e)); } };
  return (
    <div className="modal-backdrop channel-backdrop" onClick={onClose}>
      <div className="modal channel-modal" role="dialog" aria-modal="true" aria-labelledby="channel-dialog-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="channel-dialog-title">{t(channel ? "chan.title.channel" : "chan.title.category", { name })}</h2><span className="spacer" />
          <button className="icon" autoFocus={mobileFocus} onClick={onClose} title={t("common.close")}><Icon name="x" /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav">
            {tabs.map((x) => <button key={x.id} className={tab === x.id ? "active" : ""} aria-current={tab === x.id ? "page" : undefined} onClick={() => { setTab(x.id); setErr(null); }}><Icon name={x.icon} /> <span>{x.label}</span></button>)}
          </nav>
          <div className="settings-body">
            {err && <p className="error">{err}</p>}
            {tab === "general" && (channel ? <GeneralTab api={api} server={server} channel={channel} run={run} onClose={onClose} /> : <CategoryGeneralTab api={api} category={category!} run={run} onClose={onClose} />)}
            {tab === "permissions" && <PermissionsTab api={api} server={server} target={target} kind={kind} myUserId={myUserId} myPerms={myPerms} categoryId={channel?.categoryId ?? null} />}
            {tab === "voice" && channel && <VoiceTab api={api} server={server} channel={channel} run={run} />}
            {tab === "blocks" && channel && <BlocksTab api={api} server={server} channel={channel} />}
            {tab === "text" && channel && <TextTab api={api} channel={channel} run={run} />}
            {tab === "notify" && channel && <NotifyTab api={api} channel={channel} run={run} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The server's error codes as sentences; anything else as it is. */
function explain(e: unknown): string {
  if (e instanceof ApiError && e.code) return tOr(`chan.err.${e.code}`, e.message);
  return e instanceof Error ? e.message : String(e);
}

type RunFn = (fn: () => Promise<unknown>) => Promise<void>;

/** A save button that says what it did; `dirty` = something to save. */
function SaveRow({ dirty, saving, saved, onSave }: { dirty: boolean; saving: boolean; saved: boolean; onSave: () => void }) {
  return (
    <div className="row chan-save">
      <button disabled={!dirty || saving} onClick={onSave}>{t("common.save")}</button>
      <span className="small muted" role="status">{saving ? t("chan.saving") : saved && !dirty ? t("chan.saved") : ""}</span>
    </div>
  );
}

function useSave(run: RunFn, save: () => Promise<unknown>) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const onSave = () => { setSaving(true); setSaved(false); void run(async () => { try { await save(); setSaved(true); } finally { setSaving(false); } }); };
  return { saving, saved, onSave };
}

function GeneralTab({ api, server, channel, run, onClose }: { api: ServerApi; server: ServerState; channel: Channel; run: RunFn; onClose: () => void }) {
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [categoryId, setCategoryId] = useState(channel.categoryId ?? "");
  const patch: ChannelPatch = {
    ...(name.trim() !== channel.name && name.trim() ? { name: name.trim() } : {}),
    ...((topic.trim() || null) !== channel.topic ? { topic: topic.trim() || null } : {}),
    ...((categoryId || null) !== channel.categoryId ? { categoryId: categoryId || null } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  const { saving, saved, onSave } = useSave(run, () => api.updateChannel(channel.id, patch));
  const categories = [...server.categories].sort((a, b) => a.position - b.position);
  return (
    <div className="stack chan-tab">
      <label>{t("chan.name")}<input maxLength={64} value={name} onChange={(e) => setName(e.target.value)} /></label>
      {channel.kind === "text" && <label>{t("chan.topic")}<textarea rows={3} maxLength={256} value={topic} placeholder={t("chan.topicPlaceholder")} onChange={(e) => setTopic(e.target.value)} /><span className="muted small">{t("chan.topicHint")}</span></label>}
      <label>{t("chan.category")}<select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">{t("admin.noCategory")}</option>{categories.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
        <span className="muted small">{t("chan.categoryHint")}</span></label>
      <SaveRow dirty={dirty} saving={saving} saved={saved} onSave={onSave} />
      <div className="chan-danger">
        <h4>{t("chan.dangerZone")}</h4>
        <button className="danger" onClick={() => run(async () => {
          if (await askConfirm({ title: t("admin.deleteChannelTitle", { name: channel.name }), text: channel.kind === "text" ? t("admin.deleteTextChannelText") : t("admin.deleteVoiceChannelText"), confirmLabel: t("common.delete"), danger: true })) { await api.deleteChannel(channel.id); onClose(); }
        })}><Icon name="trash-2" /> {t("chan.delete")}</button>
      </div>
    </div>
  );
}

function CategoryGeneralTab({ api, category, run, onClose }: { api: ServerApi; category: { id: string; name: string }; run: RunFn; onClose: () => void }) {
  const [name, setName] = useState(category.name);
  const dirty = name.trim() !== category.name && !!name.trim();
  const { saving, saved, onSave } = useSave(run, () => api.updateCategory(category.id, { name: name.trim() }));
  return (
    <div className="stack chan-tab">
      <label>{t("chan.name")}<input maxLength={64} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <SaveRow dirty={dirty} saving={saving} saved={saved} onSave={onSave} />
      <div className="chan-danger">
        <h4>{t("chan.dangerZone")}</h4>
        <button className="danger" onClick={() => run(async () => {
          if (await askConfirm({ title: t("admin.deleteCategoryTitle", { name: category.name }), text: t("admin.deleteCategoryText"), confirmLabel: t("common.delete"), danger: true })) { await api.deleteCategory(category.id); onClose(); }
        })}><Icon name="trash-2" /> {t("chan.deleteCategory")}</button>
      </div>
    </div>
  );
}

function VoiceTab({ api, server, channel, run }: { api: ServerApi; server: ServerState; channel: Channel; run: RunFn }) {
  const [d, setD] = useState({ sticky: channel.sticky, stickyPersist: channel.stickyPersist, stickyHideVoice: channel.stickyHideVoice, userLimit: channel.userLimit, audioBitrate: channel.audioBitrate, audioStereo: channel.audioStereo, allowRadio: channel.allowRadio, allowVideo: channel.allowVideo, allowVoteKick: channel.allowVoteKick });
  const patch: ChannelPatch = Object.fromEntries((Object.keys(d) as (keyof typeof d)[]).filter((k) => d[k] !== channel[k]).map((k) => [k, d[k]]));
  const dirty = Object.keys(patch).length > 0;
  const { saving, saved, onSave } = useSave(run, () => api.updateChannel(channel.id, patch));
  const isAfk = server.settings.afkChannelId === channel.id;
  return (
    <div className="stack chan-tab">
      <fieldset className="perm-group">
        <legend>{t("chan.sticky")}</legend>
        <label className="check"><input type="checkbox" checked={d.sticky} disabled={isAfk} onChange={(e) => setD({ ...d, sticky: e.target.checked })} />{t("chan.stickyOn")}</label>
        <p className="muted small">{isAfk ? t("chan.err.afk_channel_sticky") : t("chan.stickyHint")}</p>
        <label className="check"><input type="checkbox" checked={d.stickyPersist} disabled={!d.sticky} onChange={(e) => setD({ ...d, stickyPersist: e.target.checked })} />{t("chan.stickyPersist")}</label>
        <label className="check"><input type="checkbox" checked={d.stickyHideVoice} disabled={!d.sticky} onChange={(e) => setD({ ...d, stickyHideVoice: e.target.checked })} />{t("chan.stickyHideVoice")}</label>
      </fieldset>
      <label>{t("chan.userLimit")}<select value={d.userLimit ?? ""} onChange={(e) => setD({ ...d, userLimit: e.target.value ? Number(e.target.value) : null })}>
        <option value="">{t("chan.userLimitNone")}</option>{[2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 99].map((n) => <option key={n} value={n}>{n}</option>)}
      </select><span className="muted small">{t("chan.userLimitHint")}</span></label>
      <label>{t("admin.audioQuality")}<select value={d.audioBitrate} title={t("admin.bitrateHint")} onChange={(e) => setD({ ...d, audioBitrate: Number(e.target.value) })}>{AUDIO_BITRATES.map((b) => <option key={b} value={b}>{b} kbit/s</option>)}</select><span className="muted small">{t("admin.bitrateHint")}</span></label>
      <label className="check" title={t("admin.stereoHint")}><input type="checkbox" checked={d.audioStereo} onChange={(e) => setD({ ...d, audioStereo: e.target.checked })} />{t("admin.stereo")}</label>
      {server.radioStations !== undefined && <label className="check"><input type="checkbox" checked={d.allowRadio} onChange={(e) => setD({ ...d, allowRadio: e.target.checked })} />{t("chan.allowRadio")}</label>}
      <label className="check"><input type="checkbox" checked={d.allowVideo} onChange={(e) => setD({ ...d, allowVideo: e.target.checked })} />{t("chan.allowVideo")}</label>
      {/* Vote kick (docs/features/votekick.md): the admin's switch, on by default. */}
      <label className="check"><input type="checkbox" checked={d.allowVoteKick} onChange={(e) => setD({ ...d, allowVoteKick: e.target.checked })} />{t("chan.allowVoteKick")}</label>
      <p className="muted small">{t("chan.allowVoteKickHint")}</p>
      <SaveRow dirty={dirty} saving={saving} saved={saved} onSave={onSave} />
    </div>
  );
}

/** The channel's running blocks (a moderator's or a vote kick's), each with a button that lifts it. */
function BlocksTab({ api, server, channel }: { api: ServerApi; server: ServerState; channel: Channel }) {
  const [blocks, setBlocks] = useState<ChannelBlock[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => { api.channelBlocks().then((all) => setBlocks(all.filter((b) => b.channelId === channel.id)), (e: unknown) => { setErr(blockErrorText(e)); setBlocks([]); }); };
  useEffect(load, [api, channel.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const lift = (b: ChannelBlock) => { setErr(null); api.liftChannelBlock(b.channelId, b.userId).then(load, (e: unknown) => { setErr(blockErrorText(e)); load(); }); };
  return (
    <div className="stack chan-tab">
      <h3>{t("chan.blocks")}</h3>
      <p className="muted small">{t("chan.blocksHint")}</p>
      {err && <p className="error small">{err}</p>}
      {blocks === null ? <p className="muted small">{t("chan.loading")}</p> : blocks.length === 0 ? <p className="muted small">{t("chan.blocksNone")}</p> : (
        <ul className="chan-blocks">
          {blocks.map((b) => {
            const member = server.members.find((m) => m.userId === b.userId);
            return (
              <li key={b.userId} className="row">
                <Avatar name={member?.displayName ?? "?"} src={member?.avatarUrl ?? null} />
                <span className="chan-block-who"><strong>{member?.displayName ?? "?"}</strong>
                  <small className="muted">{b.until ? t("members.blockLeft", { minutes: blockMinutes(b.until, Date.now()) }) : t("members.blockForever")}{b.source === "votekick" ? ` · ${t("members.blockVoteKick")}` : b.blockedBy ? ` · ${b.blockedBy}` : ""}</small></span>
                <span className="spacer" />
                <button className="secondary small" onClick={() => lift(b)}><Icon name="lock-open" /> {t("chan.blockLift")}</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TextTab({ api, channel, run }: { api: ServerApi; channel: Channel; run: RunFn }) {
  const [seconds, setSeconds] = useState(channel.slowmodeSeconds);
  const dirty = seconds !== channel.slowmodeSeconds;
  const { saving, saved, onSave } = useSave(run, () => api.updateChannel(channel.id, { slowmodeSeconds: seconds }));
  const units = { s: t("chan.unit.s"), min: t("chan.unit.min"), h: t("chan.unit.h") };
  return (
    <div className="stack chan-tab">
      <label>{t("chan.slowmode")}<select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
        {SLOWMODE_STEPS.map((s) => <option key={s} value={s}>{s === 0 ? t("chan.slowmodeOff") : slowmodeLabel(s, units)}</option>)}
      </select><span className="muted small">{t("chan.slowmodeHint")}</span></label>
      <SaveRow dirty={dirty} saving={saving} saved={saved} onSave={onSave} />
    </div>
  );
}

function NotifyTab({ api, channel, run }: { api: ServerApi; channel: Channel; run: RunFn }) {
  const [value, setValue] = useState<ChannelNotification>(channel.defaultNotify);
  const dirty = value !== channel.defaultNotify;
  const { saving, saved, onSave } = useSave(run, () => api.updateChannel(channel.id, { defaultNotify: value }));
  const options: { v: ChannelNotification; key: "chan.notifyAll" | "chan.notifyMentions" | "chan.notifyNone" }[] = [{ v: "all", key: "chan.notifyAll" }, { v: "mentions", key: "chan.notifyMentions" }, { v: "none", key: "chan.notifyNone" }];
  return (
    <div className="stack chan-tab">
      <p className="muted small">{t("chan.notifyHint")}</p>
      <div className="stack">
        {options.map((o) => <label key={o.v} className="check"><input type="radio" name="chan-notify" checked={value === o.v} onChange={() => setValue(o.v)} />{t(o.key)}</label>)}
      </div>
      <SaveRow dirty={dirty} saving={saving} saved={saved} onSave={onSave} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Permissions: the overwrite editor.

const SIMPLE: Record<"text" | "voice" | "category", PermissionName[]> = {
  text: ["VIEW_CHANNELS", "SEND_MESSAGES", "MANAGE_CHANNELS"],
  voice: ["VIEW_CHANNELS", "CONNECT_VOICE", "MANAGE_CHANNELS"],
  category: ["VIEW_CHANNELS", "SEND_MESSAGES", "CONNECT_VOICE", "MANAGE_CHANNELS"],
};

function PermissionsTab({ api, server, target, kind, myUserId, myPerms, categoryId }: { api: ServerApi; server: ServerState; target: ChannelDialogTarget; kind: "text" | "voice" | "category"; myUserId: string; myPerms: number; categoryId: string | null }) {
  const scope = target.kind === "channel" ? "channels" : "categories";
  const defaultRole = server.roles.find((r) => r.isDefault) ?? null;
  const [list, setList] = useState<PermissionOverwrite[] | null>(null);
  // Entries added but not set yet (allow and deny both 0): shown so one can set them, never sent (the server drops empty ones).
  const [drafts, setDrafts] = useState<PermissionOverwrite[]>([]);
  const [categoryList, setCategoryList] = useState<PermissionOverwrite[]>([]);
  const [selected, setSelected] = useState<string | null>(defaultRole ? `role:${defaultRole.id}` : null);
  // The answer to every switch, next to the switches: "Speichert …" while the request runs, then a check with "Gespeichert"
  // for 1.5 s (a text that stayed would not change on the next save, and the user would see nothing happen; user's report, 23 September 2026).
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const savedTimer = useRef<number | null>(null);
  const showSaved = () => { setStatus("saved"); if (savedTimer.current) window.clearTimeout(savedTimer.current); savedTimer.current = window.setTimeout(() => setStatus("idle"), 1500); };
  useEffect(() => () => { if (savedTimer.current) window.clearTimeout(savedTimer.current); }, []);
  const [err, setErr] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [picker, setPicker] = useState<MenuAnchor | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    void api.getOverwrites(scope, target.id).then((r) => { if (alive) setList(r.overwrites); }).catch((e: unknown) => { if (alive) { setErr(explain(e)); setList([]); } });
    // The category's entries only for the hint what a neutral line inherits; without the right to read them, no hint.
    if (target.kind === "channel" && categoryId) void api.getOverwrites("categories", categoryId).then((r) => { if (alive) setCategoryList(r.overwrites); }).catch(() => {});
    else setCategoryList([]);
    return () => { alive = false; };
  }, [api, scope, target.id, target.kind, categoryId]);

  /** Every change goes to the server at once; the answer is the list as stored. */
  const save = (next: PermissionOverwrite[]) => {
    const isEveryone = (o: PermissionOverwrite) => !!defaultRole && o.targetType === "role" && o.targetId === defaultRole.id;
    // What says something goes to the server; an entry that says nothing yet stays on screen as a draft.
    const toSend = next.filter((o) => !emptyOverwrite(o));
    setDrafts(next.filter((o) => emptyOverwrite(o) && !isEveryone(o)));
    setList(toSend);
    setStatus("saving"); setErr(null);
    const n = ++seq.current;
    void api.setOverwrites(scope, target.id, toSend).then((r) => { if (n === seq.current) { setList(r.overwrites); showSaved(); } })
      .catch((e: unknown) => { if (n === seq.current) { setStatus("error"); setErr(explain(e)); void api.getOverwrites(scope, target.id).then((r) => setList(r.overwrites)).catch(() => {}); } });
  };

  if (!list) return <p className="muted small">{t("chan.loading")}</p>;
  // The default role's line is always there (the shortcuts write to it) and cannot be removed.
  const keyOf = (o: PermissionOverwrite) => `${o.targetType}:${o.targetId}`;
  const stored = [...list, ...drafts.filter((d) => !list.some((o) => keyOf(o) === keyOf(d)))];
  const entries: PermissionOverwrite[] = defaultRole && !stored.some((o) => o.targetType === "role" && o.targetId === defaultRole.id)
    ? [{ targetType: "role", targetId: defaultRole.id, allow: 0, deny: 0 }, ...stored] : stored;
  // Roles in the hierarchy's order as the Roles tab shows it (highest first, the default role last; the user's wish of
  // 6 October 2026, until then the default role stood at the top), then members by name.
  const ordered = [...entries].sort((a, b) => {
    if (a.targetType !== b.targetType) return a.targetType === "role" ? -1 : 1;
    if (a.targetType === "role") return positionOf(b) - positionOf(a) || labelOf(a).localeCompare(labelOf(b));
    return labelOf(a).localeCompare(labelOf(b));
  });
  function positionOf(o: PermissionOverwrite): number {
    return server.roles.find((r) => r.id === o.targetId)?.position ?? -1;
  }
  function labelOf(o: PermissionOverwrite): string {
    return o.targetType === "role" ? server.roles.find((r) => r.id === o.targetId)?.name ?? "?" : server.members.find((m) => m.userId === o.targetId)?.displayName ?? "?";
  }
  const current = ordered.find((o) => `${o.targetType}:${o.targetId}` === selected) ?? ordered[0] ?? null;
  const groups = permissionsFor(kind, CHANNEL_PERMISSION_GROUPS);
  const update = (o: PermissionOverwrite, perm: number, state: OverwriteState) => save(entries.map((x) => (x === o ? setOverwriteState(x, perm, state) : x)));
  const remove = (o: PermissionOverwrite) => {
    if (emptyOverwrite(o)) setDrafts(drafts.filter((d) => keyOf(d) !== keyOf(o))); else save(entries.filter((x) => x !== o));
    if (current === o) setSelected(defaultRole ? `role:${defaultRole.id}` : null);
  };
  /** A new entry starts as a draft (nothing set); the first switch on it sends it. */
  const add = (e: PickerEntry) => {
    const key = entryKey(e);
    if (!entries.some((o) => keyOf(o) === key)) setDrafts([...drafts, { targetType: e.kind === "role" ? "role" : "member", targetId: e.kind === "role" ? e.role.id : e.member.userId, allow: 0, deny: 0 }]);
    setSelected(key);
  };
  // The subject a line stands for, for the effect line: a role (with the default role), or the member with all their roles.
  const subjectOf = (o: PermissionOverwrite) => o.targetType === "role"
    ? { userId: "", isOwner: false, base: baseOf([o.targetId], server.roles), roleIds: [o.targetId, ...(defaultRole ? [defaultRole.id] : [])] }
    : (() => { const m = server.members.find((x) => x.userId === o.targetId); return { userId: o.targetId, isOwner: m?.isOwner ?? false, base: baseOf(m?.roleIds ?? [], server.roles), roleIds: [...(m?.roleIds ?? []), ...(defaultRole ? [defaultRole.id] : [])] }; })();
  const effective = current ? resolveIn(subjectOf(current), defaultRole?.id ?? null, target.kind === "channel" ? categoryList : [], target.kind === "channel" ? entries : []) : 0;
  const effectiveCategoryOnly = current && target.kind === "category" ? resolveIn(subjectOf(current), defaultRole?.id ?? null, entries, []) : effective;
  const listed = groups.flatMap((g) => g.permissions);
  const effectiveNames = listed.filter((n) => hasPermission(target.kind === "category" ? effectiveCategoryOnly : effective, Permission[n]));
  const hasDeny = !!current && listed.some((n) => overwriteState(current, Permission[n]) === "deny");
  const showAdvanced = advanced || hasDeny;
  const categoryName = target.kind === "channel" && categoryId ? server.categories.find((k) => k.id === categoryId)?.name ?? null : null;
  const isEveryone = (o: PermissionOverwrite) => !!defaultRole && o.targetType === "role" && o.targetId === defaultRole.id;
  const privateOn = !!defaultRole && everyoneDenies(entries, defaultRole.id, SHORTCUTS.private);
  const readOnlyOn = !!defaultRole && everyoneDenies(entries, defaultRole.id, SHORTCUTS.readOnly);

  return (
    <div className="chan-perms">
      <div className="chan-perm-list">
        {defaultRole && (
          <div className="stack chan-shortcuts">
            <label className="check" title={t("chan.privateHint", { role: defaultRole.name })}><input type="checkbox" checked={privateOn} disabled={!grantableIn(myPerms, SHORTCUTS.private)} onChange={(e) => save(withEveryoneDeny(entries, defaultRole.id, SHORTCUTS.private, e.target.checked, myUserId))} /><Icon name="lock" /> {t(target.kind === "channel" ? "chan.private" : "chan.privateCategory")}</label>
            {kind === "text" && <label className="check" title={t("chan.readOnlyHint", { role: defaultRole.name })}><input type="checkbox" checked={readOnlyOn} disabled={!grantableIn(myPerms, SHORTCUTS.readOnly)} onChange={(e) => save(withEveryoneDeny(entries, defaultRole.id, SHORTCUTS.readOnly, e.target.checked))} /><Icon name="megaphone" /> {t("chan.readOnly")}</label>}
          </div>
        )}
        <h4>{t("chan.entries")}</h4>
        <ul className="overwrite-list">
          {ordered.map((o) => {
            const key = `${o.targetType}:${o.targetId}`;
            const role = o.targetType === "role" ? server.roles.find((r) => r.id === o.targetId) : undefined;
            const member = o.targetType === "member" ? server.members.find((m) => m.userId === o.targetId) : undefined;
            return (
              <li key={key} className={`overwrite-row${current === o ? " active" : ""}`}>
                <button className="overwrite-pick" aria-pressed={current === o} onClick={() => setSelected(key)}>
                  {role ? <span className="role-dot" style={role.color ? { background: role.color } : undefined} /> : <Avatar name={member?.displayName ?? "?"} src={member?.avatarUrl} size="small" />}
                  <span className="entity-name">{labelOf(o)}</span>
                  <span className="muted small">{isEveryone(o) ? t("chan.everyone") : o.targetType === "role" ? t("chan.role") : t("chan.member")}</span>
                </button>
                {isEveryone(o) ? <span className="role-fixed" title={t("chan.everyoneFixed")}><Icon name="lock" /></span>
                  : <button className="icon" title={t("chan.removeEntry")} aria-label={`${labelOf(o)}: ${t("chan.removeEntry")}`} onClick={() => remove(o)}><Icon name="x" /></button>}
              </li>
            );
          })}
        </ul>
        <button className="secondary" onClick={(e) => setPicker({ trigger: e.currentTarget, x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom })}><Icon name="plus" /> {t("chan.addEntry")}</button>
        {picker && <EntityPicker anchor={picker} roles={server.roles} members={server.members} exclude={new Set(entries.map((o) => `${o.targetType}:${o.targetId}`))} onPick={add} onClose={() => setPicker(null)} />}
        {err && <p className="error small">{err}</p>}
      </div>
      {current && (
        <div className="chan-perm-edit">
          <header className="row">
            <strong>{labelOf(current)}</strong>
            <span className="spacer" />
            <span className={`small chan-status is-${status}`} role="status" aria-live="polite">
              {status === "saving" ? t("chan.saving") : status === "saved" ? <><Icon name="check" /> {t("chan.saved")}</> : status === "error" ? <><Icon name="x" /> {t("chan.saveFailed")}</> : ""}
            </span>
            <div className="seg" role="group" aria-label={t("chan.view")}>
              <button className={!showAdvanced ? "active" : ""} aria-pressed={!showAdvanced} disabled={hasDeny} onClick={() => setAdvanced(false)}>{t("chan.simple")}</button>
              <button className={showAdvanced ? "active" : ""} aria-pressed={showAdvanced} onClick={() => setAdvanced(true)}>{t("chan.advanced")}</button>
            </div>
          </header>
          {hasDeny && !advanced && <p className="muted small">{t("chan.advancedForced")}</p>}
          <p className="muted small">
            {target.kind === "channel" ? (categoryName ? t("chan.inheritsFrom", { name: categoryName }) : t("chan.inheritsServer")) : t("chan.categoryInherits")}
            {target.kind === "channel" && categoryName && entries.some((o) => !emptyOverwrite(o)) && (
              <> <button className="link" onClick={() => void askConfirm({ title: t("chan.syncCategoryTitle"), text: t("chan.syncCategoryText"), confirmLabel: t("chan.syncCategory") }).then((ok) => { if (ok) save([]); })}>{t("chan.syncCategory")}</button></>
            )}
          </p>
          {!showAdvanced ? (
            <div className="stack">
              {SIMPLE[kind].map((n) => {
                const perm = Permission[n];
                const on = overwriteState(current, perm) === "allow";
                const ok = grantableIn(myPerms, perm);
                return <label key={n} className="check" title={ok ? undefined : t("chan.notGrantable")}><input type="checkbox" checked={on} disabled={!ok} onChange={(e) => update(current, perm, e.target.checked ? "allow" : "neutral")} />{tOr(`chanPerm.${n}`, n)}</label>;
              })}
              <p className="muted small">{t("chan.simpleHint")}</p>
            </div>
          ) : groups.map((g) => (
            <fieldset key={g.id} className="perm-group">
              <legend>{tOr(`chanPermGroup.${g.id}`, g.id)}</legend>
              {g.permissions.map((n) => {
                const perm = Permission[n];
                const state = overwriteState(current, perm);
                const ok = grantableIn(myPerms, perm);
                const inh = state === "neutral" ? inheritedFrom(current, perm, target.kind === "channel" ? categoryList : [], subjectOf(current).base) : null;
                const overridden = target.kind === "channel" && state !== "neutral";
                return (
                  <div key={n} className={`perm-row${overridden ? " overridden" : ""}`} title={ok ? undefined : t("chan.notGrantable")}>
                    <span className="perm-label">{tOr(`chanPerm.${n}`, n)}{overridden && <span className="sr-only"> ({t("chan.overridden")})</span>}</span>
                    <span className="perm-inherited muted small">{inh ? t(inh.state === "allow" ? "chan.inheritedAllow" : "chan.inheritedDeny", { source: t(inh.source === "category" ? "chan.sourceCategory" : "chan.sourceServer") }) : ""}</span>
                    <TriState name={`ow-${current.targetType}-${current.targetId}-${n}`} label={tOr(`chanPerm.${n}`, n)} value={state} disabled={!ok} inherited={inh?.state ?? null} onChange={(v) => update(current, perm, v)} />
                  </div>
                );
              })}
            </fieldset>
          ))}
          <p className="perm-effective small">{effectiveNames.length ? t("chan.effective", { name: labelOf(current), list: effectiveNames.map((n) => tOr(`chanPerm.${n}`, n)).join(", ") }) : t("chan.effectiveNone", { name: labelOf(current) })}</p>
        </div>
      )}
    </div>
  );
}

/** Kept exported for the sidebar's lock: the same reading of "private" as the dialog's switch. */
export const isPrivateList = (list: PermissionOverwrite[], defaultRoleId: string | null) => !!defaultRoleId && everyoneDenies(list, defaultRoleId, SHORTCUTS.private);
