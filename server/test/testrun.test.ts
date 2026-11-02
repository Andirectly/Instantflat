import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { createProfile, profileSchema } from "../src/profiles.js";
import { setFilters } from "../src/listings.js";
import { NO_FILTERS } from "../src/filter.js";
import type { TelegramHubApi } from "../src/telegram.js";

process.env.NODE_ENV = "test";
const env = { APP_SECRET: "x".repeat(32), INGEST_TOKEN: "t".repeat(24) };

const fakeHub = (o: Partial<TelegramHubApi> = {}): TelegramHubApi => ({
  configured: () => true, chatId: () => "42", source: () => "app",
  sendText: async () => {}, notifyDraft: async () => {},
  apply: async () => ({ bot: "@test_bot" }), findChats: async () => [],
  ...o,
});

async function setup(telegram?: TelegramHubApi, notify?: (id: number) => Promise<void>) {
  const db = openDb(":memory:");
  const app: FastifyInstance = await buildApp(loadConfig(env), db, { webDir: "/nonexistent", telegram, notify });
  const s = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
  return { db, app, cookies: { [s.cookies[0]!.name]: s.cookies[0]!.value } };
}

describe("Testlauf", () => {
  it("nur mit Login", async () => {
    const { app } = await setup(fakeHub());
    for (const [m, u] of [["GET", "/api/telegram"], ["PUT", "/api/telegram"], ["POST", "/api/telegram/find-chat"], ["POST", "/api/test/telegram"], ["POST", "/api/test/listing"]] as const) {
      expect((await app.inject({ method: m, url: u, payload: {} })).statusCode).toBe(401);
    }
  });

  it("Telegram-Status und Testnachricht: nicht eingerichtet, Erfolg, Fehler von Telegram", async () => {
    const a = await setup(fakeHub({ configured: () => false, chatId: () => null, source: () => null }));
    expect((await a.app.inject({ url: "/api/telegram", cookies: a.cookies })).json()).toEqual({ configured: false, chatId: null, source: null });
    expect((await a.app.inject({ method: "POST", url: "/api/test/telegram", cookies: a.cookies })).statusCode).toBe(409);

    const send = vi.fn().mockResolvedValue(undefined);
    const b = await setup(fakeHub({ sendText: send }));
    expect((await b.app.inject({ url: "/api/telegram", cookies: b.cookies })).json()).toEqual({ configured: true, chatId: "42", source: "app" });
    expect((await b.app.inject({ method: "POST", url: "/api/test/telegram", cookies: b.cookies })).json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Testnachricht"));

    const c = await setup(fakeHub({ sendText: vi.fn().mockRejectedValue(new Error("Unauthorized")) }));
    const r = await c.app.inject({ method: "POST", url: "/api/test/telegram", cookies: c.cookies });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/Unauthorized/);
  });

  it("Test-Inserat umgeht strenge Filter, bekommt Entwurf und löst die Telegram-Karte aus", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const { app, db, cookies } = await setup(fakeHub(), notify);
    createProfile(db, "P", profileSchema.parse({ fullName: "Max M" }));
    setFilters(db, { ...NO_FILTERS, maxRent: 100, minSize: 500, districts: ["Nirgendwo"], excludeWords: ["testwohnung"] }); // würde alles verwerfen
    const r = (await app.inject({ method: "POST", url: "/api/test/listing", cookies })).json();
    expect(r).toMatchObject({ state: "entwurf", draft: true, telegram: true, activeProfile: true });
    expect(notify).toHaveBeenCalledWith(r.id);
    expect(db.prepare("SELECT portal FROM listings").get()).toEqual({ portal: "test" });
  });

  it("ohne Profil: Test-Inserat bleibt ohne Entwurf, Antwort sagt warum", async () => {
    const { app, cookies } = await setup(fakeHub());
    const r = (await app.inject({ method: "POST", url: "/api/test/listing", cookies })).json();
    expect(r).toMatchObject({ state: "gefiltert", draft: false, telegram: false, activeProfile: false });
  });
});

describe("Telegram-Einstellungen per API", () => {
  it("speichern ruft apply auf (Token wird nie zurückgegeben); Fehler werden gemeldet", async () => {
    const apply = vi.fn().mockResolvedValue({ bot: "@mein_bot" });
    const { app, cookies } = await setup(fakeHub({ apply }));
    const put = (payload: object) => app.inject({ method: "PUT", url: "/api/telegram", cookies, payload });
    const ok = await put({ token: "123:ABC", chatId: "42" });
    expect(ok.json()).toEqual({ bot: "@mein_bot" });
    expect(apply).toHaveBeenCalledWith("123:ABC", "42");
    expect(JSON.stringify(ok.json())).not.toContain("123:ABC");
    expect((await put({ chatId: "42" })).statusCode).toBe(200); // Token leer = gespeicherten behalten
    expect(apply).toHaveBeenLastCalledWith(undefined, "42");
    expect((await put({ token: "x" })).statusCode).toBe(400); // Chat-ID fehlt (Validierung)

    apply.mockRejectedValueOnce(new Error("Der Token ist ungültig"));
    const bad = await put({ token: "falsch", chatId: "42" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("Der Token ist ungültig");
  });

  it("Chat-ID finden", async () => {
    const { app, cookies } = await setup(fakeHub({ findChats: async () => [{ id: "8308947321", name: "André" }] }));
    expect((await app.inject({ method: "POST", url: "/api/telegram/find-chat", cookies, payload: { token: "t" } })).json()).toEqual({ chats: [{ id: "8308947321", name: "André" }] });
  });
});
