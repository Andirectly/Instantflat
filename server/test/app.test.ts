import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";

process.env.NODE_ENV = "test";
const env = { APP_SECRET: "x".repeat(32), INGEST_TOKEN: "t".repeat(24) };
const fredy = (id: string, provider = "immoscout") => ({
  jobId: "j1",
  provider,
  timestamp: "2026-01-01T00:00:00Z",
  listings: [{ id, title: "2 Zi Köln", address: "Ehrenfeld", price: "950 €", size: "55 m²", url: "https://x/1", imageUrl: "https://x/1.jpg" }],
});
const bearer = { authorization: `Bearer ${env.INGEST_TOKEN}` };

describe("config", () => {
  it("lehnt fehlende Secrets ab, DRY_RUN default true", () => {
    expect(() => loadConfig({})).toThrow(/APP_SECRET/);
    expect(loadConfig(env).DRY_RUN).toBe(true);
  });
});

describe("app", () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof openDb>;
  beforeEach(async () => {
    db = openDb(":memory:");
    app = await buildApp(loadConfig(env), db, { webDir: "/nonexistent" });
  });

  it("ingest braucht Token", async () => {
    expect((await app.inject({ method: "POST", url: "/api/ingest", payload: fredy("1") })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/ingest", headers: { authorization: "Bearer nope" }, payload: fredy("1") })).statusCode).toBe(401);
  });

  it("ingest ist idempotent pro Portal+ID", async () => {
    const send = (p: object) => app.inject({ method: "POST", url: "/api/ingest", headers: bearer, payload: p });
    expect((await send(fredy("1"))).json()).toEqual({ inserted: 1, duplicates: 0 });
    expect((await send(fredy("1"))).json()).toEqual({ inserted: 0, duplicates: 1 });
    expect((await send(fredy("1", "kleinanzeigen"))).json().inserted).toBe(1); // gleiche ID, anderes Portal
    expect(db.prepare("SELECT count(*) c FROM listings").get()).toEqual({ c: 2 });
    expect((db.prepare("SELECT portal FROM listings").all() as { portal: string }[]).map((r) => r.portal)).toEqual(["immoscout24", "kleinanzeigen"]);
  });

  it("ingest ignoriert priceChange und weist kaputte Payloads ab", async () => {
    const r = await app.inject({ method: "POST", url: "/api/ingest", headers: bearer, payload: { event: "priceChange", provider: "immoscout", priceChanges: [] } });
    expect(r.json().ignored).toBe("priceChange");
    expect((await app.inject({ method: "POST", url: "/api/ingest", headers: bearer, payload: { foo: 1 } })).statusCode).toBe(400);
  });

  it("Setup → Login → geschützte Route → Logout", async () => {
    expect((await app.inject({ url: "/api/auth/status" })).json()).toEqual({ setup: true, authed: false });
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
    expect(setup.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "another pass 22" } })).statusCode).toBe(409);

    expect((await app.inject({ url: "/api/listings" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong wrong wrong" } })).statusCode).toBe(401);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse 1" } });
    expect(login.statusCode).toBe(200);
    const cookies = { [login.cookies[0]!.name]: login.cookies[0]!.value };
    expect((await app.inject({ url: "/api/listings", cookies })).statusCode).toBe(200);

    await app.inject({ method: "POST", url: "/api/auth/logout", cookies });
    expect((await app.inject({ url: "/api/listings", cookies })).statusCode).toBe(401);
  });

  it("Overview, Filter und Statuswechsel nur mit Login", async () => {
    expect((await app.inject({ url: "/api/overview" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/filters", payload: {} })).statusCode).toBe(401);
    const s = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
    const cookies = { [s.cookies[0]!.name]: s.cookies[0]!.value };
    const f = { maxRent: 1000, minSize: null, minRooms: null, districts: [], excludeWords: ["tausch"] };
    expect((await app.inject({ method: "PUT", url: "/api/filters", cookies, payload: f })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/filters", cookies, payload: { maxRent: -1 } })).statusCode).toBe(400);
    await app.inject({ method: "POST", url: "/api/ingest", headers: bearer, payload: { provider: "immoscout", listings: [{ id: "1", title: "A", price: "900 €" }, { id: "2", title: "B", price: "2.000 €" }] } });
    const o = (await app.inject({ url: "/api/overview", cookies })).json();
    expect(o).toMatchObject({ today: 2, waiting: 1, filtered: 1, total: 2 });
    expect(o.recent).toHaveLength(1);
    const items = (await app.inject({ url: "/api/listings?state=verworfen", cookies })).json().items;
    expect(items).toHaveLength(1);
    const post = (to: string) => app.inject({ method: "POST", url: `/api/listings/${items[0].id}/state`, cookies, payload: { to } });
    expect((await post("gefiltert")).statusCode).toBe(200);
    expect((await post("gefiltert")).statusCode).toBe(409);
    expect((await post("gesendet")).statusCode).toBe(400); // in Etappe 2 nicht per API erlaubt
  });

  it("ingest-info nur mit Login", async () => {
    expect((await app.inject({ url: "/api/ingest-info" })).statusCode).toBe(401);
    const s = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
    const cookies = { [s.cookies[0]!.name]: s.cookies[0]!.value };
    expect((await app.inject({ url: "/api/ingest-info", cookies })).json()).toEqual({ endpoint: "http://instantflat:8080/api/ingest", token: env.INGEST_TOKEN });
  });

  it("Login ist rate-limitiert", async () => {
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong wrong wrong" } })).statusCode);
    expect(codes.at(-1)).toBe(429);
  });
});
