import { useCallback, useEffect, useState } from "react";
import { ago, api, PORTAL_NAMES, type Draft, type Listing } from "./api";

const GEO = {
  ok: (d: number | null) => `${d?.toString().replace(".", ",")} km vom Mittelpunkt`,
  approx: (d: number | null) => `ca. ${d?.toString().replace(".", ",")} km (Ort ungefähr)`,
  unknown: () => "Ort unklar, wird nicht automatisch gesendet",
};

export function Review() {
  const [items, setItems] = useState<Listing[] | null>(null);
  const [i, setI] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(() => api<{ items: Listing[] }>("/api/listings?state=gefiltert,entwurf&limit=100").then((r) => setItems(r.items.reverse())), []);
  useEffect(() => { load().catch(() => setItems([])); }, [load]);

  const idx = items ? Math.min(i, items.length - 1) : 0;
  const l = items?.[idx];
  const lid = l?.id;
  useEffect(() => {
    setErr("");
    setDraft(null);
    setText("");
    if (lid === undefined) return;
    api<Draft | null>(`/api/listings/${lid}/draft`).then((d) => { setDraft(d); setText(d?.body ?? ""); }).catch(() => {});
  }, [lid]);

  if (!items) return <h1>Freigaben</h1>;
  if (!l) return <><h1>Freigaben</h1><div className="card"><p className="dim" style={{ margin: 0 }}>Nichts zu prüfen.</p></div></>;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setErr("");
    try { await fn(); } catch (e) { setErr((e as Error).message); }
    setBusy("");
  }
  const generate = () => run("Entwurf wird erstellt …", async () => {
    const d = await api<Draft>(`/api/listings/${l.id}/draft`, {});
    setDraft(d); setText(d.body); await load();
  });
  const enrich = () => run("Details werden geladen …", async () => { const r = await api<{ result: string }>(`/api/listings/${l.id}/enrich`, {}); if (r.result === "failed") throw new Error("Fredy konnte die Details nicht laden."); await load(); });
  const discard = () => run("", async () => { await api(`/api/listings/${l.id}/state`, { to: "verworfen" }); await load(); });
  const send = () => run("", async () => {
    if (draft && text.trim() !== draft.body) await api(`/api/listings/${l.id}/draft`, { body: text }, "PUT");
    await api(`/api/listings/${l.id}/approve`, {});
    await load();
  });

  return (
    <>
      <h1>Freigaben</h1>
      <p className="dim lead">{idx + 1} von {items.length} · {PORTAL_NAMES[l.portal] ?? l.portal} · vor {ago(l.foundAt)} gefunden</p>
      <div className="review">
        <section className="card">
          {l.imageUrl && <img className="photo" src={l.imageUrl} alt="" />}
          <h2>{l.title}</h2>
          <p className="dim">{l.address}</p>
          <p className="price">{l.price ?? "Preis k. A."}</p>
          <dl className="facts">
            <dt>Fläche</dt><dd>{l.size ?? "–"}</dd>
            <dt>Zimmer</dt><dd>{l.rooms ?? "–"}</dd>
            {l.contactName && <><dt>Ansprechpartner</dt><dd>{l.contactKind === "company" ? l.contactName : [l.contactSalutation, l.contactName].filter(Boolean).join(" ")}</dd></>}
            {l.geo && <><dt>Umkreis</dt><dd>{GEO[l.geo](l.distKm)}</dd></>}
          </dl>
          {l.description && <p className="dim clamp">{l.description}</p>}
          {l.url && <a href={l.url} target="_blank" rel="noreferrer">Original auf {PORTAL_NAMES[l.portal] ?? l.portal}</a>}
        </section>
        <section className="card">
          <h2>Nachricht</h2>
          {draft ? (
            <>
              <textarea className="editor" aria-label="Nachricht an den Vermieter" value={text} onChange={(e) => setText(e.target.value)} />
              <p className="meta dim"><span>{text.length} Zeichen</span><span>Version {draft.version} · {draft.provider}</span></p>
            </>
          ) : (
            <p className="dim">Noch kein Entwurf. Lege zuerst unter „Profil“ deine Angaben an.</p>
          )}
          {busy && <p className="dim" role="status">{busy}</p>}
          {err && <p className="err" role="alert">{err}</p>}
          {l.enriched !== "ok" && <div className="actions"><button className="ghost press" disabled={!!busy} onClick={enrich}>Details von Fredy laden</button></div>}
          <div className="actions">
            <button className="ghost press" disabled={!!busy} onClick={generate}>{draft ? "Neu formulieren" : "Entwurf erstellen"}</button>
            <button className="ghost press" disabled={!!busy} onClick={discard}>Verwerfen</button>
          </div>
          <div className="actions">
            <button className="cta press" disabled={!!busy || !draft || !text.trim()} onClick={send}>Senden</button>
          </div>
          <div className="actions">
            <button className="ghost press" disabled={idx === 0} onClick={() => setI(idx - 1)}>‹ Zurück</button>
            <button className="ghost press" disabled={idx >= items.length - 1} onClick={() => setI(idx + 1)}>Weiter ›</button>
          </div>
        </section>
      </div>
    </>
  );
}
