import type Database from "better-sqlite3";
import type { WithPage } from "./cdp.js";
import { detectState } from "./detect.js";
import type { PortalDef, PortalState } from "./types.js";

export type PortalStatus = { portal: string; name: string; state: PortalState | "unknown"; detail: string | null; checkedAt: string | null; since: string | null };

const MIN = 60_000;
const ERROR_STREAK = 2; // ein einzelner Verbindungsfehler ist noch kein Zustandswechsel

export class SessionMonitor {
  private timers = new Map<string, NodeJS.Timeout>();
  private errorStreak = new Map<string, number>();
  private stopped = false;

  constructor(
    private db: Database.Database,
    private defs: PortalDef[],
    private withPage: WithPage,
    private notify: (text: string) => Promise<void>,
    private loginUrl: string,
    private rand: () => number = Math.random,
  ) {}

  status(): PortalStatus[] {
    return this.defs.map((d) => {
      const r = this.db.prepare("SELECT state, detail, checked_at AS checkedAt, since FROM portal_sessions WHERE portal = ?").get(d.id) as Omit<PortalStatus, "portal" | "name"> | undefined;
      return { portal: d.id, name: d.name, state: r?.state ?? "unknown", detail: r?.detail ?? null, checkedAt: r?.checkedAt ?? null, since: r?.since ?? null };
    });
  }

  async check(id: string): Promise<PortalStatus> {
    const def = this.defs.find((d) => d.id === id);
    if (!def) throw new Error("Unbekanntes Portal");
    let res: { state: PortalState; detail?: string };
    try {
      res = await this.withPage(def.url, (page) => detectState(page, def.selectors));
    } catch (e) {
      res = { state: "error", detail: (e as Error).message.split("\n")[0] };
    }
    await this.record(def, res);
    return this.status().find((s) => s.portal === id)!;
  }

  private async record(def: PortalDef, res: { state: PortalState; detail?: string }) {
    const prev = this.db.prepare("SELECT state FROM portal_sessions WHERE portal = ?").get(def.id) as { state: PortalState } | undefined;
    const streak = res.state === "error" ? (this.errorStreak.get(def.id) ?? 0) + 1 : 0;
    this.errorStreak.set(def.id, streak);
    // Kurze Fehler (z. B. Browser startet neu) behalten den alten Zustand, nur der Zeitstempel wandert.
    const state = res.state === "error" && prev && prev.state !== "error" && streak < ERROR_STREAK ? prev.state : res.state;
    const changed = prev?.state !== state;
    this.db.prepare(
      `INSERT INTO portal_sessions (portal, state, detail, checked_at, since) VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(portal) DO UPDATE SET state = excluded.state, detail = excluded.detail, checked_at = datetime('now'),
         since = CASE WHEN portal_sessions.state = excluded.state THEN portal_sessions.since ELSE datetime('now') END`,
    ).run(def.id, state, res.detail ?? null);
    if (!changed) return;
    this.db.prepare("INSERT INTO session_events (portal, from_state, to_state) VALUES (?, ?, ?)").run(def.id, prev?.state ?? null, state);
    // Erste Messung mit "ok" ist keine Nachricht wert.
    const msg = this.message(def, prev?.state, state, res.detail);
    if (msg) await this.notify(msg).catch(() => {});
  }

  private message(def: PortalDef, from: PortalState | undefined, to: PortalState, detail?: string): string | null {
    if (to === "ok") return from ? `✅ ${def.name}: wieder angemeldet.` : null;
    if (to === "session_expired") return `⚠️ ${def.name}: Session abgelaufen. Bitte neu anmelden: ${this.loginUrl}`;
    if (to === "interaction_required") return `⚠️ ${def.name} verlangt eine Eingabe (Captcha oder Code). Bitte im Browser lösen: ${this.loginUrl}`;
    return `❌ ${def.name}: Prüfung fehlgeschlagen${detail ? ` (${detail})` : ""}.`;
  }

  /** Kalibrierhilfe: zählt, wie oft jeder konfigurierte Selektor auf der aktuellen Seite vorkommt (nur lesend). */
  async probe(id: string, url?: string, extra: Record<string, string> = {}): Promise<{ url: string; title: string; counts: Record<string, number> }> {
    const def = this.defs.find((d) => d.id === id);
    if (!def) throw new Error("Unbekanntes Portal");
    const sels = { ...(def.selectors ?? {}), ...(def.send ?? {}), ...extra } as Record<string, string>;
    return this.withPage(url ?? def.url, async (page) => (await page.waitForLoadState?.("networkidle", { timeout: 8000 }).catch(() => {}), {
      url: page.url(),
      title: await page.title(),
      counts: Object.fromEntries(await Promise.all(Object.entries(sels).map(async ([k, s]) => [k, await page.locator(s).count()] as const))),
    }));
  }

  /** Alle 30-60 Min pro Portal, versetzt gestartet. */
  start() {
    for (const d of this.defs) this.schedule(d.id, (1 + this.rand() * 4) * MIN);
  }

  private schedule(id: string, delay: number) {
    if (this.stopped) return;
    const t = setTimeout(async () => {
      await this.check(id).catch(() => {});
      this.schedule(id, (30 + this.rand() * 30) * MIN);
    }, delay);
    t.unref();
    this.timers.set(id, t);
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
  }
}
