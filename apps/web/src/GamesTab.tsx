import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";
import { askInput } from "./dialogs";
import type { GameDetection } from "./gameDetection";
import { t, tOr } from "./i18n";
import type { DetectedGame } from "./platform/bridge";
import { loadVoiceSettings, saveVoiceSettings } from "./voice/settings";
import { useVoiceSettings } from "./voice/useVoiceSettings";

/**
 * Einstellungen > Spiele (desktop app only, docs/features/games.md): the two switches (detect and show at all, show on
 * servers too; user settings that follow the account, voice/settings.ts `games`), what is detected right now, and the list
 * of installed games and added programs with a tick each: no tick = never shown. The hide list is kept on this device, and
 * follows the account where that stores the settings sealed (`hiddenInAccount`; gameDetection.ts); the text says which.
 */
const SEARCH_FROM = 12;

export function GamesTab({
  games,
  hiddenInAccount,
}: {
  games: GameDetection;
  hiddenInAccount: boolean;
}) {
  const state = useSyncExternalStore(games.subscribe, () => games.state);
  const { settings, running } = state;
  const display = useVoiceSettings().games;
  const setDisplay = (next: Partial<typeof display>) => {
    const all = loadVoiceSettings();
    saveVoiceSettings({ ...all, games: { ...all.games, ...next } });
  };
  const [list, setList] = useState<DetectedGame[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    games.scan().then(setList, (e) => setError(String(e)));
  }, [games]);
  useEffect(() => {
    if (state.enabled) load();
    else setList(null);
  }, [state.enabled, load]);

  const add = async () => {
    const picked = await games.pickProgram();
    if (!picked) return;
    const name = await askInput({
      title: t("games.addTitle"),
      label: t("games.addLabel"),
      initial: picked.name,
      confirmLabel: t("games.addConfirm"),
    });
    if (name === null) return;
    games.addCustom({ path: picked.path, name: name.trim() || picked.name });
    load();
  };

  const wanted = query.trim().toLowerCase();
  const visible = (list ?? []).filter(
    (game) => !wanted || game.name.toLowerCase().includes(wanted),
  );
  return (
    <>
      <h3>{t("games.head")}</h3>
      <label className="check">
        <input
          type="checkbox" className="switch" role="switch"
          checked={display.enabled}
          onChange={(e) => setDisplay({ enabled: e.target.checked })}
        />
        {t("games.enable")}
      </label>
      <span className="muted small">{t("games.hint")}</span>

      {display.enabled && (
        <>
          <label className="check">
            <input
              type="checkbox" className="switch" role="switch"
              checked={display.servers}
              onChange={(e) => setDisplay({ servers: e.target.checked })}
            />
            {t("games.servers")}
          </label>
          <span className="muted small">{t("games.serversHint")}</span>

          <h3>{t("games.nowHead")}</h3>
          <span>
            {running ? (
              state.shown ? (
                running.name
              ) : (
                t("games.nowHidden", { name: running.name })
              )
            ) : (
              <span className="muted">{t("games.nowNone")}</span>
            )}
          </span>
          <span className="muted small">{t("games.nowHint")}</span>

          <h3>
            {list
              ? t("games.listHead", { n: list.length })
              : t("games.listHeadLoading")}
          </h3>
          {error && <span className="error">{error}</span>}
          <div className="row">
            <button className="secondary" onClick={() => void add()}>
              <Icon name="plus" /> {t("games.add")}
            </button>
            <button className="secondary" onClick={load}>
              {t("games.rescan")}
            </button>
          </div>
          {list && list.length >= SEARCH_FROM && (
            <input
              type="search"
              value={query}
              placeholder={t("games.search")}
              aria-label={t("games.search")}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <span className="muted small">
            {t(hiddenInAccount ? "games.listHintAccount" : "games.listHint")}
          </span>
          {list === null && !error ? (
            <span className="muted">{t("common.loading")}</span>
          ) : (
            <ul className="game-list">
              {visible.map((game) => {
                const custom = games.customOf(game.id);
                return (
                  <li key={game.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={!settings.hidden.includes(game.id)}
                        onChange={(e) =>
                          games.setHidden(game.id, !e.target.checked)
                        }
                      />
                      {/* From this computer (the shell reads it), never from the directory: that would tell it what is installed here. */}
                      {game.icon?.startsWith("data:image/") ? (
                        <img src={game.icon} alt="" width="20" height="20" />
                      ) : (
                        <Icon name="gamepad-2" />
                      )}
                      <span>{game.name}</span>
                    </label>
                    <span className="muted small">
                      {tOr(`games.source.${game.source}`, game.source)}
                    </span>
                    {custom && (
                      <button
                        className="icon danger"
                        title={t("common.remove")}
                        aria-label={`${game.name}: ${t("common.remove")}`}
                        onClick={() => {
                          games.removeCustom(custom.path);
                          load();
                        }}
                      >
                        <Icon name="trash-2" />
                      </button>
                    )}
                  </li>
                );
              })}
              {list !== null && visible.length === 0 && (
                <li className="muted">
                  {wanted ? t("games.noMatch") : t("games.listEmpty")}
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </>
  );
}
