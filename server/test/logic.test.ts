import { describe, expect, it } from "vitest";
import { parseNumber, parseRooms } from "../src/parse.js";
import { evaluate, NO_FILTERS, type Facts } from "../src/filter.js";
import { openDb } from "../src/db.js";
import { ingest } from "../src/ingest.js";
import { listListings, setFilters, transition, TransitionError } from "../src/listings.js";

describe("parseNumber", () => {
  it.each([
    ["1.240 €", 1240],
    ["ab 950 €", 950],
    ["1.240,50 €", 1240.5],
    ["72 m²", 72],
    ["72,5 m²", 72.5],
    ["1.150 € warm", 1150],
  ])("%s → %s", (s, n) => expect(parseNumber(s)).toBe(n));
  it("k. A. / leer → null", () => {
    expect(parseNumber("k. A.")).toBeNull();
    expect(parseNumber(null)).toBeNull();
  });
});

describe("parseRooms", () => {
  it.each([
    ["Helle 3-Zimmer-Wohnung", 3],
    ["2,5 Zimmer in Nippes", 2.5],
    ["2 Zi. Altbau", 2],
  ])("%s → %s", (s, n) => expect(parseRooms(s)).toBe(n));
  it("nichts gefunden → null", () => expect(parseRooms("Schöne Wohnung")).toBeNull());
});

const facts = (o: Partial<Facts> = {}): Facts => ({ rent: 900, sizeM2: 60, rooms: 2, address: "Ehrenfeld, Köln", text: "Schöne Wohnung", ...o });

describe("evaluate", () => {
  it("ohne Filter passiert alles", () => expect(evaluate(facts(), NO_FILTERS).pass).toBe(true));
  it("Miete zu hoch", () => expect(evaluate(facts({ rent: 1500 }), { ...NO_FILTERS, maxRent: 1200 })).toMatchObject({ pass: false }));
  it("unbekannte Werte verwerfen nie", () => {
    const f = { ...NO_FILTERS, maxRent: 1000, minSize: 50, minRooms: 2, districts: ["Nippes"] };
    expect(evaluate(facts({ rent: null, sizeM2: null, rooms: null, address: null }), f).pass).toBe(true);
  });
  it("Fläche, Zimmer, Stadtteil, Ausschlusswort", () => {
    expect(evaluate(facts({ sizeM2: 40 }), { ...NO_FILTERS, minSize: 50 }).pass).toBe(false);
    expect(evaluate(facts({ rooms: 1 }), { ...NO_FILTERS, minRooms: 2 }).pass).toBe(false);
    expect(evaluate(facts(), { ...NO_FILTERS, districts: ["Nippes"] }).pass).toBe(false);
    expect(evaluate(facts(), { ...NO_FILTERS, districts: ["ehrenfeld"] }).pass).toBe(true);
    expect(evaluate(facts({ text: "WG-Zimmer, Tausch möglich" }), { ...NO_FILTERS, excludeWords: ["tausch"] }).pass).toBe(false);
  });
});

describe("Portal-Zuordnung", () => {
  it.each([["wgGesucht", "wggesucht"], ["immoscout", "immoscout24"], ["Kleinanzeigen", "kleinanzeigen"], ["TestCall", "TestCall"]])("%s → %s", (p, want) => {
    const db = openDb(":memory:");
    ingest(db, { provider: p, listings: [{ id: "1", title: "x" }] });
    expect(db.prepare("SELECT portal FROM listings").get()).toEqual({ portal: want });
  });
});

describe("Zustandsmaschine + Ingest-Filter", () => {
  const payload = (id: string, price: string) => ({ provider: "immoscout", listings: [{ id, title: "3-Zimmer", price, size: "70 m²", address: "Köln" }] });

  it("Ingest sortiert nach Filter und schreibt Events", () => {
    const db = openDb(":memory:");
    setFilters(db, { ...NO_FILTERS, maxRent: 1000 });
    ingest(db, payload("a", "900 €"));
    ingest(db, payload("b", "1.400 €"));
    const states = Object.fromEntries((listListings(db, {}).items as { title: string; state: string; filterReason: string | null; rent: number }[]).map((l) => [l.rent, l]));
    expect(states[900]!.state).toBe("gefiltert");
    expect(states[1400]).toMatchObject({ state: "verworfen", filterReason: "Miete 1400 € > 1000 €" });
    expect(db.prepare("SELECT count(*) c FROM listing_events").get()).toEqual({ c: 2 });
  });

  it("Dublette löst keinen zweiten Filterlauf aus", () => {
    const db = openDb(":memory:");
    ingest(db, payload("a", "900 €"));
    ingest(db, payload("a", "900 €"));
    expect(db.prepare("SELECT count(*) c FROM listing_events").get()).toEqual({ c: 1 });
  });

  it("verbotene Übergänge werfen, Reaktivieren geht", () => {
    const db = openDb(":memory:");
    ingest(db, payload("a", "900 €"));
    expect(() => transition(db, 1, "gesendet")).toThrow(TransitionError);
    transition(db, 1, "verworfen", "x");
    transition(db, 1, "gefiltert");
    expect(db.prepare("SELECT state, filter_reason FROM listings").get()).toEqual({ state: "gefiltert", filter_reason: null });
  });
});
