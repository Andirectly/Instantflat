import type Database from "better-sqlite3";
import { extractContact } from "./contact.js";
import { evaluate } from "./filter.js";
import type { FredyPort } from "./fredy.js";
import { getFilters, transition } from "./listings.js";
import { parseRooms } from "./parse.js";

export type EnrichOutcome = "skipped" | "failed" | "ok" | "dropped";

type Row = {
  external_id: string; state: string; title: string; address: string | null; description: string | null;
  rent: number | null; size_m2: number | null; rooms: number | null; lat: number | null;
};

/**
 * Zweite Stufe für Inserate, die den ersten Filter bestanden haben: Fredy lädt die Detailseite (nur für dieses Inserat),
 * wir übernehmen Beschreibung, genauere Adresse, Koordinaten und Ansprechpartner und filtern mit den neuen Daten noch einmal
 * (Ausschlusswörter in der Beschreibung, Zimmerzahl, Stadtteil). Schlägt der Abruf fehl, bleibt das Inserat unverändert.
 */
export async function enrichListing(db: Database.Database, fredy: FredyPort, id: number): Promise<EnrichOutcome> {
  if (!fredy.active()) return "skipped";
  const row = db.prepare("SELECT external_id, state, title, address, description, rent, size_m2, rooms, lat FROM listings WHERE id = ?").get(id) as Row | undefined;
  if (!row || row.state !== "gefiltert") return "skipped";

  let d;
  try {
    d = await fredy.details(row.external_id);
  } catch {
    db.prepare("UPDATE listings SET enriched = 'failed' WHERE id = ?").run(id);
    return "failed";
  }

  const description = d.description ?? row.description;
  const address = d.address && (!row.address || d.address.length > row.address.length) ? d.address : row.address;
  const rooms = row.rooms ?? parseRooms(row.title, description);
  const contact = extractContact(description);
  db.prepare(
    `UPDATE listings SET description = ?, address = ?, rooms = ?, lat = COALESCE(?, lat), lon = COALESCE(?, lon),
       contact_name = ?, contact_kind = ?, contact_salutation = ?, enriched = 'ok' WHERE id = ?`,
  ).run(description, address, rooms, d.lat, d.lon, contact?.name ?? null, contact?.kind ?? null, contact?.salutation ?? null, id);

  const v = evaluate({ rent: row.rent, sizeM2: row.size_m2, rooms, address, text: `${row.title} ${description ?? ""}` }, getFilters(db));
  if (!v.pass) {
    transition(db, id, "verworfen", `${v.reason} (nach Details)`);
    return "dropped";
  }
  return "ok";
}
