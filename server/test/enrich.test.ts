import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { ingest } from "../src/ingest.js";
import { extractContact, greeting } from "../src/contact.js";
import { enrichListing } from "../src/enrich.js";
import { FredyClient, setFredySettings, getFredySettings, type FredyPort } from "../src/fredy.js";
import { geoCheck, setFilters } from "../src/listings.js";
import { NO_FILTERS } from "../src/filter.js";
import { createProfile, profileSchema } from "../src/profiles.js";
import { templateDraft } from "../src/draft.js";
import type { Geocoder } from "../src/geo.js";

process.env.NODE_ENV = "test";

describe("Ansprechpartner", () => {
  it.each([
    ["Agent: Tauschwohnung Wohnungstausch (Tauschwohnung GmbH)\nWohnungstyp: x", { kind: "company", salutation: null }],
    ["Ansprechpartner: Frau Maria Meier", { kind: "person", salutation: "Frau", name: "Maria Meier" }],
    ["Kontakt: Herr Müller", { kind: "person", salutation: "Herr", name: "Müller" }],
    ["Agent: Azam Akbar", { kind: "person", salutation: null, name: "Azam Akbar" }],
    ["Anbieter: Muster Immobilien Köln", { kind: "company", salutation: null }],
    ["Ansprechpartner: 0221 123456", { kind: "company", salutation: null }], // Unklares bekommt keine Personenanrede
  ])("%s", (text, want) => expect(extractContact(text)).toMatchObject(want));

  it("keine Zeile oder zu lang → null", () => {
    expect(extractContact("Schöne Wohnung, ruhige Lage.")).toBeNull();
    expect(extractContact(null)).toBeNull();
    expect(extractContact("Agent: " + "x".repeat(90))).toBeNull();
  });

  it("Gruß: Anrede nur bei erkannter Person, nie aus dem Vornamen geraten", () => {
    expect(greeting({ contactKind: "person", contactName: "Müller", contactSalutation: "Herr" })).toBe("Guten Tag Herr Müller,");
    expect(greeting({ contactKind: "person", contactName: "Maria Meier", contactSalutation: "Frau" })).toBe("Guten Tag Frau Meier,");
    expect(greeting({ contactKind: "person", contactName: "Azam Akbar", contactSalutation: null })).toBe("Guten Tag Azam Akbar,");
    expect(greeting({ contactKind: "company", contactName: "X GmbH" })).toBe("Guten Tag,");
    expect(greeting({})).toBe("Guten Tag,");
  });

  it("Template beginnt mit dem persönlichen Gruß", () => {
    const l = { id: 1, portal: "x", title: "Wohnung", address: "Köln", price: null, size: null, rooms: 2, description: null, state: "gefiltert", contactKind: "person", contactName: "Müller", contactSalutation: "Herr" };
    expect(templateDraft(l, profileSchema.parse({ fullName: "Max M" })).startsWith("Guten Tag Herr Müller,\n")).toBe(true);
  });
});

describe("FredyClient", () => {
  const res = (body: object | null, status = 200, cookies: string[] = []) => {
    const h = new Headers();
    for (const c of cookies) h.append("set-cookie", c);
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: h });
  };
  const mk = (f: typeof fetch, on = true) => {
    const db = openDb(":memory:");
    setFredySettings(db, { url: "http://fredy:9998/", user: "admin", password: "geheim", enabled: on });
    return { db, c: new FredyClient(db, f, 0) };
  };

  it("meldet sich an, holt Details für genau dieses Inserat und liest Beschreibung, Adresse, Koordinaten", async () => {
    const calls: string[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/login")) return res({}, 200, ["sid=abc; Path=/; HttpOnly"]);
      if (url.endsWith("/details")) return res({ status: "updated" });
      return res({ description: " Text ", address: "Straße 1, Köln", latitude: 50.9, longitude: 6.9 });
    }) as unknown as typeof fetch;
    const { c } = mk(f);
    expect(await c.details("abc/1")).toEqual({ description: "Text", address: "Straße 1, Köln", lat: 50.9, lon: 6.9 });
    expect(calls).toEqual(["POST http://fredy:9998/api/login", "POST http://fredy:9998/api/listings/abc%2F1/details", "GET http://fredy:9998/api/listings/abc%2F1"]);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1].headers.cookie).toBe("sid=abc");
  });

  it("Sitzung abgelaufen (401) → einmal neu anmelden; falsches Passwort und unbekanntes Inserat melden klar", async () => {
    let logins = 0, first = true;
    const f = vi.fn(async (url: string) => {
      if (url.endsWith("/api/login")) { logins++; return res({}, 200, ["sid=n" + logins]); }
      if (url.endsWith("/details") && first) { first = false; return res(null, 401); }
      if (url.endsWith("/details")) return res({});
      return res({ description: "d", latitude: -1, longitude: -1 }); // -1 = nicht gefunden
    }) as unknown as typeof fetch;
    const { c } = mk(f);
    expect(await c.details("1")).toMatchObject({ description: "d", lat: null, lon: null });
    expect(logins).toBe(2);

    const bad = mk(vi.fn(async () => res(null, 401)) as unknown as typeof fetch);
    await expect(bad.c.test()).rejects.toThrow(/falsch/);
    const nf = mk(vi.fn(async (u: string) => (u.endsWith("/login") ? res({}, 200, ["s=1"]) : res(null, 404))) as unknown as typeof fetch);
    await expect(nf.c.details("zz")).rejects.toThrow(/kennt dieses Inserat nicht/);
  });

  it("active nur mit Zugang und Schalter; Passwort wird nie zurückgegeben", () => {
    expect(mk(vi.fn() as never, true).c.active()).toBe(true);
    expect(mk(vi.fn() as never, false).c.active()).toBe(false);
    const { db } = mk(vi.fn() as never);
    expect(getFredySettings(db)).toEqual({ url: "http://fredy:9998", user: "admin", enabled: true, passwordSet: true });
  });
});

