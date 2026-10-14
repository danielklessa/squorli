import type { VoiceClient } from "./voice/voiceClient";
import { USER_VOLUME_MAX } from "./voice/userVolumes";
import { Icon } from "./Icon";
import { t } from "./i18n";

/**
 * How loud one person is played back here, 0..200 % (context menus of voice members, stage tiles and the member list).
 * Local playback only; stored per device for that person's key (voice/userVolumes.ts). The parent re-renders on every
 * voice state change, which is how the value follows the slider.
 */
export function UserVolumeControl({ client, publicKey }: { client: VoiceClient; publicKey: string }) {
  const percent = Math.round(client.getUserVolume(publicKey) * 100);
  const label = t("volume.user");
  return (
    <div className="user-volume" role="group" aria-label={label}>
      <span className="muted small">{label}</span>
      {client.isLevelMatching() && <span className="muted small">{t("volume.userLevelled")}</span>}
      <div className="user-volume-row">
        <input type="range" data-menu-item min={0} max={USER_VOLUME_MAX * 100} step={1} value={percent} title={label} aria-label={label} aria-valuetext={`${percent} %`}
          // Home/End belong to the slider here, not to the menu's item navigation.
          onKeyDown={(event) => { if (event.key === "Home" || event.key === "End") event.stopPropagation(); }}
          onChange={(event) => client.setUserVolume(publicKey, Number(event.target.value) / 100)} />
        <output>{percent} %</output>
        <button role="menuitem" className="icon" disabled={percent === 100} title={t("volume.reset")} aria-label={t("volume.reset")} onClick={() => client.setUserVolume(publicKey, 1)}><Icon name="rotate-ccw" /></button>
      </div>
    </div>
  );
}
