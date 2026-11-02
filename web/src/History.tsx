import { useEffect, useState } from "react";
import { ago, api, PORTAL_NAMES, type LogEntry, type OutboxEntry } from "./api";

const RESULT: Record<LogEntry["result"], string> = { ok: "Gesendet", dry_run: "Dry-Run", failed: "Fehler", blocked: "Blockiert" };
const STATUS: Record<OutboxEntry["status"], string> = { queued: "Wartet", sending: "Wird gesendet", dry_done: "Probelauf fertig", failed: "Fehlgeschlagen", unknown: "Unklar" };

export function History() {
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [box, setBox] = useState<OutboxEntry[]>([]);
  const [err, setErr] = useState("");
  const load = () => Promise.all([api<LogEntry[]>("/api/log"), api<OutboxEntry[]>("/api/outbox")]).then(([l, b]) => { setLog(l); setBox(b); });
  useEffect(() => { load().catch(() => setLog([])); }, []);
  if (!log) return <h1>Verlauf</h1>;

  const resolve = (id: number, to: "sent" | "queued") => api(`/api/outbox/${id}/resolve`, { to }).then(load).catch((e: Error) => setErr(e.message));

  return (
    <>
      <h1>Verlauf</h1>
      <p className="dim lead">Jeder Sendeversuch mit Screenshot.</p>
      {box.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Queue</h2>
          <div className="rows">
            {box.map((b) => (
              <div key={b.id}>
                <div className="row">
                  <div><div>{b.title}</div><small className="dim">{PORTAL_NAMES[b.portal] ?? b.portal} · seit {ago(b.queuedAt)}{b.lastError ? ` · ${b.lastError}` : ""}</small></div>
                  <span className={`badge ${b.status === "unknown" || b.status === "failed" ? "state-error" : ""}`}>{STATUS[b.status]}</span>
                </div>
                {b.status === "unknown" && (
                  <div className="actions">
                    <button className="ghost press" onClick={() => resolve(b.id, "sent")}>Wurde gesendet</button>
                    <button className="ghost press" onClick={() => resolve(b.id, "queued")}>Nicht gesendet, erneut einreihen</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {err && <p className="err" role="alert">{err}</p>}
        </div>
      )}
      <div className="card">
        {log.length === 0 ? <p className="dim" style={{ margin: 0 }}>Noch keine Sendeversuche.</p> : (
          <div className="rows">
            {log.map((e) => (
              <div key={e.id}>
                <div className="row">
                  <div><div>{e.title}</div><small className="dim">{PORTAL_NAMES[e.portal] ?? e.portal} · vor {ago(e.at)}{e.detail ? ` · ${e.detail}` : ""}</small></div>
                  <span className={`badge ${e.result === "failed" ? "state-error" : e.result === "ok" ? "state-ok" : ""}`}>{RESULT[e.result]}</span>
                </div>
                {e.shots.length > 0 && (
                  <div className="shots">
                    {e.shots.map((s) => <a key={s} href={`/api/screenshots/${s}`} target="_blank" rel="noreferrer"><img src={`/api/screenshots/${s}`} alt={`Screenshot ${s}`} loading="lazy" /></a>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
