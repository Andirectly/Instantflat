import { z } from "zod";

export const filtersSchema = z.object({
  maxRent: z.number().positive().nullable(),
  minSize: z.number().positive().nullable(),
  minRooms: z.number().positive().nullable(),
  districts: z.array(z.string().trim().min(1)).max(50),
  excludeWords: z.array(z.string().trim().min(1)).max(50),
  // Umkreis um einen Mittelpunkt (Koordinaten werden beim Speichern aus der Adresse ermittelt)
  center: z.object({ address: z.string().trim().min(1).max(200), lat: z.number(), lon: z.number(), label: z.string() }).nullable().default(null),
  radiusKm: z.number().positive().max(500).nullable().default(null),
});
export type Filters = z.infer<typeof filtersSchema>;

export const NO_FILTERS: Filters = { maxRent: null, minSize: null, minRooms: null, districts: [], excludeWords: [], center: null, radiusKm: null };

export type Facts = { rent: number | null; sizeM2: number | null; rooms: number | null; address: string | null; text: string };

// Unbekannte Werte (null) verwerfen nie: lieber einmal zu viel prüfen als ein Inserat verlieren.
export function evaluate(f: Facts, flt: Filters): { pass: true } | { pass: false; reason: string } {
  if (flt.maxRent != null && f.rent != null && f.rent > flt.maxRent) return { pass: false, reason: `Miete ${f.rent} € > ${flt.maxRent} €` };
  if (flt.minSize != null && f.sizeM2 != null && f.sizeM2 < flt.minSize) return { pass: false, reason: `Fläche ${f.sizeM2} m² < ${flt.minSize} m²` };
  if (flt.minRooms != null && f.rooms != null && f.rooms < flt.minRooms) return { pass: false, reason: `${f.rooms} Zimmer < ${flt.minRooms}` };
  const hay = f.text.toLowerCase();
  const bad = flt.excludeWords.find((w) => hay.includes(w.toLowerCase()));
  if (bad) return { pass: false, reason: `Ausschlusswort "${bad}"` };
  if (flt.districts.length && f.address) {
    const a = f.address.toLowerCase();
    if (!flt.districts.some((d) => a.includes(d.toLowerCase()))) return { pass: false, reason: "Stadtteil nicht in Liste" };
  }
  return { pass: true };
}
