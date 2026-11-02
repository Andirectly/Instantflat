import type Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WithPage } from "./portals/cdp.js";
import type { SessionMonitor } from "./portals/monitor.js";
import { sendMessage, SendError, HUMAN_PACE, type Pace } from "./portals/sender.js";
import type { PortalDef } from "./portals/types.js";
import { getDailyLimit, getNextAt, isNight, sentToday, setNextAt } from "./outbox.js";
import { transition } from "./listings.js";

const MIN = 60_000;
const MAX_ATTEMPTS = 3;

type Row = { id: number; listing_id: number; portal: string; draft_id: number; status: string; attempts: number };

export type TickResult = "idle" | "night" | "blocked" | "sent" | "dry_run" | "failed" | "unknown" | "requeued";

export class Worker {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private db: Database.Database,
    private defs: PortalDef[],
    private monitor: Pick<SessionMonitor, "status"> & Partial<Pick<SessionMonitor, "report">>,
    private withPage: WithPage,
    private opts: { dryRun: boolean; shotDir: string; notify: (t: string) => Promise<void>; pace?: Pace; rand?: () => number },
  ) {}

  /** Nach einem Absturz mitten im Versand ist unklar, ob die Nachricht rausging: nie automatisch wiederholen. */
  recover(): number {
    const r = this.db.prepare("UPDATE outbox SET status = 'unknown', last_error = 'Unterbrochen während des Sendens' WHERE status = 'sending'").run();
    if (r.changes) void this.opts.notify(`❓ ${r.changes} Nachricht(en) mit unklarem Status nach Neustart. Bitte im Verlauf prüfen.`).catch(() => {});
    return r.changes;
  }

  start(everyMs = 10_000) {
    this.recover();
    this.timer = setInterval(() => void this.tick().catch(() => {}), everyMs);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }

  /** Höchstens ein Versand pro Aufruf. */
  async tick(now: Date = new Date()): Promise<TickResult> {
    if (this.busy) return "idle";
    if (isNight(now)) return "night";
    this.busy = true;
    try {
      const row = this.pick(now);
      return row ? await this.process(row, now) : "idle";
    } finally {
      this.busy = false;
    }
  }

  private pick(now: Date): Row | undefined {
    const statuses = this.opts.dryRun ? "('queued')" : "('queued','dry_done')"; // Probelauf-Einträge werden im echten Betrieb nachgeholt
    const rows = this.db.prepare(`SELECT id, listing_id, portal, draft_id, status, attempts FROM outbox WHERE status IN ${statuses} ORDER BY queued_at, id`).all() as Row[];
    const limit = getDailyLimit(this.db);
    const states = this.monitor.status();
    // Reihenfolge der Freigabe, aber ein blockiertes Portal hält die anderen nicht auf.
    return rows.find((r) => {
      const def = this.defs.find((d) => d.id === r.portal);
      return !!def?.send && states.find((s) => s.portal === r.portal)?.state === "ok"
        && now.getTime() >= getNextAt(this.db, r.portal) && sentToday(this.db, r.portal, this.opts.dryRun, now) < limit;
    });
  }

  private async process(row: Row, now: Date): Promise<TickResult> {
    const def = this.defs.find((d) => d.id === row.portal)!;
    const l = this.db.prepare("SELECT title, url FROM listings WHERE id = ?").get(row.listing_id) as { title: string; url: string | null };
    const body = (this.db.prepare("SELECT body FROM drafts WHERE id = ?").get(row.draft_id) as { body: string }).body;
    const rand = this.opts.rand ?? Math.random;
    const started = Date.now();
    // Vor dem Klick als "sending" markieren: stürzt der Prozess ab, wird daraus "unknown" statt eines Doppelversands.
    this.db.prepare("UPDATE outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ?").run(row.id);

    const log = (result: string, detail: string | null) =>
      Number(this.db.prepare("INSERT INTO send_log (outbox_id, listing_id, portal, dry_run, result, detail, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.listing_id, row.portal, this.opts.dryRun ? 1 : 0, result, detail, Date.now() - started).lastInsertRowid);
    const pause = () => setNextAt(this.db, row.portal, now.getTime() + (2 + rand() * 6) * MIN); // 2-8 Min

    try {
      if (!l.url) throw new SendError("Inserat ohne URL", "before");
      const res = await this.withPage(l.url, (page) => sendMessage(page, def, body, { dryRun: this.opts.dryRun, pace: this.opts.pace ?? HUMAN_PACE, rand }));
      const logId = log(res.result === "sent" ? "ok" : "dry_run", null);
      mkdirSync(this.opts.shotDir, { recursive: true });
      const names = res.shots.map((b, i) => { const n = `${logId}-${i + 1}.png`; writeFileSync(join(this.opts.shotDir, n), b); return n; });
      this.db.prepare("UPDATE send_log SET shots = ? WHERE id = ?").run(JSON.stringify(names), logId);
      pause();
      if (res.result === "sent") {
        this.db.prepare("UPDATE outbox SET status = 'sent', sent_at = datetime('now'), last_error = NULL WHERE id = ?").run(row.id);
        transition(this.db, row.listing_id, "gesendet", "Gesendet");
        await this.opts.notify(`✅ Gesendet (${def.name}): ${l.title}`).catch(() => {});
        return "sent";
      }
      this.db.prepare("UPDATE outbox SET status = 'dry_done', last_error = NULL WHERE id = ?").run(row.id);
      await this.opts.notify(`🧪 Dry-Run (${def.name}): ${l.title} – ausgefüllt, nicht gesendet.`).catch(() => {});
      return "dry_run";
    } catch (e) {
      const err = e as Error, phase = e instanceof SendError ? e.phase : "before";
      // Captcha oder Abmeldung beim Senden: kein Fehlversuch. Die Nachricht bleibt in der Queue, das Portal wird angehalten und du wirst benachrichtigt.
      if (e instanceof SendError && e.reason) {
        this.db.prepare("UPDATE outbox SET status = 'queued', attempts = attempts - 1, last_error = ? WHERE id = ?").run(err.message, row.id);
        log("blocked", err.message);
        try { await this.monitor.report?.(row.portal, e.reason, l.url ?? undefined); } catch { /* Meldung darf den Worker nicht stoppen */ }
        return "blocked";
      }
      log("failed", err.message);
      pause();
      if (phase === "after") {
        this.db.prepare("UPDATE outbox SET status = 'unknown', last_error = ? WHERE id = ?").run(err.message, row.id);
        await this.opts.notify(`❓ ${def.name}: unklar, ob gesendet wurde (${l.title}). Bitte im Verlauf prüfen.`).catch(() => {});
        return "unknown";
      }
      const retry = (e instanceof SendError ? e.retry : true) && row.attempts + 1 < MAX_ATTEMPTS;
      this.db.prepare("UPDATE outbox SET status = ?, last_error = ? WHERE id = ?").run(retry ? "queued" : "failed", err.message, row.id);
      if (!retry) await this.opts.notify(`❌ ${def.name}: Senden fehlgeschlagen (${l.title}): ${err.message}`).catch(() => {});
      return retry ? "requeued" : "failed";
    }
  }
}
