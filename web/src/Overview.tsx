import { useEffect, useState } from "react";
import { ago, api, PORTAL_NAMES, type AppSettings, type Overview as Data } from "./api";
import { Led } from "./Led";

export function Overview({ go }: { go: (p: string) => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [s, setS] = useState<AppSettings | null>(null);
  useEffect(() => {
    api<Data>("/api/overview").then(setD).catch(() => {});
    api<AppSettings>("/api/settings").then(setS).catch(() => {});
  }, []);
  const setMode = (mode: "manual" | "auto") => api<AppSettings>("/api/settings", { mode }, "PUT").then((r) => setS((x) => x && { ...x, mode: r.mode })).catch(() => {});
  if (!d) return <h1>Übersicht</h1>;
  return (
    <>
      <h1>Übersicht</h1>
      <p className="dim lead">Live-Status deiner Wohnungssuche in Köln</p>
      <div className="grid">
        <section className="card tile hero">
          <span className="dim">Neue Wohnungen heute</span>
          <Led value={d.today} label="Neue Wohnungen heute" />
          <span>{d.waiting} warten auf dich</span>
        </section>
        <section className="card tile magenta">
          <span className="dim">Verworfen</span>
          <Led value={d.filtered} label="Verworfen" color="#ff6fb5" />
          <span className="dim">vom Filter aussortiert</span>
        </section>
        <section className="card tile">
          <span className="dim">Portale</span>
          {d.portals.length === 0 ? <span className="dim">Noch keine Daten</span> : d.portals.map((p) => (
            <div className="prow" key={p.portal}><span>{PORTAL_NAMES[p.portal] ?? p.portal}</span><b>{p.count}</b></div>
          ))}
        </section>
        {s && (
          <section className="card tile">
            <span className="dim">Modus</span>
            <div className="seg" role="group" aria-label="Modus">
              <button aria-pressed={s.mode === "manual"} onClick={() => setMode("manual")}>Freigabe</button>
              <button aria-pressed={s.mode === "auto"} onClick={() => setMode("auto")}>Auto</button>
            </div>
            <span className="dim">{s.mode === "auto" ? `Schreibt selbst an, max. ${s.dailyLimit} pro Tag und Portal, nachts Pause.` : "Jede Nachricht wartet auf dein Okay."}</span>
            {s.dryRun && <span className="badge" style={{ marginLeft: 0, justifySelf: "start" }}>Dry-Run: es wird nichts gesendet</span>}
          </section>
        )}
        <section className="card wide">
          <h2>Wartet auf dich</h2>
          {d.recent.length === 0 ? <p className="dim">Nichts offen. Neue Inserate erscheinen hier.</p> : (
            <div className="rows">
              {d.recent.map((l) => (
                <div className="row" key={l.id}>
                  <div>
                    <div>{l.title}</div>
                    <small>{[l.address, l.sizeM2 && `${l.sizeM2} m²`, l.price].filter(Boolean).join(" · ")}</small>
                  </div>
                  <small className="badge">{PORTAL_NAMES[l.portal] ?? l.portal} · {ago(l.foundAt)}</small>
                </div>
              ))}
            </div>
          )}
          <button className="cta press slim" onClick={() => go("freigaben")}>Alle prüfen</button>
        </section>
      </div>
    </>
  );
}