const fakeFredy = (d: Partial<Awaited<ReturnType<FredyPort["details"]>>> | Error, active = true): FredyPort => ({
  active: () => active, test: async () => {},
  details: async () => { if (d instanceof Error) throw d; return { description: null, address: null, lat: null, lon: null, ...d }; },
});

const seed = (db: ReturnType<typeof openDb>, extra: object = {}) => {
  ingest(db, { provider: "immoscout", listings: [{ id: "f-1", title: "Helle Wohnung", address: "Köln", price: "700 €", size: "50 m²", url: "http://x/1", ...extra }] });
  return 1;
};

describe("enrichListing", () => {
  it("übernimmt Beschreibung, Adresse, Koordinaten und Ansprechpartner", async () => {
    const db = openDb(":memory:");
    const id = seed(db);
    const out = await enrichListing(db, fakeFredy({ description: "Agent: Frau Anna Schmidt\nRuhige Lage", address: "Aachener Str. 1, 50674 Köln", lat: 50.93, lon: 6.93 }), id);
    expect(out).toBe("ok");
    expect(db.prepare("SELECT description, address, lat, lon, contact_name AS n, contact_kind AS k, contact_salutation AS s, enriched FROM listings").get())
      .toMatchObject({ description: expect.stringContaining("Ruhige Lage"), address: "Aachener Str. 1, 50674 Köln", lat: 50.93, lon: 6.93, n: "Anna Schmidt", k: "person", s: "Frau", enriched: "ok" });
  });

  it("zweiter Filter: Ausschlusswort in der Beschreibung verwirft das Inserat (mit Hinweis)", async () => {
    const db = openDb(":memory:");
    setFilters(db, { ...NO_FILTERS, excludeWords: ["Tauschwohnung"] });
    const id = seed(db);
    expect(db.prepare("SELECT state FROM listings").get()).toEqual({ state: "gefiltert" }); // Titel allein war unauffällig
    expect(await enrichListing(db, fakeFredy({ description: "Agent: Tauschwohnung GmbH. Diese Wohnung auf Tauschwohnung.com ..." }), id)).toBe("dropped");
    expect(db.prepare("SELECT state, filter_reason AS r FROM listings").get()).toEqual({ state: "verworfen", r: 'Ausschlusswort "Tauschwohnung" (nach Details)' });
  });

  it("Fehler von Fredy: Inserat bleibt unverändert und im Rennen", async () => {
    const db = openDb(":memory:");
    const id = seed(db);
    expect(await enrichListing(db, fakeFredy(new Error("Fredy nicht erreichbar")), id)).toBe("failed");
    expect(db.prepare("SELECT state, enriched, description FROM listings").get()).toEqual({ state: "gefiltert", enriched: "failed", description: null });
  });

  it("nicht eingerichtet oder nicht mehr im Status gefiltert: übersprungen, Fredy wird nicht gefragt", async () => {
    const db = openDb(":memory:");
    const id = seed(db);
    const spy = vi.fn();
    expect(await enrichListing(db, { ...fakeFredy({}, false), details: spy }, id)).toBe("skipped");
    db.prepare("UPDATE listings SET state = 'verworfen'").run();
    expect(await enrichListing(db, { ...fakeFredy({}), details: spy }, id)).toBe("skipped");
    expect(spy).not.toHaveBeenCalled();
  });

  it("längere Adresse ersetzt die kurze, eine kürzere nicht", async () => {
    const db = openDb(":memory:");
    const id = seed(db, { address: "Heidestraße 17, 51147 Köln" });
    await enrichListing(db, fakeFredy({ address: "Köln" }), id);
    expect((db.prepare("SELECT address FROM listings").get() as { address: string }).address).toBe("Heidestraße 17, 51147 Köln");
  });
});

