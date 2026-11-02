import type Database from "better-sqlite3";

// ok = Straße/Hausnummer gefunden, approx = nur Stadtteil/PLZ, unknown = nur Stadt oder nichts
export type Precision = "ok" | "approx" | "unknown";
export type GeoResult = { lat: number; lon: number; precision: Precision; label: string };
export type Geocoder = (query: string) => Promise<GeoResult | null>;

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

type NominatimHit = { lat: string; lon: string; display_name: string; address?: Record<string, string> };

export function precisionOf(address: Record<string, string> = {}): Precision {
  if (address.road || address.house_number || address.pedestrian) return "ok";
  if (address.suburb || address.city_district || address.quarter || address.neighbourhood || address.borough || address.postcode) return "approx";
  return "unknown";
}

/**
 * OpenStreetMap Nominatim (öffentliche Instanz): höchstens 1 Anfrage pro Sekunde, mit User-Agent, nur Adresstexte öffentlicher Inserate.
 * shortcut: eine Instanz mit Warteschlange im Prozess, bei mehreren Instanzen oder hohem Volumen eine eigene Nominatim-Instanz nutzen (baseUrl).
 */
export function nominatimGeocoder(opts: { baseUrl?: string; fetchImpl?: typeof fetch; minGapMs?: number } = {}): Geocoder {
  const base = opts.baseUrl ?? "https://nominatim.openstreetmap.org";
  const f = opts.fetchImpl ?? fetch;
  const gap = opts.minGapMs ?? 1100;
  let chain: Promise<unknown> = Promise.resolve();
  let last = 0;
  return (query) => {
    const run = async () => {
      const wait = last + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const url = `${base}/search?format=json&limit=1&addressdetails=1&countrycodes=de&q=${encodeURIComponent(query)}`;
      const r = await f(url, { headers: { "user-agent": "Instantflat/1.0 (self-hosted, private use)", "accept-language": "de" }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`Geocoder antwortet mit ${r.status}`);
      const hit = ((await r.json()) as NominatimHit[])[0];
      return hit ? { lat: Number(hit.lat), lon: Number(hit.lon), precision: precisionOf(hit.address), label: hit.display_name.split(",").slice(0, 3).join(",").trim() } : null;
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
}

/** Ergebnisse (auch "nicht gefunden") werden gespeichert, damit dieselbe Adresse nie zweimal angefragt wird. Netzwerkfehler werden nicht gespeichert. */
export async function cachedGeocode(db: Database.Database, geocoder: Geocoder, query: string): Promise<GeoResult | null> {
  const q = query.trim().toLowerCase();
  const row = db.prepare("SELECT lat, lon, precision, label FROM geocache WHERE q = ?").get(q) as { lat: number | null; lon: number | null; precision: Precision; label: string | null } | undefined;
  if (row) return row.lat == null ? null : { lat: row.lat, lon: row.lon!, precision: row.precision, label: row.label ?? "" };
  const res = await geocoder(query);
  db.prepare("INSERT OR REPLACE INTO geocache (q, lat, lon, precision, label) VALUES (?, ?, ?, ?, ?)").run(q, res?.lat ?? null, res?.lon ?? null, res?.precision ?? "unknown", res?.label ?? null);
  return res;
}
