import type Database from "better-sqlite3";

export type Mode = "manual" | "auto";
export const NIGHT_FROM = 22, NIGHT_TO = 7; // Europe/Berlin, Nachtruhe 22-7 Uhr
export const DEFAULT_DAILY_LIMIT = 7; // pro Plattform

export const getKv = (db: Database.Database, k: string) => (db.prepare("SELECT value FROM kv WHERE key = ?").get(k) as { value: string } | undefined)?.value;
export const setKv = (db: Database.Database, k: string, v: string) => void db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);

export const getMode = (db: Database.Database): Mode => (getKv(db, "mode") === "auto" ? "auto" : "manual");
export const setMode = (db: Database.Database, m: Mode) => setKv(db, "mode", m);
export const getDailyLimit = (db: Database.Database) => Number(getKv(db, "daily_limit") ?? DEFAULT_DAILY_LIMIT);
export const setDailyLimit = (db: Database.Database, n: number) => setKv(db, "daily_limit", String(n));
export const getNextAt = (db: Database.Database, portal: string) => Number(getKv(db, `next:${portal}`) ?? 0);
export const setNextAt = (db: Database.Database, portal: string, ms: number) => setKv(db, `next:${portal}`, String(ms));

const berlin = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", ...o }).format(d);
export const berlinHour = (d: Date) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).formatToParts(d).find((p) => p.type === "hour")!.value);
export const berlinDay = (d: Date) => berlin(d, { year: "numeric", month: "2-digit", day: "2-digit" });
export const isNight = (d: Date) => { const h = berlinHour(d); return h >= NIGHT_FROM || h < NIGHT_TO; };

// Idempotent: ein Inserat landet höchstens einmal in der Outbox (UNIQUE listing_id).
export function enqueue(db: Database.Database, listingId: number): void {
  const l = db.prepare("SELECT portal FROM listings WHERE id = ?").get(listingId) as { portal: string } | undefined;
  const d = db.prepare("SELECT id FROM drafts WHERE listing_id = ? ORDER BY version DESC LIMIT 1").get(listingId) as { id: number } | undefined;
  if (!l || !d) return;
  db.prepare("INSERT OR IGNORE INTO outbox (listing_id, portal, draft_id) VALUES (?, ?, ?)").run(listingId, l.portal, d.id);
}

/** Versuche des heutigen Berliner Tages. Dry-Runs zählen getrennt, damit ein Probelauf das echte Limit nicht aufbraucht. */
export function sentToday(db: Database.Database, portal: string, dryRun: boolean, now: Date): number {
  const rows = db.prepare("SELECT at FROM send_log WHERE portal = ? AND dry_run = ? AND result IN ('ok','dry_run') AND at > datetime('now','-2 days')").all(portal, dryRun ? 1 : 0) as { at: string }[];
  const today = berlinDay(now);
  return rows.filter((r) => berlinDay(new Date(r.at.replace(" ", "T") + "Z")) === today).length;
}
