import { useEffect, useState } from "react";
import type { ThirdPartyPackage } from "./licenses/types";
import { t } from "./i18n";

const SOURCE_URL = "https://github.com/danielklessa/squorli";
const APACHE_URL = "https://www.apache.org/licenses/LICENSE-2.0";

/**
 * Einstellungen > Lizenzen: Squorli's own license and the third-party packages and assets inside this client with their
 * license texts. The list is generated (tools/licenses.mjs) and a chunk of its own, fetched when the tab opens.
 */
export function LicensesTab({ version }: { version: string | null }) {
  const [data, setData] = useState<{ packages: ThirdPartyPackage[]; texts: string[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import("./licenses/thirdParty").then((m) => { if (alive) setData({ packages: m.PACKAGES, texts: m.TEXTS }); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  return (
    <>
      <h3>{t("licenses.own")}</h3>
      <p>Squorli Server{version ? ` ${version}` : ""} · Copyright 2026 Daniel Klessa</p>
      <p className="muted small">
        {t("licenses.ownText")} <a href={APACHE_URL} target="_blank" rel="noreferrer noopener">Apache License 2.0</a> · <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener">{t("licenses.source")}</a>
      </p>

      <h3>{t("licenses.thirdParty")}</h3>
      <p className="muted small">{t("licenses.thirdPartyText")}</p>
      {failed && <p className="error">{t("licenses.loadFailed")}</p>}
      {!data && !failed && <p className="muted">{t("common.loading")}</p>}
      {data && (
        <ul className="license-list">
          {data.packages.map((p) => (
            <li key={`${p.name}@${p.version}`}>
              <details>
                <summary>
                  <strong>{p.name}</strong> <span className="muted">{p.version}</span>
                  <span className="license-id">{p.license}</span>
                </summary>
                <p className="muted small">
                  {p.note && <>{p.note} · </>}{p.author && <>{p.author} · </>}
                  <a href={p.url} target="_blank" rel="noreferrer noopener">{p.url}</a>
                </p>
                {p.text >= 0 ? <pre className="license-text">{data.texts[p.text]}</pre> : <p className="muted small">{t("licenses.noText", { license: p.license })}</p>}
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
