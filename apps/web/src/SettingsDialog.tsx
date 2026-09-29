import { Avatar } from "./Avatar";
import { AvatarEditor } from "./AvatarEditor";
import type { CropRect } from "./avatarCrop";
import { AvatarImageError, loadAvatarSource, renderAvatar, type AvatarImage } from "./avatarImage";
import type { DeviceInfo, DirectoryAccount, Me, SessionInfo } from "@squorli/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerApi } from "./api";
import { BLUR_OPTIONS } from "./CameraPicker";
import { askConfirm } from "./dialogs";
import { Icon } from "./Icon";
import { LicensesTab } from "./LicensesTab";
import { NotificationSettings } from "./NotificationSettings";
import { GamesTab } from "./GamesTab";
import { HotkeysTab } from "./HotkeysTab";
import type { HotkeyAction, HotkeyStatus } from "./platform";
import { checkHotkey, hotkeyFromKey, keyName, type HotkeyCheck } from "./platform/hotkeys";
import { useKeyboardLayout } from "./keyboardLayout";
import type { GameDetection } from "./gameDetection";
import { LOCALES, fmtDateTime, localePreference, t, type LocalePreference } from "./i18n";
import { activity } from "./activity";
import { platform, type WindowAppearance } from "./platform";
import { DOWNLOAD_URL, describeUpdate, useUpdateState } from "./appUpdates";
import { idleDetectionSupported, idleDetectionWanted, setIdleDetection } from "./idleDetection";
import { boostLimits } from "./voice/micBoost";
import { saveVoiceSettings, type VoiceSettings } from "./voice/settings";
import { VOICE_CUES, type SoundCue, type SoundSettings } from "./voice/sounds";
import { useVoiceSettings } from "./voice/useVoiceSettings";
import { VoiceClient, type VoiceState } from "./voice/voiceClient";
import { LocalAccountSettings } from "./AccountForms";
import { DevicesTab } from "./DevicesTab";
import { safeHref } from "./safeHref";

export type SettingsTab = "profile" | "view" | "voice" | "camera" | "sounds" | "hotkeys" | "games" | "blocked" | "sessions" | "account" | "app" | "licenses";
const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "profile", label: t("settings.tab.profile"), icon: "user" },
  { id: "view", label: t("settings.tab.view"), icon: "languages" },
  { id: "voice", label: t("settings.tab.voice"), icon: "mic" },
  { id: "camera", label: t("settings.tab.camera"), icon: "video" },
  { id: "sounds", label: t("settings.tab.sounds"), icon: "bell" },
  { id: "hotkeys", label: t("settings.tab.hotkeys"), icon: "keyboard" },
  { id: "games", label: t("settings.tab.games"), icon: "gamepad-2" },
  { id: "blocked", label: t("settings.tab.blocked"), icon: "ban" },
  { id: "sessions", label: t("settings.tab.sessions"), icon: "monitor-smartphone" },
  { id: "account", label: t("settings.tab.account"), icon: "key-round" },
  { id: "app", label: t("settings.tab.app"), icon: "download" },
  { id: "licenses", label: t("settings.tab.licenses"), icon: "scale" },
];
/** Categories whose content follows the directory account (everything except the device selection, sessions and the account itself). */
const SYNCED: readonly SettingsTab[] = ["view", "voice", "camera", "sounds"];

/** Label per cue, in the order they are offered in the settings. */
const SOUND_LABELS: Record<SoundCue, string> = {
  selfJoin: t("settings.soundSelfJoin"),
  selfLeave: t("settings.soundSelfLeave"),
  peerJoin: t("settings.soundPeerJoin"),
  peerLeave: t("settings.soundPeerLeave"),
  message: t("settings.soundMessage"),
};

const fmt = fmtDateTime;

/**
 * All user and profile settings in one categorized modal (categories on the left), opened by the gear next to your name:
 * profile (display name on this server; with a directory account also the global name), view (language, speaker view),
 * voice and audio (microphone with its test, speaking, output devices), camera, sounds, sessions (devices signed in on this server, M6c), account (handle, key, link to
 * the directory's account page, sign out, discard identity) and licenses (our own and the third-party notices, LicensesTab.tsx). With a directory account everything except the device selection
 * is stored there (store.ts pushes every change); sessions and the name on this server belong to the server shown.
 */
