import type Database from "better-sqlite3";
import { z } from "zod";
import { evaluate, type Facts } from "./filter.js";
import { getFilters, transition } from "./listings.js";
import { parseNumber, parseRooms } from "./parse.js";

// Payload des Fredy-HTTP-Adapters, siehe docs/FREDY_INGEST.md
const listing = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    title: z.string().default(""),
    address: z.string().nullish(),
    description: z.string().nullish(),
    imageUrl: z.string().nullish(),
    price: z.string().nullish(),
    size: z.string().nullish(),
    url: z.string().nullish(),
  })
  .passthrough();

export const payloadSchema = z.object({
  event: z.string().optional(),
  jobId: z.string().optional(),
  provider: z.string(),
  listings: z.array(listing).default([]),
});

const PORTALS: Record<string, string> = {
  immoscout: "immoscout24",
  immoscout24: "immoscout24",
  kleinanzeigen: "kleinanzeigen",
  immowelt: "immowelt",
  wggesucht: "wggesucht", // Fredy sendet "wgGesucht"
};

export function ingest(db: Database.Database, input: unknown): { inserted: number; duplicates: number; ignored?: string; passed: number[] } {
  const p = payloadSchema.parse(input);
  if (p.event) return { inserted: 0, duplicates: 0, ignored: p.event, passed: [] }; // z. B. priceChange
  const portal = PORTALS[p.provider.toLowerCase()] ?? p.provider;
  // Idempotenz: UNIQUE(portal, external_id) + INSERT OR IGNORE
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO listings (portal, external_id, title, address, price, size, rent, size_m2, rooms, url, image_url, description, job_id, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const flt = getFilters(db);
  let inserted = 0;
  const passed: number[] = [];
  db.transaction(() => {
    for (const l of p.listings) {
      const facts: Facts = {
        rent: parseNumber(l.price),
        sizeM2: parseNumber(l.size),
        rooms: parseRooms(l.title, l.description),
        address: l.address ?? null,
        text: `${l.title} ${l.description ?? ""}`,
      };
      const r = stmt.run(portal, l.id, l.title, l.address ?? null, l.price ?? null, l.size ?? null, facts.rent, facts.sizeM2, facts.rooms, l.url ?? null, l.imageUrl ?? null, l.description ?? null, p.jobId ?? null, JSON.stringify(l));
      if (!r.changes) continue;
      inserted++;
      const v = evaluate(facts, flt);
      const id = Number(r.lastInsertRowid);
      transition(db, id, v.pass ? "gefiltert" : "verworfen", v.pass ? null : v.reason);
      if (v.pass) passed.push(id);
    }
  })();
  return { inserted, duplicates: p.listings.length - inserted, passed };
}
