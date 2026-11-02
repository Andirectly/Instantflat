import { useEffect, useState } from "react";
import { ago, api, type AppSettings, type PortalsInfo, type PortalStatus } from "./api";

const LABEL: Record<PortalStatus["state"], string> = {
  ok: "Angemeldet", session_expired: "Abgemeldet", interaction_required: "Eingabe nötig", error: "Prüfung fehlgeschlagen", unknown: "Noch nicht geprüft",
};

export function Settings() {
  const [info, setInfo] = useState<PortalsInfo | null>(null);
  const [cfg, setCfg] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const load = () => api<PortalsInfo>("/api/portals").then(setInfo);
  useEffect(() => { load().catch(() => {}); api<AppSettings>("/api/settings").then(setCfg).catch(() => {}); }, []);
  const setLimit = (n: number) => api<AppSettings>("/api/settings", { dailyLimit: n }, "PUT").then((r) => setCfg((c) => c && { ...c, dailyLimit: r.dailyLimit })).catch((e: Error) => setErr(e.message));
  if (!info) return <h1>Einstellungen</h1>;

  async function check(id: string) {
    setBusy(id); setErr("");
    try { await api(`/api/portals/${id}/check`, {}); await load(); } catch (e) { setErr((e as Error).message); }
    setBusy("");
  }

  return (
    <>
      <h1>Einstellungen</h1>
      <p className="dim lead">Portal-Logins laufen im Browser auf dem Server. Instantflat speichert keine Passwörter.</p>
      <div className="card">
        <h2>Portale</h2>
        {!info.monitoring && <p className="dim">Die Session-Überwachung ist aus. Setze <code>SESSION_MONITOR=true</code> in der <code>.env</code>, sobald der Browser-Container läuft.</p>}
        <div className="rows">
          {info.portals.map((p) => (
            <div className="row" key={p.portal}>
              <div>
                <div>{p.name}</div>
                <small className="dim">{p.checkedAt ? `geprüft vor ${ago(p.checkedAt)}` : "nie geprüft"}{p.detail ? ` · ${p.detail}` : ""}</small>
              </div>
              <span className={`badge state-${p.state}`}>{LABEL[p.state]}</span>
              <button className="ghost press" disabled={!!busy} onClick={() => check(p.portal)}>{busy === p.portal ? "Prüft …" : "Jetzt prüfen"}</button>
            </div>
          ))}
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        <p><a href={info.loginUrl} target="_blank" rel="noreferrer">Im Server-Browser anmelden ↗</a></p>
      </div>
      {cfg && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Senden</h2>
          <p className="dim">Höchstens so viele pro Tag und Portal. Nachtruhe {cfg.nightFrom}–{cfg.nightTo} Uhr, zwischen zwei Nachrichten 2–8 Minuten Pause.</p>
          <div className="stepper">
            <button className="ghost press" aria-label="Weniger" disabled={cfg.dailyLimit <= 1} onClick={() => setLimit(cfg.dailyLimit - 1)}>−</button>
            <strong aria-live="polite">{cfg.dailyLimit}</strong>
            <button className="ghost press" aria-label="Mehr" disabled={cfg.dailyLimit >= 50} onClick={() => setLimit(cfg.dailyLimit + 1)}>+</button>
          </div>
          <p className="dim" style={{ marginBottom: 0 }}>{cfg.dryRun ? "Dry-Run ist aktiv (DRY_RUN=true in der .env): Formulare werden ausgefüllt, aber nie abgeschickt." : "Dry-Run ist aus: Nachrichten werden wirklich gesendet."}</p>
        </div>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Über</h2>
        <p className="dim" style={{ margin: 0 }}>Inserate liefert <a href="https://github.com/orangecoding/fredy" target="_blank" rel="noreferrer">Fredy</a> von Christian Kellner (orangecoding), Lizenz Apache-2.0 mit Commons Clause.</p>
      </div>
    </>
  );
}
