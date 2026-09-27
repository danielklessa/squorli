import { Avatar } from "./Avatar";
import { t } from "./i18n";

export type ShareViewer = { identity: string; name: string; avatarUrl: string | null };

const VIEWERS_SHOWN = 8;

/**
 * Who watches the user's own screen share (voice/shareViewers.ts): their avatars, or initials, overlapping in the top left
 * corner of the share's tile (VoiceStage.tsx) and of its pop-out window (VideoWindows.tsx); the pointer on one shows it
 * large and the name as its tool tip (user's wish, 27 September 2026). Only the sharer sees it.
 */
export function ShareViewers({ viewers }: { viewers: readonly ShareViewer[] }) {
  if (viewers.length === 0) return null;
  const shown = viewers.slice(0, VIEWERS_SHOWN);
  const rest = viewers.slice(VIEWERS_SHOWN);
  return (
    <div className="share-viewers" role="group" aria-label={t("stage.shareViewers", { n: viewers.length })} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      {shown.map((v) => <span key={v.identity} className="share-viewer" title={v.name}><Avatar name={v.name} src={v.avatarUrl} size="small" /></span>)}
      {rest.length > 0 && <span className="share-viewer share-viewer-more" title={rest.map((v) => v.name).join(", ")}>+{rest.length}</span>}
    </div>
  );
}
