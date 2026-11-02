import { useEffect, useState, type FormEvent } from "react";
import { api, type Profile, type ProfileData } from "./api";

const EMPTY: ProfileData = { fullName: "", age: null, city: "", job: "", employment: "", household: "", pets: "", moveIn: "", viewingTimes: "", documentsReady: false, extra: "" };
const FIELDS: { key: keyof ProfileData; label: string; hint: string }[] = [
  { key: "fullName", label: "Name (so unterschreibst du)", hint: "Vor- und Nachname" },
  { key: "city", label: "Wohnort", hint: "z. B. Köln" },
  { key: "job", label: "Beruf", hint: "z. B. Videograf" },
  { key: "employment", label: "Anstellung", hint: "z. B. fest angestellt" },
  { key: "household", label: "Haushalt", hint: "z. B. 1 Person" },
  { key: "pets", label: "Haustiere", hint: "z. B. Keine Haustiere (leer = nicht erwähnen)" },
  { key: "moveIn", label: "Einzugstermin", hint: "z. B. zum 01.01." },
  { key: "viewingTimes", label: "Besichtigung möglich", hint: "z. B. abends und am Wochenende" },
  { key: "extra", label: "Weiteres (wird wörtlich übernommen)", hint: "Optional" },
];

export function Profiles() {
  const [list, setList] = useState<Profile[] | null>(null);
  const [sel, setSel] = useState<number | "new" | null>(null);
  const [name, setName] = useState("");
  const [d, setD] = useState<ProfileData>(EMPTY);
  const [msg, setMsg] = useState("");
  const load = () => api<Profile[]>("/api/profiles").then(setList);
  useEffect(() => { load().catch(() => setList([])); }, []);
  useEffect(() => {
    if (!list || sel !== null) return;
    const p = list.find((x) => x.active) ?? list[0];
    if (p) pick(p); else { setSel("new"); setName("Standard"); }
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(p: Profile) { setSel(p.id); setName(p.name); setD(p.data); setMsg(""); }
  if (!list) return <h1>Profil</h1>;

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg("");
    try {
      if (sel === "new") { const r = await api<{ id: number }>("/api/profiles", { name, data: d }); setSel(r.id); }
      else await api(`/api/profiles/${sel}`, { name, data: d }, "PUT");
      await load();
      setMsg("Gespeichert.");
    } catch (e) { setMsg((e as Error).message); }
  }
  const act = (fn: () => Promise<unknown>) => fn().then(load).catch((e: Error) => setMsg(e.message));
  const cur = list.find((p) => p.id === sel);

  return (
    <>
      <h1>Profil</h1>
      <p className="dim lead">Aus diesen Angaben entstehen deine Anfragen. Es wird nichts erwähnt, was hier nicht steht.</p>
      <div className="tabs" role="tablist">
        {list.map((p) => <button key={p.id} role="tab" aria-selected={sel === p.id} className="nav press" onClick={() => pick(p)}>{p.name}{p.active ? " ✓" : ""}</button>)}
        <button className="nav press" onClick={() => { setSel("new"); setName(""); setD(EMPTY); setMsg(""); }}>+ Neues Profil</button>
      </div>
      <form className="card form" onSubmit={save}>
        <label>Profilname<input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Allein" required /></label>
        {FIELDS.map((f) => (
          <label key={f.key}>{f.label}
            <input value={d[f.key] as string} placeholder={f.hint} required={f.key === "fullName"} onChange={(e) => setD({ ...d, [f.key]: e.target.value })} />
          </label>
        ))}
        <label>Alter<input inputMode="numeric" value={d.age ?? ""} onChange={(e) => setD({ ...d, age: e.target.value === "" ? null : Number(e.target.value) })} /></label>
        <label className="check"><input type="checkbox" checked={d.documentsReady} onChange={(e) => setD({ ...d, documentsReady: e.target.checked })} />Unterlagen liegen bereit (wird erwähnt)</label>
        <button className="cta press">Speichern</button>
        {cur && !cur.active && (
          <div className="actions">
            <button type="button" className="ghost press" onClick={() => act(() => api(`/api/profiles/${cur.id}/activate`, {}))}>Aktiv setzen</button>
            <button type="button" className="ghost press" onClick={() => act(() => api(`/api/profiles/${cur.id}`, undefined, "DELETE").then(() => setSel(null)))}>Löschen</button>
          </div>
        )}
        {msg && <p role="status" className="dim" style={{ margin: 0 }}>{msg}</p>}
      </form>
    </>
  );
}
