import type Database from "better-sqlite3";
import { getKv, setKv } from "./outbox.js";

export type FredyDetails = { description: string | null; address: string | null; lat: number | null; lon: number | null };
export type FredySettings = { url: string; user: string; enabled: boolean; passwordSet: boolean };

const DEFAULT_URL = "http://fredy:9998";

export const getFredySettings = (db: Database.Database): FredySettings => ({
  url: getKv(db, "fredy_url") ?? DEFAULT_URL,
  user: getKv(db, "fredy_user") ?? "",
  enabled: getKv(db, "fredy_enrich") === "1",
  passwordSet: !!getKv(db, "fredy_pass"),
});

export function setFredySettings(db: Database.Database, s: { url?: string; user?: string; password?: string; enabled?: boolean }) {
  if (s.url !== undefined) setKv(db, "fredy_url", s.url.replace(/\/+$/, ""));
  if (s.user !== undefined) setKv(db, "fredy_user", s.user);
  if (s.password) setKv(db, "fredy_pass", s.password);
  if (s.enabled !== undefined) setKv(db, "fredy_enrich", s.enabled ? "1" : "0");
}

export type FredyPort = {
  /** true, wenn Zugang und Schalter eingerichtet sind */
  active(): boolean;
  test(): Promise<void>;
  /** Holt die Detailseite für genau dieses Inserat und liest sie aus. Wirft bei Fehlern. */
  details(fredyListingId: string): Promise<FredyDetails>;
};

/**
 * Spricht Fredys Oberfläche an: Anmelden, dann POST /api/listings/:id/details (holt die Detailseite jetzt, nur für dieses
 * Inserat) und GET /api/listings/:id (Beschreibung, Adresse, Koordinaten). Aufrufe laufen nacheinander mit Abstand,
 * weil Fredy dafür das Portal anfragt.
 */
export class FredyClient implements FredyPort {
  private cookie = "";
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(private db: Database.Database, private fetchImpl: typeof fetch = fetch, private gapMs = 3000) {}

  active() {
    const s = getFredySettings(this.db);
    return s.enabled && !!s.user && s.passwordSet;
  }

  private creds() {
    const s = getFredySettings(this.db);
    const pass = getKv(this.db, "fredy_pass");
    if (!s.user || !pass) throw new Error("Fredy-Zugang ist nicht eingerichtet");
    return { url: s.url, user: s.user, pass };
  }

  private async login() {
    const c = this.creds();
    const r = await this.fetchImpl(`${c.url}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: c.user, password: c.pass }), signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 401) throw new Error("Fredy: Benutzername oder Passwort falsch");
    if (!r.ok) throw new Error(`Fredy-Anmeldung antwortet mit ${r.status}`);
    this.cookie = (r.headers.getSetCookie?.() ?? []).map((x) => x.split(";")[0]).join("; ");
  }

  private async req(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const url = `${this.creds().url}${path}`;
    if (!this.cookie) await this.login();
    const r = await this.fetchImpl(url, { ...init, headers: { ...(init.headers as object), cookie: this.cookie, "content-type": "application/json" }, signal: AbortSignal.timeout(60_000) });
    if ((r.status === 401 || r.status === 403) && retry) {
      this.cookie = "";
      return this.req(path, init, false);
    }
    return r;
  }

  async test() {
    this.cookie = "";
    await this.login();
  }

  details(id: string): Promise<FredyDetails> {
    const run = async (): Promise<FredyDetails> => {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      const enc = encodeURIComponent(id);
      const f = await this.req(`/api/listings/${enc}/details`, { method: "POST", body: "{}" });
      if (f.status === 404) throw new Error("Fredy kennt dieses Inserat nicht");
      if (!f.ok) throw new Error(`Fredy-Detailabruf antwortet mit ${f.status}`);
      const g = await this.req(`/api/listings/${enc}`);
      if (!g.ok) throw new Error(`Fredy-Inserat antwortet mit ${g.status}`);
      const j = (await g.json()) as { description?: string | null; address?: string | null; latitude?: number | null; longitude?: number | null };
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v !== -1 ? v : null);
      return { description: j.description?.trim() || null, address: j.address?.trim() || null, lat: num(j.latitude), lon: num(j.longitude) };
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
}
