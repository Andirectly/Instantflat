import { useEffect, useState } from "react";
import { ago, api, fredyUrl, type AppSettings, type PortalsInfo, type PortalStatus } from "./api";

const LABEL: Record<PortalStatus["state"], string> = {
  ok: "Angemeldet", session_expired: "Abgemeldet", interaction_required: "Eingabe nötig", error: "Prüfung fehlgeschlagen", unknown: "Noch nicht geprüft",
};

type Version = { current: string; latest: string | null; updateAvailable: boolean; canUpdate: boolean };

export function Settings() {
  const [info, setInfo] = useState<PortalsInfo | null>(null);
  const [cfg, setCfg] = useState<AppSettings | null>(null);
  const [ingest, setIngest] = useState<{ endpoint: string; token: string } | null>(null);
  const [ver, setVer] = useState<Version | null>(null);
  const [upd, setUpd] = useState("");
  const [tgInfo, setTgInfo] = useState<{ configured: boolean; chatId: string | null; source: "app" | "env" | null } | null>(null);
  const tg = tgInfo === null ? null : tgInfo.configured;
  const [tgToken, setTgToken] = useState("");
  const [tgChat, setTgChat] = useState("");
  const [tgMsg, setTgMsg] = useState("");
  const [tgBusy, setTgBusy] = useState(false);
  const [fr, setFr] = useState<{ url: string; user: string; enabled: boolean; passwordSet: boolean } | null>(null);
  const [frPass, setFrPass] = useState("");
  const [frMsg, setFrMsg] = useState("");
  const [frBusy, setFrBusy] = useState(false);
  const [tgChats, setTgChats] = useState<{ id: string; name: string }[]>([]);
  const [test, setTest] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const load = () => api<PortalsInfo>("/api/portals").then(setInfo);
  useEffect(() => {
    load().catch(() => {});
    api<AppSettings>("/api/settings").then(setCfg).catch(() => {});
    api<{ endpoint: string; token: string }>("/api/ingest-info").then(setIngest).catch(() => {});
    api<Version>("/api/version?fresh=1").then(setVer).catch(() => {});
    api<NonNullable<typeof fr>>("/api/fredy").then(setFr).catch(() => {});
    api<NonNullable<typeof tgInfo>>("/api/telegram").then((r) => { setTgInfo(r); setTgChat(r.chatId ?? ""); }).catch(() => {});
  }, []);
  const copy = (key: string, text: string) => navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(""), 1500); }).catch(() => {});
  const setLimit = (n: number) => api<AppSettings>("/api/settings", { dailyLimit: n }, "PUT").then((r) => setCfg((c) => c && { ...c, dailyLimit: r.dailyLimit })).catch((e: Error) => setErr(e.message));
  if (!info) return <h1>Einstellungen</h1>;

  async function check(id: string) {
    setBusy(id); setErr("");
    try { await api(`/api/portals/${id}/check`, {}); await load(); } catch (e) { setErr((e as Error).message); }
    setBusy("");
  }

  async function saveFredy(test: boolean) {
    if (!fr) return;
    setFrBusy(true);
    setFrMsg("");
    try {
      const saved = await api<NonNullable<typeof fr>>("/api/fredy", { url: fr.url, user: fr.user, password: frPass || undefined, enabled: fr.enabled }, "PUT");
      setFr(saved);
      setFrPass("");
      if (test) { await api("/api/fredy/test", {}); setFrMsg("Verbunden. Fredy hat den Zugang akzeptiert."); } else setFrMsg("Gespeichert.");
    } catch (e) { setFrMsg((e as Error).message); }
    setFrBusy(false);
  }

  async function saveTelegram() {
    setTgBusy(true);
    setTgMsg("");
    try {
      const r = await api<{ bot: string }>("/api/telegram", { token: tgToken || undefined, chatId: tgChat }, "PUT");
      setTgMsg(`Verbunden mit ${r.bot}. Der Bot läuft jetzt. Probiere unten die Testnachricht.`);
      setTgToken("");
      setTgInfo(await api("/api/telegram"));
    } catch (e) { setTgMsg((e as Error).message); }
    setTgBusy(false);
  }

  async function findChat() {
    setTgBusy(true);
    setTgMsg("");
    setTgChats([]);
    try {
      const r = await api<{ chats: { id: string; name: string }[] }>("/api/telegram/find-chat", { token: tgToken || undefined });
      setTgChats(r.chats);
      setTgMsg(r.chats.length ? "Tippe auf deinen Namen, um die Chat-ID zu übernehmen." : "Noch keine Nachricht gefunden. Schreibe deinem Bot in Telegram eine Nachricht (zum Beispiel „Hallo“) und versuche es nochmal.");
    } catch (e) { setTgMsg((e as Error).message); }
    setTgBusy(false);
  }

  async function runTest(kind: "telegram" | "listing") {
    setTestBusy(true);
    setTest("");
    try {
      if (kind === "telegram") {
        await api("/api/test/telegram", {});
        setTest("Testnachricht gesendet. Sie sollte jetzt in Telegram ankommen.");
      } else {
        const r = await api<{ state: string; draft: boolean; telegram: boolean; activeProfile: boolean }>("/api/test/listing", {});
        setTest(!r.activeProfile
          ? "Das Test-Inserat ist da, aber ohne aktives Profil gibt es keinen Entwurf. Lege unter Profil deine Angaben an."
          : `Test-Inserat angelegt${r.draft ? ", Entwurf erstellt" : ""}${r.telegram ? " und an Telegram geschickt (Karte mit Senden/Verwerfen/Bearbeiten)." : tg ? "." : ". Telegram ist nicht eingerichtet, du siehst es unter Freigaben."} Du kannst es dort verwerfen.`);
      }
    } catch (e) { setTest((e as Error).message); }
    setTestBusy(false);
  }

  async function update() {
    if (!confirm("Instantflat jetzt aktualisieren? Die App ist dabei etwa eine Minute nicht erreichbar. Deine Daten bleiben erhalten.")) return;
    setUpd("Aktualisiere … die Seite lädt gleich neu.");
    try { await api("/api/update", {}); } catch (e) { return setUpd((e as Error).message); }
    // Warten, bis die App kurz weg und wieder da ist, dann neu laden.
    let down = false;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const ok = await fetch("/api/health").then((r) => r.ok).catch(() => false);
      if (!ok) down = true; else if (down) return location.reload();
    }
    setUpd("Das hat länger gedauert als erwartet. Lade die Seite später neu.");
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
          <p className="dim" style={{ marginBottom: 0 }}>{cfg.dryRun ? "Dry-Run ist aktiv (DRY_RUN=true): Formulare werden ausgefüllt, aber nie abgeschickt." : "Dry-Run ist aus: Nachrichten werden wirklich gesendet."}</p>
        </div>
      )}
      {ingest && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Fredy anbinden</h2>
          <p className="dim">In Fredy bei jedem Job die Benachrichtigung <strong>HTTP</strong> anlegen und diese zwei Werte eintragen.</p>
          <div className="rows">
            {([["Endpoint URL", ingest.endpoint], ["Auth token", ingest.token]] as const).map(([label, value]) => (
              <div className="row" key={label}>
                <div style={{ minWidth: 0 }}><small className="dim">{label}</small><div className="mono">{value}</div></div>
                <button className="ghost press" onClick={() => copy(label, value)}>{copied === label ? "Kopiert" : "Kopieren"}</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Telegram</h2>
        <p className="dim">
          {tg === null ? "…" : tg ? <>Eingerichtet ({tgInfo?.source === "app" ? "in der App gespeichert" : "aus der Server-Konfiguration"}), Chat-ID {tgInfo?.chatId}.</> : "Noch nicht eingerichtet."}
          {" "}Den Token bekommst du von <strong>@BotFather</strong> in Telegram (<code>/newbot</code>). Er wird nur auf deinem Server gespeichert und nie wieder angezeigt.
        </p>
        <form className="form" onSubmit={(e) => { e.preventDefault(); saveTelegram(); }}>
          <label>Bot-Token
            <input type="password" autoComplete="off" value={tgToken} onChange={(e) => setTgToken(e.target.value)} placeholder={tg ? "gespeichert (leer lassen, um ihn zu behalten)" : "123456789:AA…"} />
          </label>
          <label>Chat-ID
            <input inputMode="numeric" value={tgChat} onChange={(e) => setTgChat(e.target.value)} placeholder="z. B. 8308947321" />
          </label>
          {tgChats.length > 0 && (
            <div className="chips" role="group" aria-label="Gefundene Chats">
              {tgChats.map((c) => <button type="button" key={c.id} className="ghost press chip" onClick={() => { setTgChat(c.id); setTgMsg("Chat-ID übernommen. Jetzt speichern."); }}>{c.name} ({c.id})</button>)}
            </div>
          )}
          <div className="actions">
            <button type="button" className="ghost press" disabled={tgBusy || (!tgToken && !tg)} onClick={findChat}>Chat-ID finden</button>
            <button className="cta press" disabled={tgBusy || !tgChat || (!tgToken && !tg)}>{tgBusy ? "Prüft …" : "Speichern"}</button>
          </div>
        </form>
        {tgMsg && <p role="status" className="dim" style={{ marginBottom: 0 }}>{tgMsg}</p>}
      </div>
      {fr && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Fredy-Details</h2>
          <p style={{ marginTop: 0 }}><a href={fredyUrl()} target="_blank" rel="noreferrer">Fredy-Oberfläche öffnen ↗</a></p>
          <p className="dim">
            Für Inserate, die deinen ersten Filter bestehen, lässt Instantflat Fredy die <strong>Detailseite</strong> laden (nur dieses eine Inserat, kein Massenabruf).
            Danach gibt es Beschreibung, genaue Adresse und, falls genannt, den Ansprechpartner für die Anrede. Mit den neuen Daten wird noch einmal gefiltert (zum Beispiel Ausschlusswörter im Text).
            Dafür braucht Instantflat den Login deines Fredy.
          </p>
          <form className="form" onSubmit={(e) => { e.preventDefault(); saveFredy(true); }}>
            <label>Fredy-Adresse<input value={fr.url} onChange={(e) => setFr({ ...fr, url: e.target.value })} placeholder="http://fredy:9998" /></label>
            <label>Benutzername<input value={fr.user} onChange={(e) => setFr({ ...fr, user: e.target.value })} autoComplete="off" /></label>
            <label>Passwort<input type="password" value={frPass} onChange={(e) => setFrPass(e.target.value)} autoComplete="off" placeholder={fr.passwordSet ? "gespeichert (leer lassen, um es zu behalten)" : ""} /></label>
            <label className="check"><input type="checkbox" checked={fr.enabled} onChange={(e) => setFr({ ...fr, enabled: e.target.checked })} />Details für passende Inserate automatisch laden</label>
            <div className="actions">
              <button type="button" className="ghost press" disabled={frBusy} onClick={() => saveFredy(false)}>Speichern</button>
              <button className="cta press" disabled={frBusy || !fr.user || (!fr.passwordSet && !frPass)}>{frBusy ? "Prüft …" : "Speichern und testen"}</button>
            </div>
          </form>
          {frMsg && <p role="status" className="dim" style={{ marginBottom: 0 }}>{frMsg}</p>}
        </div>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Testlauf</h2>
        <p className="dim">Telegram: <strong>{tg === null ? "…" : tg ? "eingerichtet" : "nicht eingerichtet"}</strong>. Der Testlauf schickt nichts an ein Portal.</p>
        <div className="actions">
          <button className="ghost press" disabled={testBusy || tg === false} onClick={() => runTest("telegram")}>Telegram-Testnachricht</button>
          <button className="ghost press" disabled={testBusy} onClick={() => runTest("listing")}>Test-Inserat durchspielen</button>
        </div>
        {test && <p role="status" className="dim" style={{ marginBottom: 0 }}>{test}</p>}
      </div>
      {ver && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Version</h2>
          <p className="dim">Installiert: <span className="mono">{ver.current}</span>{ver.latest && <> · Neueste: <span className="mono">{ver.latest}</span></>}</p>
          {ver.updateAvailable ? <p>Es gibt eine neuere Version.</p> : <p className="dim">{ver.latest ? "Du hast die neueste Version." : "Die neueste Version konnte nicht ermittelt werden."}</p>}
          {ver.canUpdate
            ? <button className="cta press slim" disabled={!ver.updateAvailable || !!upd} onClick={update}>Jetzt aktualisieren</button>
            : <p className="dim">Das automatische Update ist nicht eingerichtet (Watchtower fehlt in der Compose-Datei).</p>}
          {upd && <p role="status" className="dim">{upd}</p>}
        </div>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Über</h2>
        <p className="dim" style={{ margin: 0 }}>Inserate liefert <a href="https://github.com/orangecoding/fredy" target="_blank" rel="noreferrer">Fredy</a> von Christian Kellner (orangecoding), Lizenz Apache-2.0 mit Commons Clause.</p>
      </div>
    </>
  );
}
