import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { createProfile, profileSchema } from "../src/profiles.js";
import { setFilters } from "../src/listings.js";
import { NO_FILTERS } from "../src/filter.js";

process.env.NODE_ENV = "test";
const env = { APP_SECRET: "x".repeat(32), INGEST_TOKEN: "t".repeat(24) };

async function setup(telegram?: { sendText: (t: string) => Promise<void> }, notify?: (id: number) => Promise<void>) {
  const db = openDb(":memory:");
  const app: FastifyInstance = await buildApp(loadConfig(env), db, { webDir: "/nonexistent", telegram, notify });
  const s = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
  return { db, app, cookies: { [s.cookies[0]!.name]: s.cookies[0]!.value } };
}

describe("Testlauf", () => {
  it("nur mit Login", async () => {
    const { app } = await setup();
    for (const [m, u] of [["GET", "/api/telegram"], ["POST", "/api/test/telegram"], ["POST", "/api/test/listing"]] as const) {
      expect((await app.inject({ method: m, url: u })).statusCode).toBe(401);
    }
  });

  it("Telegram-Status und Testnachricht: nicht eingerichtet, Erfolg, Fehler von Telegram", async () => {
    const a = await setup();
    expect((await a.app.inject({ url: "/api/telegram", cookies: a.cookies })).json()).toEqual({ configured: false });
    expect((await a.app.inject({ method: "POST", url: "/api/test/telegram", cookies: a.cookies })).statusCode).toBe(409);

    const send = vi.fn().mockResolvedValue(undefined);
    const b = await setup({ sendText: send });
    expect((await b.app.inject({ url: "/api/telegram", cookies: b.cookies })).json()).toEqual({ configured: true });
    expect((await b.app.inject({ method: "POST", url: "/api/test/telegram", cookies: b.cookies })).json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Testnachricht"));

    const c = await setup({ sendText: vi.fn().mockRejectedValue(new Error("Unauthorized")) });
    const r = await c.app.inject({ method: "POST", url: "/api/test/telegram", cookies: c.cookies });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/Unauthorized/);
  });

  it("Test-Inserat umgeht strenge Filter, bekommt Entwurf und löst die Telegram-Karte aus", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const { app, db, cookies } = await setup({ sendText: vi.fn() }, notify);
    createProfile(db, "P", profileSchema.parse({ fullName: "Max M" }));
    setFilters(db, { ...NO_FILTERS, maxRent: 100, minSize: 500, districts: ["Nirgendwo"], excludeWords: ["testwohnung"] }); // würde alles verwerfen
    const r = (await app.inject({ method: "POST", url: "/api/test/listing", cookies })).json();
    expect(r).toMatchObject({ state: "entwurf", draft: true, telegram: true, activeProfile: true });
    expect(notify).toHaveBeenCalledWith(r.id);
    expect(db.prepare("SELECT portal FROM listings").get()).toEqual({ portal: "test" });
  });

  it("ohne Profil: Test-Inserat bleibt ohne Entwurf, Antwort sagt warum", async () => {
    const { app, cookies } = await setup({ sendText: vi.fn() });
    const r = (await app.inject({ method: "POST", url: "/api/test/listing", cookies })).json();
    expect(r).toMatchObject({ state: "gefiltert", draft: false, telegram: false, activeProfile: false });
  });
});
