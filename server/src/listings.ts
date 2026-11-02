import type Database from "better-sqlite3";
import { filtersSchema, NO_FILTERS, type Filters } from "./filter.js";
import { cachedGeocode, haversineKm, type Geocoder } from "./geo.js";

export const STATES = ["gefunden", "gefiltert", "verworfen", "entwurf", "freigegeben", "gesendet", "antwort"] as const;
export type State = (typeof STATES)[number];

const NEXT: Record<State, State[]> = {
  gefunden: ["gefiltert", "verworfen"],
  gefiltert: ["verworfen", "entwurf"],
  verworfen: ["gefiltert"],
  entwurf: ["freigegeben", "verworfen"],
  freigegeben: ["gesendet", "entwurf"],
  gesendet: ["antwort"],
  antwort: [],
};

export class TransitionError extends Error {}

export function transition(db: Database.Database, id: number, to: State, reason: string | null = null): void {
  db.transaction(() => {
    const row = db.prepare("SELECT state FROM listings WHERE id = ?").get(id) as { state: State } | undefined;
    if (!row) throw new TransitionError("Inserat nicht gefunden");
    if (!NEXT[row.state].includes(to)) throw new TransitionError(`${row.state} → ${to} nicht erlaubt`);
    db.prepare("UPDATE listings SET state = ?, filter_reason = ? WHERE id = ?").run(to, to === "verworfen" ? reason : null, id);
    db.prepare("INSERT INTO listing_events (listing_id, from_state, to_state, reason) VALUES (?, ?, ?, ?)").run(id, row.state, to, reason);
  })();
}

export function getFilters(db: Database.Database): Filters {
  const r = db.prepare("SELECT data FROM filters WHERE id = 1").get() as { data: string } | undefined;
  return r ? filtersSchema.parse(JSON.parse(r.data)) : NO_FILTERS;
}

export function setFilters(db: Database.Database, f: Filters): void {
  db.prepare("INSERT INTO filters (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(f));
}

export function overview(db: Database.Database) {
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const today = "date(found_at,'localtime') = date('now','localtime')";
  return {
    today: count(`SELECT count(*) c FROM listings WHERE ${today}`),
    waiting: count("SELECT count(*) c FROM listings WHERE state IN ('gefiltert','entwurf')"),
    filtered: count("SELECT count(*) c FROM listings WHERE state = 'verworfen'"),
    total: count("SELECT count(*) c FROM listings"),
    portals: db.prepare("SELECT portal, count(*) AS count FROM listings GROUP BY portal ORDER BY count DESC").all(),
  };
}

const COLS = `id, portal, title, address, price, size, rent, size_m2 AS sizeM2, rooms, url, image_url AS imageUrl,
  description, state, filter_reason AS filterReason, found_at AS foundAt, dist_km AS distKm, geo`;

export function listListings(db: Database.Database, opts: { states?: State[]; limit?: number; offset?: number }) {
  const states = opts.states?.length ? opts.states : [...STATES];
  const where = `state IN (${states.map(() => "?").join(",")})`;
  const rows = db.prepare(`SELECT ${COLS} FROM listings WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...states, opts.limit ?? 50, opts.offset ?? 0);
  const total = (db.prepare(`SELECT count(*) c FROM listings WHERE ${where}`).get(...states) as { c: number }).c;
  return { items: rows, total };
}

export type GeoOutcome = "skip" | "ok" | "unknown" | "dropped";

/**
 * Radius-Prüfung für ein neues Inserat. Außerhalb → verworfen. Ort nicht bestimmbar → bleibt liegen,
 * ist aber nicht automatisch sendbar (geo = "unknown"). Netzwerkfehler des Geocoders werfen, das Inserat bleibt unverändert.
 */
export async function geoCheck(db: Database.Database, geocoder: Geocoder, listingId: number): Promise<GeoOutcome> {
  const flt = getFilters(db);
  if (!flt.center || !flt.radiusKm) return "skip";
  const l = db.prepare("SELECT address, state FROM listings WHERE id = ?").get(listingId) as { address: string | null; state: string } | undefined;
  if (!l || l.state !== "gefiltert") return "skip";
  const res = l.address ? await cachedGeocode(db, geocoder, l.address) : null;
  if (!res || res.precision === "unknown") {
    db.prepare("UPDATE listings SET geo = 'unknown' WHERE id = ?").run(listingId);
    return "unknown";
  }
  const d = haversineKm(flt.center, res);
  db.prepare("UPDATE listings SET lat = ?, lon = ?, dist_km = ?, geo = ? WHERE id = ?").run(res.lat, res.lon, Math.round(d * 10) / 10, res.precision, listingId);
  if (d > flt.radiusKm) {
    transition(db, listingId, "verworfen", `${d.toFixed(1).replace(".", ",")} km > ${flt.radiusKm} km${res.precision === "approx" ? " (Ort ungefähr)" : ""}`);
    return "dropped";
  }
  return "ok";
}

/** Automatisch senden nur, wenn kein Radius gilt oder der Ort bekannt ist. */
export function autoSendable(db: Database.Database, listingId: number): boolean {
  const flt = getFilters(db);
  if (!flt.center || !flt.radiusKm) return true;
  const r = db.prepare("SELECT geo FROM listings WHERE id = ?").get(listingId) as { geo: string | null } | undefined;
  return r?.geo === "ok" || r?.geo === "approx";
}
