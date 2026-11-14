import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";
import { askInput } from "./dialogs";
import { loadAudienceNames, saveAudienceName, suggestAudiencePeople, withAudiencePerson, type AudiencePerson } from "./gameAudience";
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
 * "Wer mein Spiel sehen darf" (14 November 2026, gameAudience.ts): everybody, only the listed people, or all but the listed;
 * the lists are filled from the friends and the members of the connected servers (`audience.people`), and `audience.unsupported`
 * names the relays that cannot enforce a rule yet and therefore hear of no game while one is set.
 */
const SEARCH_FROM = 12;

export function GamesTab({
  games,
  hiddenInAccount,
  audience,
}: {
  games: GameDetection;
  hiddenInAccount: boolean;
  audience: { people: AudiencePerson[]; unsupported: string[]; inAccount: boolean };
}) {
  const state = useSyncExternalStore(games.subscribe, () => games.state);
  const { settings, running } = state;
  const voiceSettings = useVoiceSettings();
  const display = voiceSettings.games;
  const rule = voiceSettings.gameAudience;
  const setRule = (next: typeof rule) => saveVoiceSettings({ ...loadVoiceSettings(), gameAudience: next });
  const listName = rule.mode === "all" ? null : rule.mode;
  const listed = listName ? rule[listName] : [];
  const [personQuery, setPersonQuery] = useState("");
  const remembered = loadAudienceNames();
  const nameOf = (key: string) => audience.people.find((p) => p.publicKey === key)?.name ?? remembered[key] ?? `${key.slice(0, 16)}…`;
  const suggestions = listName ? suggestAudiencePeople(audience.people, personQuery, new Set(listed)) : [];
  const setPerson = (key: string, name: string, on: boolean) => {
    if (!listName) return;
    const next = withAudiencePerson(loadVoiceSettings().gameAudience, listName, key, on);
    setRule(next);
    saveAudienceName(key, name, next);
  };
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

          <h3>{t("games.audienceHead")}</h3>
          <div className="seg wide" role="radiogroup" aria-label={t("games.audienceHead")}>
            {(["all", "only", "except"] as const).map((mode) => (
              <button key={mode} role="radio" aria-checked={rule.mode === mode} className={rule.mode === mode ? "active" : ""} onClick={() => setRule({ ...rule, mode })}>
                {t(`games.audience.${mode}`)}
              </button>
            ))}
          </div>
          <span className="muted small">{t(`games.audienceHint.${rule.mode}`)}</span>
          {listName && (
            <>
              {listed.length === 0 ? (
                <span className="muted">{t(listName === "only" ? "games.audienceEmptyOnly" : "games.audienceEmptyExcept")}</span>
              ) : (
                <ul className="blocked-list">
                  {listed.map((key) => (
                    <li key={key}>
                      <span className="blocked-name">{nameOf(key)}</span>
                      <span className="muted small">{key.slice(0, 16)}…</span>
                      <button className="secondary small" onClick={() => setPerson(key, "", false)}>
                        <Icon name="x" /> {t("common.remove")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                type="search"
                value={personQuery}
                placeholder={t("games.audienceSearch")}
                aria-label={t("games.audienceSearch")}
                onChange={(e) => setPersonQuery(e.target.value)}
              />
              {personQuery.trim() && (
                <ul className="audience-suggest">
                  {suggestions.map((p) => (
                    <li key={p.publicKey}>
                      <button className="secondary" onClick={() => { setPerson(p.publicKey, p.name, true); setPersonQuery(""); }}>
                        <Icon name="plus" /> <span>{p.name}</span>
                        {p.handle && <span className="muted small">{p.handle}</span>}
                      </button>
                    </li>
                  ))}
                  {suggestions.length === 0 && <li className="muted small">{t("games.audienceNoMatch")}</li>}
                </ul>
              )}
              <span className="muted small">{t(audience.inAccount ? "games.audiencePrivacyAccount" : "games.audiencePrivacy")}</span>
              {audience.unsupported.length > 0 && (
                <span className="error small">{t("games.audienceUnsupported", { names: audience.unsupported.join(", ") })}</span>
              )}
            </>
          )}

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
