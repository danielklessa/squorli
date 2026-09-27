import { Permission, displayNameOf, hasPermission, type Channel, type Member, type VoiceMember } from "@squorli/protocol";
import type { ServerApi } from "./api";
import { Avatar } from "./Avatar";
import { ContextMenu, type MenuAnchor } from "./ContextMenu";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { UserVolumeControl } from "./UserVolumeControl";
import { VoiceMemberActions } from "./VoiceMemberActions";
import type { VoiceClient, VoiceState } from "./voice/voiceClient";
import { feedId } from "./voice/videoWatch";

/**
 * The context menu of a voice channel's member: the sidebar's voice members and the stage's tiles open this one menu
 * (user's wish, 24 September 2026: always the same entries in both places). Identity, the volume for me, turning their
 * camera or screen off or on for myself while we sit in the same room, then the voice entries of the member list.
 */
export function VoiceMemberMenu({ anchor, member, client, voiceState, api, myUserId, permsIn, voice, channels, voteKickAllowed, onVoteKick, onClose, onError }: {
  anchor: MenuAnchor;
  member: Member;
  client: VoiceClient;
  /** My own voice connection if it belongs to this server, else null. */
  voiceState: VoiceState | null;
  api: ServerApi;
  myUserId: string;
  /** My permissions in a channel (null = server-wide). */
  permsIn: (channelId: string | null) => number;
  voice: Record<string, VoiceMember[]>;
  channels: Channel[];
  voteKickAllowed: Record<string, boolean>;
  onVoteKick: (userId: string, channelId: string) => void;
  onClose: () => void;
  onError: (text: string | null) => void;
}) {
  const name = displayNameOf(member);
  // Camera and screen from LiveKit while in the same room (media state, at once); otherwise what the server knows.
  const p = voiceState?.participants.find((x) => x.identity === member.userId && !x.isLocal) ?? null;
  const mayView = !!voiceState?.channelId && hasPermission(permsIn(voiceState.channelId), Permission.VIEW_VIDEO);
  return (
    <ContextMenu anchor={anchor} label={name} onClose={onClose}>
      <div className="context-identity" role="presentation"><Avatar name={name} src={member.avatarUrl} online={member.online} afk={member.afk} /><strong>{name}</strong></div>
      {/* A blocked person is silent here whatever the slider says (docs/features/reports.md, stage 3). */}
      {client.isBlocked(member.publicKey) ? <span className="muted small"><Icon name="ban" /> {t("block.voiceMuted")}</span> : <UserVolumeControl client={client} publicKey={member.publicKey} />}
      {p && mayView && (["camera", "screen"] as const).filter((source) => source === "camera" ? p.cameraOn : p.screenOn).map((source) => {
        const id = feedId(p.identity, source);
        const on = client.isVideoWatching(id);
        return <button key={source} role="menuitem" className="secondary small" onClick={() => { onClose(); client.setVideoWatching(id, !on); }}><Icon name={on ? "eye-off" : "eye"} /> {t(`stage.${source}${on ? "Off" : "On"}`)}</button>;
      })}
      <VoiceMemberActions api={api} member={member} myUserId={myUserId} permsIn={permsIn} voice={voice} channels={channels}
        voteKickAllowed={voteKickAllowed} onVoteKick={onVoteKick} onClose={onClose} onError={onError}
        {...(p ? { streaming: p.cameraOn || p.screenOn } : {})} />
    </ContextMenu>
  );
}