describe("Umkreis mit Fredy-Koordinaten", () => {
  it("nutzt lat/lon aus Fredy ohne Adresssuche", async () => {
    const db = openDb(":memory:");
    setFilters(db, { ...NO_FILTERS, center: { address: "Neumarkt", lat: 50.9367, lon: 6.9473, label: "Neumarkt" }, radiusKm: 2 });
    seed(db);
    await enrichListing(db, fakeFredy({ address: "Aachener Str. 1, Köln", lat: 50.9385, lon: 6.9302 }), 1);
    const geocoder = vi.fn<Geocoder>();
    expect(await geoCheck(db, geocoder, 1)).toBe("ok");
    expect(geocoder).not.toHaveBeenCalled();
    expect(db.prepare("SELECT geo FROM listings").get()).toEqual({ geo: "ok" });

    // weit weg → verworfen
    db.prepare("UPDATE listings SET lat = 51.2277, lon = 6.7735, geo = NULL").run();
    expect(await geoCheck(db, geocoder, 1)).toBe("dropped");
  });
});

describe("Ablauf und API", () => {
  async function setup(fredy: FredyPort) {
    const db = openDb(":memory:");
    const app: FastifyInstance = await buildApp(loadConfig({ APP_SECRET: "x".repeat(32), INGEST_TOKEN: "t".repeat(24) }), db, { webDir: "/nonexistent", fredy });
    const s = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
    createProfile(db, "P", profileSchema.parse({ fullName: "Max M" }));
    return { db, app, cookies: { [s.cookies[0]!.name]: s.cookies[0]!.value } };
  }
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };
  const post = (app: FastifyInstance, id: string) => app.inject({ method: "POST", url: "/api/ingest", headers: { authorization: "Bearer " + "t".repeat(24) }, payload: { provider: "immoscout", listings: [{ id, title: "Wohnung " + id, price: "700 €", url: "http://x/" + id }] } });

  it("Ingest → Details → Entwurf mit persönlichem Gruß", async () => {
    const { app, db } = await setup(fakeFredy({ description: "Ansprechpartner: Herr Weber\nBalkon, ruhig" }));
    await post(app, "a1");
    await until(() => !!db.prepare("SELECT 1 FROM drafts").get());
    expect((db.prepare("SELECT body FROM drafts").get() as { body: string }).body.startsWith("Guten Tag Herr Weber,")).toBe(true);
  });

  it("Ingest → Details → zweiter Filter verwirft: kein Entwurf", async () => {
    const { app, db } = await setup(fakeFredy({ description: "Zwischenmiete bis März" }));
    setFilters(db, { ...NO_FILTERS, excludeWords: ["Zwischenmiete"] });
    await post(app, "a2");
    await until(() => (db.prepare("SELECT state FROM listings").get() as { state: string }).state === "verworfen");
    expect(db.prepare("SELECT count(*) c FROM drafts").get()).toEqual({ c: 0 });
  });

  it("Fredy fällt aus: Entwurf entsteht trotzdem (ohne Anrede)", async () => {
    const { app, db } = await setup(fakeFredy(new Error("offline")));
    await post(app, "a3");
    await until(() => !!db.prepare("SELECT 1 FROM drafts").get());
    expect((db.prepare("SELECT body FROM drafts").get() as { body: string }).body.startsWith("Guten Tag,\n")).toBe(true);
  });

  it("Einstellungen: speichern ohne Passwort-Rückgabe, testen, manuell nachladen; nur mit Login", async () => {
    const { app, cookies } = await setup(fakeFredy({ description: "Agent: Frau Lang" }));
    expect((await app.inject({ url: "/api/fredy" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/fredy/test", payload: {} })).statusCode).toBe(401);
    const put = await app.inject({ method: "PUT", url: "/api/fredy", cookies, payload: { url: "http://fredy:9998", user: "admin", password: "geheim", enabled: true } });
    expect(put.json()).toEqual({ url: "http://fredy:9998", user: "admin", enabled: true, passwordSet: true });
    expect(put.body).not.toContain("geheim");
    expect((await app.inject({ method: "POST", url: "/api/fredy/test", cookies, payload: {} })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "PUT", url: "/api/fredy", cookies, payload: { url: "kein-url" } })).statusCode).toBe(400);
  });

  it("manuelles Nachladen: ohne Zugang 409, mit Zugang Ergebnis", async () => {
    const off = await setup(fakeFredy({}, false));
    expect((await off.app.inject({ method: "POST", url: "/api/listings/1/enrich", cookies: off.cookies, payload: {} })).statusCode).toBe(409);
    const on = await setup(fakeFredy({ description: "ok" }));
    ingest(on.db, { provider: "immoscout", listings: [{ id: "m1", title: "W" }] });
    expect((await on.app.inject({ method: "POST", url: "/api/listings/1/enrich", cookies: on.cookies, payload: {} })).json()).toEqual({ result: "ok" });
  });
});