export function SettingsDialog({ api, me, publicKey, displayName, avatarUrl, directoryUrl, directoryAccount, serverDomain, clientVersion, syncError, sealed, client, voice, initialTab, games, blocked, hotkeyStatus, onSaveServerName, onSaveGlobalName, onSetAvatar, onSetLocale, localePending, onCapturingKey, onClose, onLogout, accountDevices, serverAccount, onDirectorySignIn }: {
  /** The server on screen and who you are there; null = none is shown (client without a home server): the dialog then has
   *  no profile and no sessions, which belong to a server, and the account page names the directory account and `publicKey`. */
  api: ServerApi | null; me: Me | null; publicKey: string | null;
  /** Your name as the server shows it right now (member list); the preview falls back to it. */
  displayName: string;
  avatarUrl: string | null;
  directoryUrl: string | null; directoryAccount: DirectoryAccount | null | undefined; serverDomain: string | null;
  /** Version of the server that serves this client (from its /api/health), shown with the licenses. */
  clientVersion: string | null;
  /** Last failure while saving the settings in the account; null = none. */
  syncError: string | null;
  /** The account keeps the settings as a blob only this user's key opens (store `settingsSealed`). */
  sealed: boolean;
  client: VoiceClient; voice: VoiceState; initialTab?: SettingsTab;
  /** Game detection of the desktop app; null = not available here, and the category is not shown. */
  games: GameDetection | null;
  /** Blocked people (docs/features/reports.md, stage 3): the list of the identity used on the server shown, where it is kept, and lifting a block. */
  blocked: { list: { publicKey: string; name: string }[]; inAccount: boolean; onUnblock: (publicKey: string) => void };
  /** What the desktop app's shell made of the global shortcuts (App.tsx); null until it answered, or in a browser (the category is not shown there). */
  hotkeyStatus: HotkeyStatus | null;
  onSaveServerName: (displayName: string | null) => Promise<void>;
  onSaveGlobalName: (displayName: string | null) => Promise<void>;
  /** Upload (null = remove) the avatar of the directory account, already cropped and encoded; null = no account or a directory without avatars. */
  onSetAvatar: ((image: AvatarImage | null) => Promise<void>) | null;
  onSetLocale: (pref: LocalePreference) => Promise<void>;
  /** The chosen language waits for the end of the voice connection (store.ts `reloadForLocale`). */
  localePending: boolean;
  /** While the push-to-talk key is being captured the dock's push-to-talk listener has to stay quiet. */
  onCapturingKey: (capturing: boolean) => void;
  /** Signing out takes the keys off this installation (store.ts `logout`); the caller asks first where that loses the account. */
  onClose: () => void; onLogout: () => void;
  /**
   * The devices of the account in use (docs/features/devices.md; DevicesTab.tsx): the directory account's, or the server
   * account's of the server shown. null = neither the directory nor the server knows devices: the server's sessions then,
   * as before.
   */
  accountDevices: { scope: "directory" | "local"; account: string; canRevoke: boolean; hasPassword: boolean; load: () => Promise<DeviceInfo[]>; revoke: (target: string, password: string, code?: string) => Promise<DeviceInfo[]> } | null;
  /** The server shown signs in with a server account (`~name`): its password and its deletion (docs/features/local-accounts.md); null = none. */
  /** Desktop app with server accounts only: sign in with a directory account too (the servers stay); null = not offered. */
  onDirectorySignIn: (() => void) | null;
  serverAccount: { serverName: string; onChangePassword: (oldPassword: string, newPassword: string) => Promise<void>; onDelete: (password: string) => Promise<void> } | null;
}) {
  const settings = useVoiceSettings();
  const [mobileFocus] = useState(() => window.matchMedia("(max-width: 700px), (pointer: coarse)").matches);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onServer = !!api && !!me;
  // "App" (version, updates) exists in the desktop app only; profile and sessions belong to a server.
  // The devices of a directory account belong to no server: the category shows without one too.
  const tabs = TABS.filter((entry) => (entry.id !== "app" || platform.app !== null) && (entry.id !== "games" || games !== null) && (entry.id !== "hotkeys" || platform.hotkeys !== null) && (onServer || (entry.id !== "profile" && (entry.id !== "sessions" || accountDevices !== null))));
  const appUpdate = useUpdateState();
  const keyLayout = useKeyboardLayout();
  const [tab, setTab] = useState<SettingsTab>(() => { const wanted = initialTab ?? "profile"; return tabs.some((entry) => entry.id === wanted) ? wanted : "view"; });
  const [name, setName] = useState(me?.displayName ?? "");
  const handle = me?.handle ?? directoryAccount?.handle ?? null;
  /** A server account on the server shown (`~name`, docs/features/local-accounts.md): its password and deletion live here. */
  const localHandle = me && !me.handle ? me.localHandle : null;
  const shownHandle = handle ? `@${handle}` : localHandle ? `~${localHandle}` : null;
  // Desktop app: window background (mica/acrylic + opacity); null in the browser and where the system offers no material.
  const windowLook = platform.window.appearance;
  const [look, setLook] = useState<WindowAppearance | null>(() => windowLook?.state().appearance ?? null);
  const [lookRestart, setLookRestart] = useState(() => windowLook?.state().needsRestart ?? false);
  const trayPref = platform.window.tray;
  const [closeToTray, setCloseToTray] = useState(() => trayPref?.closeToTray() ?? false);
  const autostartPref = platform.window.autostart;
  const [autostart, setAutostart] = useState(() => autostartPref?.enabled() ?? false);
  const [autostartBackground, setAutostartBackground] = useState(() => autostartPref?.background?.get() ?? true);
  const changeLook = (next: WindowAppearance) => { setLook(next); void windowLook?.set(next).then((s) => { setLook(s.appearance); setLookRestart(s.needsRestart); }); };
  const [globalName, setGlobalName] = useState(directoryAccount?.displayName ?? "");
  // The global name arrives with the signed account status, possibly after the dialog opened: follow it until the user edits the field
  // (an empty field saved over a name that had not arrived yet would delete it).
  const globalTouched = useRef(false);
  useEffect(() => { if (!globalTouched.current) setGlobalName(directoryAccount?.displayName ?? ""); }, [directoryAccount?.displayName]);
  // With a directory account: the local name is the per-server entry in the directory, empty = the global name.
  const withDirectory = !!directoryAccount && !!serverDomain;
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** AFK detection across the whole system (Idle Detection API): per browser, because the permission is the browser's. */
  const [idleDetect, setIdleDetect] = useState(() => idleDetectionSupported() && idleDetectionWanted());
  const [idleDenied, setIdleDenied] = useState(false);
  const [devices, setDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }>({ inputs: [], outputs: [], cameras: [] });
  const [capturingKey, setCapturingKey] = useState(false);
  /** Einstellungen > Tastenkürzel: the global shortcut being captured, and why the last captured key was not taken. */
  const [capturingHotkey, setCapturingHotkey] = useState<HotkeyAction | null>(null);
  const [refusedHotkey, setRefusedHotkey] = useState<{ action: HotkeyAction; check: Exclude<HotkeyCheck, "ok"> } | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const dirHost = directoryUrl ? new URL(directoryUrl).host : null;
  const joined = voice.status !== "disconnected";
  const inAccount = !!directoryUrl && !!directoryAccount;

  const update = (patch: Partial<VoiceSettings>) => saveVoiceSettings({ ...settingsRef.current, ...patch });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !capturingKey && !capturingHotkey) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, capturingKey, capturingHotkey]);

  useEffect(() => {
    let alive = true;
    const load = () => VoiceClient.listDevices().then((d) => { if (alive) setDevices(d); }).catch(() => {});
    void load();
    navigator.mediaDevices?.addEventListener("devicechange", load);
    return () => { alive = false; navigator.mediaDevices?.removeEventListener("devicechange", load); };
  }, [joined]);

  useEffect(() => {
    onCapturingKey(capturingKey);
    if (!capturingKey) return;
    const handler = (e: KeyboardEvent) => { e.preventDefault(); update({ pttKey: e.code }); setCapturingKey(false); };
    window.addEventListener("keydown", handler, { once: true });
    return () => { window.removeEventListener("keydown", handler); onCapturingKey(false); };
  }, [capturingKey]);

  // Capturing a global shortcut (docs/features/hotkeys.md): the shell lets its shortcuts go meanwhile (a registered one never
  // reaches the window) and watches no key; the dock's push-to-talk listener stays quiet like for the push-to-talk key. A
  // modifier alone waits for the key, Escape cancels; a key that fails the rules is refused with a note, the old one stays.
  useEffect(() => {
    if (!capturingHotkey) return;
    const action = capturingHotkey;
    onCapturingKey(true);
    platform.hotkeys?.suspend(true);
    const handler = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === "Escape") { setCapturingHotkey(null); return; }
      const binding = hotkeyFromKey(e, platform.os === "windows");
      if (!binding) return;
      const check = checkHotkey(binding);
      if (check === "ok") { setRefusedHotkey(null); update({ hotkeys: { ...settingsRef.current.hotkeys, [action]: binding } }); }
      else setRefusedHotkey({ action, check });
      setCapturingHotkey(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => { window.removeEventListener("keydown", handler, true); onCapturingKey(false); platform.hotkeys?.suspend(false); };
  }, [capturingHotkey]);

  // The microphone test ends with its tab and with the dialog; so does a capture of a global shortcut.
  useEffect(() => { if (tab !== "voice") void client.stopMicTest(); }, [tab, client]);
  useEffect(() => { if (tab !== "hotkeys") { setCapturingHotkey(null); setRefusedHotkey(null); } }, [tab]);
  useEffect(() => () => { void client.stopMicTest(); }, [client]);
  async function toggleMicTest() {
    setTestBusy(true);
    try {
      if (voice.micTest) await client.stopMicTest(); else await client.startMicTest(settingsRef.current);
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setTestBusy(false); }
  }

  const loadSessions = useCallback(async () => {
    if (!api) return;
    try { setSessions(await api.getSessions()); setErr(null); } catch (e) { setErr(String(e)); }
  }, [api]);
  useEffect(() => { if (tab === "sessions" && !accountDevices) void loadSessions(); }, [tab, loadSessions, accountDevices]);
  useEffect(() => { setErr(null); setSaved(false); }, [tab]);

  async function saveNames() {
    const local = name.trim() || null;
    const global = globalName.trim() || null;
    setBusy(true); setSaved(false);
    try {
      // The global name first: the name on this server is stored only as a deviation from it.
      if (withDirectory && global !== (directoryAccount?.displayName ?? null)) await onSaveGlobalName(global);
      await onSaveServerName(local);
      setErr(null); setSaved(true);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const avatarInput = useRef<HTMLInputElement>(null);
  const [avatarNote, setAvatarNote] = useState<string | null>(null);
  // The chosen image, decoded, while the crop editor is open; closed when replaced, cancelled, saved or the dialog goes.
  const [avatarSource, setAvatarSource] = useState<ImageBitmap | null>(null);
  useEffect(() => { if (avatarSource) return () => avatarSource.close(); }, [avatarSource]);
  async function pickAvatar(file: Blob) {
    setAvatarNote(null);
    try { setAvatarSource(await loadAvatarSource(file)); setErr(null); }
    catch { setErr(t("profile.avatarUnreadable")); }
  }
  async function applyAvatar(crop: CropRect) {
    if (!onSetAvatar || !avatarSource) return;
    setBusy(true); setAvatarNote(t("profile.avatarUploading"));
    try { await onSetAvatar(await renderAvatar(avatarSource, crop)); setAvatarSource(null); setErr(null); setAvatarNote(t("profile.avatarSaved")); }
    catch (e) { setAvatarNote(null); setErr(e instanceof AvatarImageError ? t("dir.avatar_too_large") : e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function removeAvatar() {
    if (!onSetAvatar) return;
    setBusy(true); setAvatarNote(null);
    try { await onSetAvatar(null); setErr(null); setAvatarNote(t("profile.avatarRemoved")); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function changeLocale(pref: LocalePreference) {
    setBusy(true);
    try { await onSetLocale(pref); } finally { setBusy(false); }
  }
  async function revoke(s: SessionInfo) {
    const ok = await askConfirm({ title: t("profile.revokeDeviceTitle"), text: t("profile.revokeDeviceText", { label: s.label ?? t("profile.thisDevice"), date: fmt(s.createdAt) }), confirmLabel: t("profile.signOut"), danger: true });
    if (!ok) return;
    setBusy(true);
    try { await api?.revokeSession(s.id); await loadSessions(); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }
  async function revokeOthers() {
    const ok = await askConfirm({ title: t("profile.revokeOthersTitle"), text: t("profile.revokeOthersText"), confirmLabel: t("profile.signOutAll"), danger: true });
    if (!ok) return;
    setBusy(true);
    try { await api?.revokeOtherSessions(); await loadSessions(); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  const others = sessions?.filter((s) => !s.current).length ?? 0;
  const levelPct = Math.min(100, Math.round(voice.level * 400));
  const thresholdPct = Math.min(100, Math.round(settings.vadThreshold * 400));
  const shownName = name.trim() || (withDirectory ? globalName.trim() : "") || displayName;

  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={onClose}>
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="settings-title">{t("settings.title")}</h2>
          <span className="spacer" />
          <button className="icon" title={t("common.close")} autoFocus={mobileFocus} onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav">
            {tabs.map((t) => <button key={t.id} className={tab === t.id ? "active" : ""} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}><Icon name={t.icon} /> <span>{t.label}</span></button>)}
          </nav>
          <div className="settings-body stack">
            {err && <p className="error">{err}</p>}

            {tab === "profile" && onServer && (
              <>
                <div className="profile-preview"><Avatar name={shownName || "?"} src={avatarUrl} size="large" /><div><strong>{shownName}</strong>{shownHandle && <div className="muted small">{shownHandle}</div>}</div></div>
                {onSetAvatar && (
                  <>
                    <h3>{t("profile.avatar")}</h3>
                    {/* The chosen image opens the crop editor; the value is cleared so the same file can be chosen again. */}
                    <input ref={avatarInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const file = e.target.files?.[0] ?? null; e.target.value = ""; if (file) void pickAvatar(file); }} />
                    {avatarSource
                      ? <AvatarEditor source={avatarSource} busy={busy} onApply={(crop) => void applyAvatar(crop)} onCancel={() => { setAvatarSource(null); setAvatarNote(null); }} />
                      : (
                        <div className="row">
                          <button className="secondary" disabled={busy} onClick={() => avatarInput.current?.click()}><Icon name="image" /> {t("profile.avatarChoose")}</button>
                          {avatarUrl && <button className="danger" disabled={busy} onClick={() => void removeAvatar()}>{t("profile.avatarRemove")}</button>}
                        </div>
                      )}
                    {avatarNote && <span className="muted small" role="status">{avatarNote}</span>}
                    <span className="muted small">{t("profile.avatarHint", { host: dirHost ?? "" })}</span>
                  </>
                )}
                <h3>{t("profile.nameHere")}</h3>
                <input value={name} maxLength={32} autoFocus={!mobileFocus} onChange={(e) => { setName(e.target.value); setSaved(false); }} onKeyDown={(e) => { if (e.key === "Enter") void saveNames(); }} />
                <span className="muted small">{withDirectory ? t("profile.nameHereHintDir") : t("profile.nameHereHint")}</span>
                {withDirectory && (
                  <>
                    <h3>{t("profile.nameGlobal")}</h3>
                    <input value={globalName} maxLength={32} onChange={(e) => { globalTouched.current = true; setGlobalName(e.target.value); setSaved(false); }} onKeyDown={(e) => { if (e.key === "Enter") void saveNames(); }} />
                    <span className="muted small">{t("profile.nameGlobalHint", { host: dirHost ?? "", handle: directoryAccount?.handle ?? "" })}</span>
                  </>
                )}
                <div className="row"><button disabled={busy} onClick={() => void saveNames()}>{t("common.save")}</button>{saved && <span className="muted small" role="status">{t("settings.saved")}</span>}</div>
              </>
            )}

            {tab === "view" && (
              <>
                <h3>{t("common.language")}</h3>
                <select value={localePreference()} disabled={busy} onChange={(e) => void changeLocale(e.target.value as LocalePreference)}>
                  <option value="auto">{t("lang.auto")}</option>
                  {LOCALES.map((l) => <option key={l} value={l}>{t(`lang.${l}`)}</option>)}
                </select>
                <span className="muted small">{t("profile.languageHint")}</span>
                {localePending && <p className="warn-box small" role="status">{t("profile.languagePending")}</p>}
                {windowLook && look && (
                  <>
                    <h3>{t("settings.window")}</h3>
                    <label className="stack">{t("settings.windowMaterial")}
                      <select value={look.material} onChange={(e) => changeLook({ ...look, material: e.target.value as WindowAppearance["material"] })}>
                        <option value="none">{t("settings.windowMaterial.none")}</option>
                        {windowLook.materials.map((m) => <option key={m} value={m}>{t(`settings.windowMaterial.${m}`)}</option>)}
                      </select>
                    </label>
                    <label className="stack">{t("settings.windowOpacity", { n: Math.round(look.opacity * 100) })}
                      <input type="range" min={40} max={100} step={5} value={Math.round(look.opacity * 100)} disabled={look.material === "none"} onChange={(e) => changeLook({ ...look, opacity: Number(e.target.value) / 100 })} />
                    </label>
                    <span className="muted small">{t("settings.windowHint")}</span>
                    {lookRestart && <div className="row"><span className="warn-box small">{t("settings.windowRestart")}</span><button className="secondary small" onClick={() => windowLook.restart()}>{t("settings.windowRestartNow")}</button></div>}
                  </>
                )}
                {trayPref && (
                  <>
                    <h3>{t("settings.tray")}</h3>
                    <label className="check"><input type="checkbox" checked={closeToTray} onChange={(e) => { const on = e.target.checked; setCloseToTray(on); void trayPref.setCloseToTray(on).then(setCloseToTray); }} /> {t("settings.closeToTray")}</label>
                    <span className="muted small">{t("settings.closeToTrayHint")}</span>
                  </>
                )}
                {autostartPref && (
                  <>
                    <h3>{t("settings.autostartHead")}</h3>
                    <label className="check"><input type="checkbox" checked={autostart} onChange={(e) => { const on = e.target.checked; setAutostart(on); void autostartPref.set(on).then(setAutostart); }} /> {t("settings.autostart")}</label>
                    {autostartPref.background && <label className="check"><input type="checkbox" checked={autostartBackground} disabled={!autostart} onChange={(e) => { const on = e.target.checked; setAutostartBackground(on); void autostartPref.background?.set(on).then(setAutostartBackground); }} /> {t("settings.autostartBackground")}</label>}
                    <span className="muted small">{t("settings.autostartHint")}</span>
                  </>
                )}
                <h3>{t("settings.speakerView")}</h3>
                <label className="check">
                  <input type="checkbox" checked={settings.featureSelfInSpeakerView} onChange={(e) => update({ featureSelfInSpeakerView: e.target.checked })} />
                  {t("settings.featureSelf")}
                </label>
                <span className="muted small">{t("settings.featureSelfHint")}</span>
                {/* Direct messages exist with a directory account only (docs/features/link-previews.md). */}
                {directoryAccount && <>
                  <h3>{t("settings.dmPreviewsHead")}</h3>
                  <label className="check">
                    <input type="checkbox" checked={settings.dmLinkPreviews} onChange={(e) => update({ dmLinkPreviews: e.target.checked })} />
                    {t("settings.dmPreviews")}
                  </label>
                  <span className="muted small">{t(platform.links.lookUp ? "settings.dmPreviewsHintApp" : "settings.dmPreviewsHint")}</span>
                </>}
                <h3>{t("settings.idle")}</h3>
                {/* The desktop app detects input in the whole system by itself (platform.systemIdle): an explanation, no switch. */}
                {platform.systemIdle === "always" ? <span className="muted small">{t("settings.idleHintApp")}{platform.systemActivity ? ` ${t("settings.idleHintAppSystem")}` : ""}</span> : <>
                <label className="check">
                  {/* The permission prompt only opens inside the click, so the switch asks right here. */}
                  <input type="checkbox" checked={idleDetect} disabled={!idleDetectionSupported()} onChange={(e) => { const on = e.target.checked; void setIdleDetection(activity, on).then((ok) => { setIdleDetect(ok); setIdleDenied(on && !ok); }); }} />
                  {t("settings.idleDetect")}
                </label>
                <span className="muted small">{t("settings.idleHint")}</span>
                {!idleDetectionSupported() && <span className="muted small">{t("settings.idleUnsupported")}</span>}
                {idleDenied && <span className="error small">{t("settings.idleDenied")}</span>}
                </>}
              </>
            )}

            {tab === "voice" && (
              <>
                <h3>{t("settings.input")}</h3>
                <label className="stack">
                  {t("settings.microphone")}
                  <select value={voice.inputDeviceId ?? settings.inputDeviceId ?? ""}
                    onChange={(e) => { const id = e.target.value || null; update({ inputDeviceId: id }); void client.setInputDevice(id); }}>
                    <option value="">{t("settings.default")}</option>
                    {devices.inputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
                  </select>
                </label>
                <div className="row">
                  <button className="secondary" disabled={testBusy} aria-pressed={voice.micTest} onClick={() => void toggleMicTest()}><Icon name={voice.micTest ? "square" : "play"} /> {voice.micTest ? t("settings.micTestStop") : t("settings.micTest")}</button>
                </div>
                {voice.micTest && <p className="warn-box small" role="status">{joined && !voice.afkRoom ? t("settings.micTestRunningJoined") : t("settings.micTestRunning")}</p>}
                {(joined || voice.micTest) && (
                  <div className="meter" title={t("dock.micLevel")}>
                    <div className="meter-fill" style={{ width: `${levelPct}%` }} />
                    {settings.mode === "vad" && <div className="meter-threshold" style={{ left: `${thresholdPct}%` }} />}
                  </div>
                )}
                <span className="muted small">{t("settings.micTestHint")}</span>
                <h3>{t("settings.speaking")}</h3>
                <div className="row">
                  <label className="check"><input type="radio" checked={settings.mode === "vad"} onChange={() => update({ mode: "vad" })} /> {t("settings.vad")}</label>
                  <label className="check"><input type="radio" checked={settings.mode === "ptt"} onChange={() => update({ mode: "ptt" })} /> {t("settings.ptt")}</label>
                </div>
                {settings.mode === "vad" ? (
                  <>
                    <label className="stack">
                      {t("settings.threshold")}
                      <input type="range" min={0.005} max={0.25} step={0.005} value={settings.vadThreshold} onChange={(e) => update({ vadThreshold: Number(e.target.value) })} />
                    </label>
                    <label className="stack">
                      {t("settings.hangover", { ms: settings.vadHangoverMs })}
                      <input type="range" min={100} max={1500} step={50} value={settings.vadHangoverMs} onChange={(e) => update({ vadHangoverMs: Number(e.target.value) })} />
                      <span className="muted small">{t("settings.hangoverHint")}</span>
                    </label>
                  </>
                ) : platform.mobile ? (
                  <span className="muted small">{t("settings.pttTouchHint", { key: keyName(settings.pttKey, keyLayout) })}</span>
                ) : (
                  <div className="stack">
                    <span>{t("settings.key")} <kbd>{keyName(settings.pttKey, keyLayout)}</kbd> <button className="secondary small" onClick={() => setCapturingKey(true)}>{capturingKey ? t("settings.pressKey") : t("settings.change")}</button></span>
                    <span className="muted small">{platform.hotkeys?.globalPtt ? t("settings.pttHintGlobal") : t("settings.pttHint")}</span>
                  </div>
                )}
                <h3>{t("settings.micBoost")}</h3>
                <label className="check"><input type="checkbox" checked={settings.micBoost.auto} onChange={(e) => update({ micBoost: { ...settings.micBoost, auto: e.target.checked } })} /> {t("settings.micBoostAuto")}</label>
                {!settings.micBoost.auto && (
                  <label className="stack">
                    {t("settings.micBoostGain", { pct: Math.round(settings.micBoost.gain * 100) })}
                    <input type="range" min={1} max={boostLimits(platform.mobile).max} step={0.25} value={settings.micBoost.gain} onChange={(e) => update({ micBoost: { ...settings.micBoost, gain: Number(e.target.value) } })} />
                  </label>
                )}
                <span className="muted small">
                  {(joined || voice.micTest) && settings.micBoost.auto && (!voice.afkRoom || voice.micTest) ? `${t("settings.micBoostNow", { pct: Math.round(voice.micBoost * 100) })} ` : ""}{t("settings.micBoostHint", { max: boostLimits(platform.mobile).max * 100 })}
                </span>
                <h3>{t("settings.output")}</h3>
                <label className="stack">
                  {t("settings.voiceOut")}
                  <select value={settings.outputDeviceId ?? ""} disabled={devices.outputs.length === 0}
                    onChange={(e) => { const id = e.target.value || null; update({ outputDeviceId: id }); if (id) void client.setOutputDevice(id); void client.setMicTestOutput(id); }}>
                    <option value="">{t("settings.default")}</option>
                    {devices.outputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
                  </select>
                  {devices.outputs.length === 0 && <span className="muted small">{t("settings.outputChromium")}</span>}
                </label>
                <label className="stack">
                  {t("settings.screenAudio")}
                  <select value={settings.screenOutputDeviceId ?? ""} disabled={devices.outputs.length === 0}
                    onChange={(e) => { const id = e.target.value || null; update({ screenOutputDeviceId: id }); void client.setScreenOutputDevice(id); }}>
                    <option value="">{t("settings.sameAsVoice")}</option>
                    {devices.outputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
                  </select>
                  <span className="muted small">{t("settings.screenAudioHint")}</span>
                </label>
                <label className="stack">
                  {t("settings.radioAudio")}
                  {/* Only stored: App.tsx hands the choice to the radio player, which switches a running stream over at once. */}
                  <select value={settings.radioOutputDeviceId ?? ""} disabled={devices.outputs.length === 0}
                    onChange={(e) => update({ radioOutputDeviceId: e.target.value || null })}>
                    <option value="">{t("settings.sameAsVoice")}</option>
                    {devices.outputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
                  </select>
                  <span className="muted small">{t("settings.radioAudioHint")}</span>
                </label>
                {!joined && <span className="muted small">{t("settings.deviceNamesHint")}</span>}
                <span className="muted small">{t("settings.devicesLocal")}</span>
              </>
            )}

            {tab === "sounds" && (
              <>
                <h3>{t("settings.soundsHead")}</h3>
                {([...VOICE_CUES, null, "message"] as const).map((cue) => cue === null ? <h3 key="messages">{t("settings.soundsMessagesHead")}</h3> : (
                  <div className="row" key={cue}>
                    <label className="check">
                      <input type="checkbox" checked={settings.sounds[cue]}
                        onChange={(e) => update({ sounds: { ...settingsRef.current.sounds, [cue]: e.target.checked } as SoundSettings })} />
                      {SOUND_LABELS[cue]}
                    </label>
                    <button className="icon" title={t("settings.soundPreview")} aria-label={`${SOUND_LABELS[cue]}: ${t("settings.soundPreview")}`}
                      onClick={() => client.playSound(cue, true)}><Icon name="play" /></button>
                  </div>
                ))}
                <h3>{t("settings.soundsAllHead")}</h3>
                <label className="stack">
                  {t("settings.soundVolume", { pct: Math.round(settings.sounds.volume * 100) })}
                  <input type="range" min={0} max={1} step={0.05} value={settings.sounds.volume}
                    onChange={(e) => update({ sounds: { ...settingsRef.current.sounds, volume: Number(e.target.value) } })} />
                </label>
                <span className="muted small">{t("settings.soundsHint")}</span>
                <NotificationSettings />
              </>
            )}

            {tab === "camera" && (
              <>
                <h3>{t("settings.device")}</h3>
                <label className="stack">
                  {t("settings.tab.camera")}
                  <select value={settings.cameraDeviceId ?? ""}
                    onChange={(e) => { const id = e.target.value || null; update({ cameraDeviceId: id }); void client.setCameraDevice(id); }}>
                    <option value="">{t("settings.default")}</option>
                    {devices.cameras.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
                  </select>
                  <span className="muted small">{t("settings.cameraPreselect")} {t("settings.devicesLocal")}</span>
                </label>
                <h3>{t("settings.picture")}</h3>
                <label className="stack">
                  {t("settings.quality")}
                  <select value={settings.cameraQuality} onChange={(e) => { const q = e.target.value as "360p" | "720p"; update({ cameraQuality: q }); if (voice.cameraOn) void client.setCameraEnabled(true, undefined, q); }}>
                    <option value="720p">{t("settings.q720")}</option>
                    <option value="360p">{t("settings.q360")}</option>
                  </select>
                  <span className="muted small">{t("settings.qualityHint")}{platform.mobile ? ` ${t("settings.qualityMobile")}` : ""}</span>
                </label>
                <label className="stack">
                  {t("settings.background")}
                  <select value={settings.cameraBlur} disabled={!VoiceClient.supportsBlur()}
                    onChange={(e) => { const v = Number(e.target.value); update({ cameraBlur: v }); if (voice.cameraOn) void client.setCameraBlur(v); }}>
                    {BLUR_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <span className="muted small">{VoiceClient.supportsBlur() ? t("settings.blurHint") : t("settings.noBlur")}</span>
                </label>
              </>
            )}

            {tab === "sessions" && accountDevices && <DevicesTab {...accountDevices} />}
            {tab === "sessions" && !accountDevices && (
              <>
                <h3>{t("profile.sessions")}</h3>
                <span className="muted small">{t("profile.devicesHint")}</span>
                {sessions === null ? <span className="muted">{t("common.loading")}</span> : (
                  <ul className="session-list">
                    {sessions.map((s) => (
                      <li key={s.id}>
                        <div className="stack">
                          <span><strong>{s.label ?? t("profile.unknownDevice")}</strong> {s.current && <span className="badge">{t("profile.thisDevice")}</span>}</span>
                          <span className="muted small">{t("profile.signedIn", { date: fmt(s.createdAt) })}{s.lastUsedAt ? ` · ${t("profile.lastActive", { date: fmt(s.lastUsedAt) })}` : ""}</span>
                        </div>
                        <span className="spacer" />
                        {!s.current && <button className="secondary small" disabled={busy} onClick={() => void revoke(s)}>{t("profile.signOut")}</button>}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="row">
                  <button className="secondary" disabled={busy || others === 0} onClick={() => void revokeOthers()}>{t("profile.signOutOthers")}{others ? ` (${others})` : ""}</button>
                  <button className="secondary" disabled={busy} onClick={() => void loadSessions()}>{t("common.refresh")}</button>
                </div>
              </>
            )}

            {tab === "account" && (
              <>
                <h3>{t("profile.identity")}</h3>
                {localHandle && serverAccount ? <LocalAccountSettings handle={localHandle} serverName={serverAccount.serverName} onChangePassword={serverAccount.onChangePassword} onDelete={serverAccount.onDelete} />
                  : handle ? <p>{t("login.handle")}: <strong>@{handle}</strong>{dirHost ? <span className="muted small"> {t("login.verifiedAt", { host: dirHost })}</span> : null}</p> : <p className="muted small">{t("profile.noHandle")}</p>}
                <span className="muted small">{t("profile.publicKey")}</span>
                <code className="key">{me?.publicKey ?? publicKey ?? "…"}</code>
                {directoryUrl && !localHandle && (
                  <p className="muted small">
                    <a href={safeHref(`${directoryUrl}/?handle=${encodeURIComponent(handle ?? "")}`)} target="_blank" rel="noreferrer">{t("profile.manageAt", { host: dirHost ?? "" })}</a>{t("profile.manageHint")}
                  </p>
                )}
                {onDirectorySignIn && <p className="muted small">{t("profile.directorySignInHint")} <button className="secondary small" onClick={onDirectorySignIn}>{t("profile.directorySignIn")}</button></p>}
                <span className="muted small">{t("profile.signOutHint")}</span>
                <div className="row">
                  <button className="secondary" onClick={onLogout}>{t("profile.signOut")}</button>
                </div>
              </>
            )}

            {tab === "app" && platform.app && (
              <>
                <h3>{t("desktopLogin.app")}</h3>
                <p>{t("login.version", { v: platform.app.version })} <span className="muted small">· Electron {platform.app.electron} · Chromium {platform.app.chrome}</span></p>
                <h3>{t("update.title")}</h3>
                <p role="status">{describeUpdate(appUpdate ?? { status: "unsupported" })}</p>
                <div className="row">
                  {platform.updates && appUpdate && (appUpdate.status === "idle" || appUpdate.status === "error") && <button className="secondary" onClick={() => platform.updates?.check()}>{t("update.check")}</button>}
                  {appUpdate?.status === "ready" && <button onClick={() => platform.updates?.restartAndInstall()}>{t("update.restart")}</button>}
                  {(appUpdate?.status === "available" || !platform.updates) && <button className="secondary" onClick={() => platform.links.openExternal(DOWNLOAD_URL)}>{t("update.downloadPage")}</button>}
                </div>
                <span className="muted small">{t("update.hint")}</span>
              </>
            )}
            {tab === "games" && games && <GamesTab games={games} hiddenInAccount={inAccount && sealed} />}

            {tab === "blocked" && (
              <>
                <h3>{t("settings.tab.blocked")}</h3>
                <p className="muted small">{t(blocked.inAccount ? "block.hintAccount" : "block.hintDevice")}</p>
                {blocked.list.length === 0 ? <p className="muted">{t("block.none")}</p> : (
                  <ul className="blocked-list">{blocked.list.map((b) => (
                    <li key={b.publicKey}><span className="blocked-name">{b.name}</span><span className="muted small">{b.publicKey.slice(0, 16)}…</span><button className="secondary small" onClick={() => blocked.onUnblock(b.publicKey)}><Icon name="undo-2" /> {t("block.unblock")}</button></li>
                  ))}</ul>
                )}
              </>
            )}

            {tab === "hotkeys" && platform.hotkeys && <HotkeysTab settings={settings} bindings={settings.hotkeys} layout={keyLayout} status={hotkeyStatus} capturing={capturingHotkey} refused={refusedHotkey}
              onCapture={(action) => { setRefusedHotkey(null); setCapturingHotkey(action); }} onRemove={(action) => { setRefusedHotkey(null); update({ hotkeys: { ...settingsRef.current.hotkeys, [action]: null } }); }} />}

            {tab === "licenses" && <LicensesTab version={clientVersion} />}

            {SYNCED.includes(tab) && (
              <>
                <span className="muted small settings-sync"><Icon name={inAccount ? "cloud" : "monitor"} /> {inAccount ? t(sealed ? "settings.syncAccountSealed" : "settings.syncAccount", { handle: directoryAccount?.handle ?? "" }) : t("settings.syncDevice")}</span>
                {syncError && <p className="error small">{t("settings.syncError", { error: syncError })}</p>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
