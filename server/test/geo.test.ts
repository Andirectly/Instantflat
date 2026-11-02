import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { cachedGeocode, haversineKm, nominatimGeocoder, precisionOf, type Geocoder, type GeoResult } from "../src/geo.js";
import { createProfile, profileSchema } from "../src/profiles.js";

process.env.NODE_ENV = "test";
const NEUMARKT = { lat: 50.9367, lon: 6.9473 };

describe("Entfernung und Genauigkeit", () => {
  it("Haversine: Köln–Düsseldorf rund 34 km, gleicher Punkt 0", () => {
    expect(haversineKm(NEUMARKT, NEUMARKT)).toBe(0);
    expect(haversineKm(NEUMARKT, { lat: 51.2277, lon: 6.7735 })).toBeGreaterThan(30);
    expect(haversineKm(NEUMARKT, { lat: 51.2277, lon: 6.7735 })).toBeLessThan(38);
  });
  it("precisionOf: Straße = ok, Stadtteil/PLZ = approx, nur Stadt = unknown", () => {
    expect(precisionOf({ road: "Heidestraße", city: "Köln" })).toBe("ok");
    expect(precisionOf({ suburb: "Ehrenfeld", city: "Köln" })).toBe("approx");
    expect(precisionOf({ postcode: "50823", city: "Köln" })).toBe("approx");
    expect(precisionOf({ city: "Köln" })).toBe("unknown");
    expect(precisionOf(undefined)).toBe("unknown");
  });
});

