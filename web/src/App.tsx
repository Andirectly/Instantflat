import { useEffect, useState, type FormEvent } from "react";
import { api, fredyUrl } from "./api";
import { Overview } from "./Overview";
import { Review } from "./Review";
import { Searches } from "./Searches";
import { Profiles } from "./Profiles";
import { Settings } from "./Settings";
import { History } from "./History";

type Status = { setup: boolean; authed: boolean };

const Brand = () => (
  <div className="brand">
    <img src="/logo.png" alt="" />
    <span>Instantflat</span>
  </div>
);

function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api(setup ? "/api/auth/setup" : "/api/auth/login", { password: pw });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <Brand />
        <p className="dim" style={{ margin: 0 }}>{setup ? "Lege dein Passwort fest (mind. 10 Zeichen)." : "Willkommen zurück."}</p>
        <input type="password" autoFocus autoComplete={setup ? "new-password" : "current-password"} aria-label="Passwort" placeholder="Passwort" value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <p className="err" role="alert">{err}</p>}
        <button className="cta press" disabled={busy || !pw}>{setup ? "Einrichten" : "Anmelden"}</button>
      </form>
    </main>
  );
}

const PAGES = [
  { id: "uebersicht", label: "Übersicht" },
  { id: "freigaben", label: "Freigaben" },
  { id: "verlauf", label: "Verlauf" },
  { id: "suchen", label: "Suchen" },
  { id: "profil", label: "Profil" },
  { id: "einstellungen", label: "Einstellungen" },
] as const;

function usePage() {
  const read = () => (PAGES.find((p) => p.id === location.hash.slice(1)) ?? PAGES[0]).id;
  const [page, setPage] = useState<string>(read);
  useEffect(() => {
    const h = () => setPage(read());
    addEventListener("hashchange", h);
    return () => removeEventListener("hashchange", h);
  }, []);
  return [page, (p: string) => { location.hash = p; }] as const;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [page, go] = usePage();
  return (
    <div className="shell">
      <aside className="side">
        <Brand />
        <nav className="navs" aria-label="Hauptmenü">
          {PAGES.map((p) => (
            <a key={p.id} className="nav press" href={`#${p.id}`} aria-current={page === p.id ? "page" : undefined}>{p.label}</a>
          ))}
          {/* Fredys Oberfläche liegt auf demselben Server (Port 9998), die Adresse folgt der, mit der du Instantflat gerade öffnest (Heimnetz oder Tailscale). */}
          <a className="nav press" href={fredyUrl()} target="_blank" rel="noreferrer">Fredy öffnen ↗</a>
        </nav>
        <div className="spacer" />
        <button className="nav press" onClick={() => api("/api/auth/logout", {}).then(onLogout)}>Abmelden</button>
      </aside>
      <section className="main">
        {page === "uebersicht" && <Overview go={go} />}
        {page === "freigaben" && <Review />}
        {page === "verlauf" && <History />}
        {page === "suchen" && <Searches />}
        {page === "profil" && <Profiles />}
        {page === "einstellungen" && <Settings />}
      </section>
    </div>
  );
}

export function App() {
  const [s, setS] = useState<Status | null>(null);
  const load = () => api<Status>("/api/auth/status").then(setS).catch(() => setS({ setup: false, authed: false }));
  useEffect(() => { load(); }, []);
  if (!s) return null;
  return s.authed ? <Shell onLogout={load} /> : <Login setup={s.setup} onDone={load} />;
}
