import { useEffect, useState, type FormEvent } from "react";
import { api, type Filters } from "./api";

const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const RADII = [2, 5, 10, 20];

export function Searches() {
  const [f, setF] = useState<Filters | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ maxRent: "", minSize: "", minRooms: "", districts: "", excludeWords: "", centerAddress: "", radiusKm: "" });
  useEffect(() => {
    api<Filters>("/api/filters").then((x) => {
      setF(x);
      setForm({
        maxRent: x.maxRent?.toString() ?? "", minSize: x.minSize?.toString() ?? "", minRooms: x.minRooms?.toString() ?? "",
        districts: x.districts.join(", "), excludeWords: x.excludeWords.join(", "),
        centerAddress: x.center?.address ?? "", radiusKm: x.radiusKm?.toString() ?? "",
      });
    }).catch(() => {});
  }, []);
  if (!f) return <h1>Suchen</h1>;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg("");
    setBusy(true);
    try {
      const radiusKm = num(form.radiusKm);
      const saved = await api<Filters>("/api/filters", {
        maxRent: num(form.maxRent), minSize: num(form.minSize), minRooms: num(form.minRooms),
        districts: list(form.districts), excludeWords: list(form.excludeWords),
        centerAddress: radiusKm ? form.centerAddress.trim() || null : null, radiusKm,
      }, "PUT");
      setF(saved);
      setMsg("Gespeichert. Gilt für neue Inserate.");
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }

  return (
    <>
      <h1>Suchen</h1>
      <p className="dim lead">Filter für eingehende Inserate. Die Suchen selbst legst du in Fredy an.</p>
      <form className="card form" onSubmit={save}>
        <label>Max. Miete (€ warm)<input inputMode="decimal" value={form.maxRent} onChange={set("maxRent")} placeholder="z. B. 1300" /></label>
        <label>Min. Fläche (m²)<input inputMode="decimal" value={form.minSize} onChange={set("minSize")} placeholder="z. B. 50" /></label>
        <label>Min. Zimmer<input inputMode="decimal" value={form.minRooms} onChange={set("minRooms")} placeholder="z. B. 2" /></label>
        <label>Stadtteile (Komma getrennt)<input value={form.districts} onChange={set("districts")} placeholder="Ehrenfeld, Nippes" /></label>
        <label>Ausschlusswörter<input value={form.excludeWords} onChange={set("excludeWords")} placeholder="WG, Tausch, Zwischenmiete" /></label>

        <fieldset className="radius">
          <legend>Umkreis</legend>
          <label>Mittelpunkt (Adresse)<input value={form.centerAddress} onChange={set("centerAddress")} placeholder="z. B. Neumarkt, Köln" autoComplete="street-address" /></label>
          <label><span>Radius: <strong>{form.radiusKm ? `${form.radiusKm} km` : "aus"}</strong></span>
            <input type="range" min={0} max={30} step={1} value={form.radiusKm || 0} onChange={(e) => setForm({ ...form, radiusKm: e.target.value === "0" ? "" : e.target.value })} aria-label="Radius in Kilometern" />
          </label>
          <div className="chips" role="group" aria-label="Radius-Vorschläge">
            {RADII.map((r) => <button type="button" key={r} className="ghost press chip" aria-pressed={form.radiusKm === String(r)} onClick={() => setForm({ ...form, radiusKm: String(r) })}>{r} km</button>)}
            <button type="button" className="ghost press chip" aria-pressed={!form.radiusKm} onClick={() => setForm({ ...form, radiusKm: "" })}>Aus</button>
          </div>
          {f.center && f.radiusKm && <p className="dim" style={{ margin: 0 }}>Aktiv: {f.radiusKm} km um <em>{f.center.label}</em>. Inserate außerhalb werden verworfen, bei unklarem Ort wird nicht automatisch gesendet.</p>}
        </fieldset>

        <p className="dim" style={{ margin: 0 }}>Leere Felder = kein Filter. Unbekannte Werte im Inserat werden nie aussortiert (Ausnahme Umkreis: unklarer Ort wird nur nicht automatisch gesendet).</p>
        <button className="cta press" disabled={busy}>{busy ? "Speichert …" : "Speichern"}</button>
        {msg && <p role="status" className="dim" style={{ margin: 0 }}>{msg}</p>}
      </form>
    </>
  );
}