describe("nominatimGeocoder", () => {
  const body = (o: object[]) => new Response(JSON.stringify(o));
  it("liest Treffer, setzt User-Agent, Land und Genauigkeit", async () => {
    const f = vi.fn().mockResolvedValue(body([{ lat: "50.94", lon: "6.95", display_name: "Neumarkt, Altstadt, Köln, NRW", address: { road: "Neumarkt" } }]));
    const r = await nominatimGeocoder({ fetchImpl: f, minGapMs: 0 })("Neumarkt, Köln");
    expect(r).toMatchObject({ lat: 50.94, lon: 6.95, precision: "ok" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toContain("countrycodes=de");
    expect(url).toContain(encodeURIComponent("Neumarkt, Köln"));
    expect((init as RequestInit).headers).toMatchObject({ "user-agent": expect.stringContaining("Instantflat") });
  });
  it("kein Treffer → null, HTTP-Fehler wirft", async () => {
    expect(await nominatimGeocoder({ fetchImpl: vi.fn().mockResolvedValue(body([])), minGapMs: 0 })("xyz")).toBeNull();
    await expect(nominatimGeocoder({ fetchImpl: vi.fn().mockResolvedValue(new Response("", { status: 429 })), minGapMs: 0 })("x")).rejects.toThrow(/429/);
  });
  it("hält den Mindestabstand zwischen Anfragen ein", async () => {
    const times: number[] = [];
    const f = vi.fn(async () => (times.push(Date.now()), body([])));
    const g = nominatimGeocoder({ fetchImpl: f as never, minGapMs: 120 });
    await Promise.all([g("a"), g("b"), g("c")]);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(110);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(110);
  });
});

describe("cachedGeocode", () => {
  it("fragt dieselbe Adresse nur einmal, auch bei 'nicht gefunden'; Fehler werden nicht gespeichert", async () => {
    const db = openDb(":memory:");
    const g = vi.fn<Geocoder>().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("netz")).mockResolvedValue({ lat: 1, lon: 2, precision: "ok", label: "x" });
    expect(await cachedGeocode(db, g, "Nirgendwo 1")).toBeNull();
    expect(await cachedGeocode(db, g, " nirgendwo 1 ")).toBeNull();
    expect(g).toHaveBeenCalledTimes(1);
    await expect(cachedGeocode(db, g, "Neu 5")).rejects.toThrow("netz");
    expect(await cachedGeocode(db, g, "Neu 5")).toMatchObject({ lat: 1 });
    expect(g).toHaveBeenCalledTimes(3);
  });
});

describe("Radius im Ablauf (API, Ingest, Automodus)", () => {
  let app: FastifyInstance, db: ReturnType<typeof openDb>, cookies: Record<string, string>;
  const places: Record<string, GeoResult | null> = {
    "Neumarkt, Köln": { ...NEUMARKT, precision: "ok", label: "Neumarkt, Köln" },
    "Aachener Str. 1, Köln": { lat: 50.9385, lon: 6.9302, precision: "ok", label: "x" }, // ~1,2 km
    "Ehrenfeld, Köln": { lat: 50.9513, lon: 6.9179, precision: "approx", label: "x" }, // ~2,8 km
    "Düsseldorf Altstadt": { lat: 51.2277, lon: 6.7735, precision: "ok", label: "x" }, // ~34 km
    "Köln": { lat: 50.94, lon: 6.96, precision: "unknown", label: "x" },
  };
  const geocoder = vi.fn<Geocoder>(async (q) => places[q] ?? null);
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };
  const ingest = (id: string, address: string | null) => app.inject({ method: "POST", url: "/api/ingest", headers: { authorization: "Bearer " + "t".repeat(24) }, payload: { provider: "immoscout", listings: [{ id, title: "Wohnung " + id, address, url: "http://x/" + id }] } });
  const put = (payload: object) => app.inject({ method: "PUT", url: "/api/filters", cookies, payload });
  const base = { maxRent: null, minSize: null, minRooms: null, districts: [], excludeWords: [] };
  const state = (id: number) => db.prepare("SELECT state, geo, dist_km AS dist, filter_reason AS reason FROM listings WHERE id = ?").get(id) as { state: string; geo: string | null; dist: number | null; reason: string | null };

  beforeEach(async () => {
    geocoder.mockClear();
    db = openDb(":memory:");
    app = await buildApp(loadConfig({ APP_SECRET: "x".repeat(32), INGEST_TOKEN: "t".repeat(24) }), db, { webDir: "/nonexistent", geocoder });
    const s = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
    cookies = { [s.cookies[0]!.name]: s.cookies[0]!.value };
    createProfile(db, "P", profileSchema.parse({ fullName: "Max M" }));
  });

  it("Mittelpunkt wird aufgelöst und gespeichert; unveränderte Adresse fragt nicht neu an", async () => {
    const r = await put({ ...base, centerAddress: "Neumarkt, Köln", radiusKm: 5 });
    expect(r.json().center).toMatchObject({ address: "Neumarkt, Köln", lat: NEUMARKT.lat });
    await put({ ...base, centerAddress: "Neumarkt, Köln", radiusKm: 7 });
    expect(geocoder).toHaveBeenCalledTimes(1);
    expect((await app.inject({ url: "/api/filters", cookies })).json()).toMatchObject({ radiusKm: 7, center: { address: "Neumarkt, Köln" } });
  });

  it("Fehler: Adresse unbekannt, Radius ohne Adresse, Geocoder offline", async () => {
    expect((await put({ ...base, centerAddress: "Gibt es nicht", radiusKm: 5 })).statusCode).toBe(400);
    expect((await put({ ...base, centerAddress: null, radiusKm: 5 })).statusCode).toBe(400);
    geocoder.mockRejectedValueOnce(new Error("offline"));
    expect((await put({ ...base, centerAddress: "Neumarkt, Köln", radiusKm: 5 })).statusCode).toBe(502);
  });

  it("ohne Radius: Adresse wird ignoriert, alles läuft wie bisher", async () => {
    expect((await put({ ...base, centerAddress: "Neumarkt, Köln", radiusKm: null })).json().center).toBeNull();
    await ingest("1", "Düsseldorf Altstadt");
    await until(() => !!db.prepare("SELECT 1 FROM drafts").get());
    expect(state(1).state).toBe("entwurf");
    expect(geocoder).not.toHaveBeenCalled();
  });

  it("innerhalb → Entwurf; außerhalb → verworfen mit Grund; Stadtteil = ungefähr", async () => {
    await put({ ...base, centerAddress: "Neumarkt, Köln", radiusKm: 5 });
    await ingest("1", "Aachener Str. 1, Köln");
    await ingest("2", "Düsseldorf Altstadt");
    await ingest("3", "Ehrenfeld, Köln");
    await until(() => (db.prepare("SELECT count(*) c FROM drafts").get() as { c: number }).c === 2 && state(2).state === "verworfen");
    expect(state(1)).toMatchObject({ state: "entwurf", geo: "ok" });
    expect(state(1).dist).toBeLessThan(2);
    expect(state(2)).toMatchObject({ state: "verworfen" });
    expect(state(2).reason).toMatch(/^\d+,\d km > 5 km$/);
    expect(state(3)).toMatchObject({ state: "entwurf", geo: "approx" });
  });

  it("Auto-Modus: Ort unklar oder fehlend → Entwurf, aber nicht in der Queue; bekannter Ort → Queue", async () => {
    await put({ ...base, centerAddress: "Neumarkt, Köln", radiusKm: 5 });
    await app.inject({ method: "PUT", url: "/api/settings", cookies, payload: { mode: "auto" } });
    await ingest("1", "Aachener Str. 1, Köln"); // bekannt
    await ingest("2", "Köln"); // nur Stadt
    await ingest("3", null); // keine Adresse
    await until(() => (db.prepare("SELECT count(*) c FROM drafts").get() as { c: number }).c === 3);
    await until(() => !!db.prepare("SELECT 1 FROM outbox").get());
    expect(db.prepare("SELECT listing_id FROM outbox").all()).toEqual([{ listing_id: 1 }]);
    expect(state(2)).toMatchObject({ state: "entwurf", geo: "unknown" });
    expect(state(3)).toMatchObject({ state: "entwurf", geo: "unknown" });
  });

  it("Geocoder fällt aus: Inserat bleibt, wird aber nie automatisch gesendet", async () => {
    await put({ ...base, centerAddress: "Neumarkt, Köln", radiusKm: 5 });
    await app.inject({ method: "PUT", url: "/api/settings", cookies, payload: { mode: "auto" } });
    geocoder.mockRejectedValue(new Error("offline"));
    await ingest("1", "Aachener Str. 1, Köln");
    await until(() => !!db.prepare("SELECT 1 FROM drafts").get());
    expect(state(1)).toMatchObject({ state: "entwurf", geo: null });
    expect(db.prepare("SELECT count(*) c FROM outbox").get()).toEqual({ c: 0 });
    geocoder.mockImplementation(async (q) => places[q] ?? null);
  });

  it("Listing-API liefert Entfernung und Genauigkeit", async () => {
    await put({ ...base, centerAddress: "Neumarkt, Köln", radiusKm: 5 });
    await ingest("1", "Aachener Str. 1, Köln");
    await until(() => state(1).geo === "ok");
    const items = (await app.inject({ url: "/api/listings", cookies })).json().items;
    expect(items[0]).toMatchObject({ geo: "ok", distKm: expect.any(Number) });
  });
});
