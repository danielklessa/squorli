import { audienceMenuAction, saveAudienceName } from "./gameAudience";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { loadVoiceSettings, saveVoiceSettings } from "./voice/settings";
import { useVoiceSettings } from "./voice/useVoiceSettings";

/**
 * The entry of a person's menu (member list, friends list) that hides my game from them or shows it (14 November 2026,
 * docs/features/games.md): the same rule as Einstellungen > Spiele, "Wer mein Spiel sehen darf" (gameAudience.ts
 * `audienceMenuAction`). Only while the game display is on; the name is remembered for the settings' list.
 */
export function GameAudienceMenuItem({ publicKey, name, className, onDone }: { publicKey: string; name: string; className?: string; onDone: () => void }) {
  const settings = useVoiceSettings();
  const action = settings.games.enabled ? audienceMenuAction(settings.gameAudience, publicKey) : null;
  if (!action) return null;
  const apply = () => {
    const next = audienceMenuAction(loadVoiceSettings().gameAudience, publicKey)?.next;
    if (next) { saveVoiceSettings({ ...loadVoiceSettings(), gameAudience: next }); saveAudienceName(publicKey, name, next); }
    onDone();
  };
  return (
    <button role="menuitem" className={className} onClick={apply}>
      {action.kind === "hide" || action.kind === "unshow" ? <Icon name="eye-off" /> : <Icon name="eye" />} {t(`games.menu.${action.kind}`)}
    </button>
  );
}
