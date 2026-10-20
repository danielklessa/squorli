import { useEffect, useRef, useState } from "react";
import type { Channel, Member } from "@squorli/protocol";
import { Avatar } from "./Avatar";
import { useBackClose } from "./backStack";
import { Icon } from "./Icon";
import { t } from "./i18n";

/** Opening this sheet never requests a microphone or a voice token. */
export function MobileVoicePreview({ channel, participants, members, connected, onJoin, onClose }: {
  channel: Channel | null;
  participants: { userId: string; displayName: string }[];
  members: Member[];
  connected: boolean;
  onJoin: () => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useBackClose(onClose);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => { if (!channel) onClose(); }, [channel, onClose]);
  return <dialog ref={dialog} className="mobile-voice-preview" aria-labelledby="voice-preview-title" onCancel={onClose}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="mobile-voice-sheet">
      <header><Icon name="volume-2" /><h2 id="voice-preview-title">{channel?.name}</h2><button className="icon" onClick={onClose} aria-label={t("common.close")}><Icon name="x" /></button></header>
      <p className="muted">{t("stage.participants", { n: participants.length })}</p>
      <ul>{participants.map((person) => <li key={person.userId}><Avatar name={person.displayName} src={members.find((m) => m.userId === person.userId)?.avatarUrl} /><span>{person.displayName}</span></li>)}</ul>
      {!participants.length && <p className="muted">{t("mobile.emptyVoice")}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="mobile-voice-connect" disabled={busy || !channel} onClick={() => {
        setBusy(true); setError(null);
        void onJoin().catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); setBusy(false); });
      }}>{t(busy ? "mobile.joiningVoice" : connected ? "mobile.openVoice" : "mobile.joinVoice")}</button>
    </div>
  </dialog>;
}
