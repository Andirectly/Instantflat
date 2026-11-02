import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { createProfile, profileSchema } from "../src/profiles.js";

process.env.NODE_ENV = "test";
const env = { APP_SECRET: "x".repeat(32), INGEST_TOKEN: "t".repeat(24) };
const bearer = { authorization: `Bearer ${env.INGEST_TOKEN}` };
const ingest = (app: FastifyInstance, id: string) => app.inject({ method: "POST", url: "/api/ingest", headers: bearer, payload: { provider: "immoscout", listings: [{ id, title: "Wohnung " + id, url: "http://x/" + id }] } });
const until = async (fn: () => boolean) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };

describe("Einstellungen, Automodus, Outbox", () => {
  let app: FastifyInstance, db: ReturnType<typeof openDb>, cookies: Record<string, string>;
  beforeEach(async () => {
    db = openDb(":memory:");
    app = await buildApp(loadConfig(env), db, { webDir: "/nonexistent" });
    const s = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
    cookies = { [s.cookies[0]!.name]: s.cookies[0]!.value };
    createProfile(db, "P", profileSchema.parse({ fullName: "Max M" }));
  });

  it("Standard: Freigabe-Modus, Limit 7, Dry-Run an; nur mit Login änderbar", async () => {
    expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/settings", cookies })).json()).toMatchObject({ mode: "manual", dailyLimit: 7, dryRun: true, nightFrom: 22, nightTo: 7 });
    const put = (payload: object) => app.inject({ method: "PUT", url: "/api/settings", cookies, payload });
    expect((await put({ mode: "auto", dailyLimit: 5 })).json()).toEqual({ mode: "auto", dailyLimit: 5 });
    expect((await put({ dailyLimit: 0 })).statusCode).toBe(400);
  });

  it("Manuell: Entwurf entsteht, aber nichts landet in der Queue", async () => {
    await ingest(app, "1");
    await until(() => !!db.prepare("SELECT 1 FROM drafts").get());
    expect(db.prepare("SELECT count(*) c FROM outbox").get()).toEqual({ c: 0 });
  });

  it("Auto: neues Inserat wird entworfen, freigegeben und eingereiht", async () => {
    await app.inject({ method: "PUT", url: "/api/settings", cookies, payload: { mode: "auto" } });
    await ingest(app, "1");
    await until(() => !!db.prepare("SELECT 1 FROM outbox").get());
    expect(db.prepare("SELECT status FROM outbox").get()).toEqual({ status: "queued" });
    expect(db.prepare("SELECT state FROM listings").get()).toEqual({ state: "freigegeben" });
  });

  it("Auto: Entwurf vom lokalen Modell wird nie automatisch freigegeben", async () => {
    const local = { name: "local", generate: async () => "Guten Tag, " + "ein ordentlicher Text. ".repeat(15) + "Viele Grüße Max M" };
    const app2 = await buildApp(loadConfig(env), db, { webDir: "/nonexistent", generator: local });
    await app2.inject({ method: "PUT", url: "/api/settings", cookies, payload: { mode: "auto" } });
    await app2.inject({ method: "POST", url: "/api/ingest", headers: bearer, payload: { provider: "immoscout", listings: [{ id: "9", title: "Wohnung", url: "http://x/9" }] } });
    await until(() => !!db.prepare("SELECT 1 FROM drafts").get());
    await new Promise((r) => setTimeout(r, 100));
    expect(db.prepare("SELECT provider FROM drafts").get()).toEqual({ provider: "local" });
    expect(db.prepare("SELECT state FROM listings").get()).toEqual({ state: "entwurf" });
    expect(db.prepare("SELECT count(*) c FROM outbox").get()).toEqual({ c: 0 });
  });

  it("Freigabe per API reiht ein; doppelte Freigabe wird abgelehnt", async () => {
    await ingest(app, "1");
    await until(() => !!db.prepare("SELECT 1 FROM drafts").get());
    const id = (db.prepare("SELECT id FROM listings").get() as { id: number }).id;
    expect((await app.inject({ method: "POST", url: `/api/listings/${id}/approve`, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/listings/${id}/approve`, cookies })).statusCode).toBe(409);
    expect(db.prepare("SELECT count(*) c FROM outbox").get()).toEqual({ c: 1 });
  });

  it("unknown auflösen: als gesendet bestätigen (nie wiederholen) oder zurück in die Queue", async () => {
    await ingest(app, "1");
    await until(() => !!db.prepare("SELECT 1 FROM drafts").get());
    const id = (db.prepare("SELECT id FROM listings").get() as { id: number }).id;
    await app.inject({ method: "POST", url: `/api/listings/${id}/approve`, cookies });
    const resolve = (to: string) => app.inject({ method: "POST", url: "/api/outbox/1/resolve", cookies, payload: { to } });
    expect((await resolve("sent")).statusCode).toBe(409); // noch nicht unknown
    db.prepare("UPDATE outbox SET status = 'unknown'").run();
    expect((await resolve("sent")).statusCode).toBe(200);
    expect(db.prepare("SELECT status FROM outbox").get()).toEqual({ status: "sent" });
    expect(db.prepare("SELECT state FROM listings").get()).toEqual({ state: "gesendet" });
  });

  it("Screenshots: nur gültige Namen, nur mit Login", async () => {
    expect((await app.inject({ url: "/api/screenshots/1-1.png" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/screenshots/..%2Fsecret", cookies })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/screenshots/9-9.png", cookies })).statusCode).toBe(404);
  });
});
