import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { inspectPortal, type Inspector } from "../src/portals/inspect.js";
import { mockPortal } from "../src/portals/defs.js";

process.env.NODE_ENV = "test";
const env = { APP_SECRET: "x".repeat(32), INGEST_TOKEN: "t".repeat(24) };

async function setup(inspector?: Inspector) {
  const app = await buildApp(loadConfig(env), openDb(":memory:"), { webDir: "/nonexistent", inspector });
  const s = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
  return { app, cookies: { [s.cookies[0]!.name]: s.cookies[0]!.value } };
}

describe("Inspektor-API", () => {
  it("nur mit Login; ohne Browser 409; reicht Optionen weiter; Fehler als 502", async () => {
    const none = await setup();
    expect((await none.app.inject({ method: "POST", url: "/api/portals/mock/inspect", payload: {} })).statusCode).toBe(401);
    expect((await none.app.inject({ method: "POST", url: "/api/portals/mock/inspect", cookies: none.cookies, payload: {} })).statusCode).toBe(409);

    const insp = vi.fn<Inspector>().mockResolvedValue({ tabs: [{ url: "https://x/", title: "T" }], tab: null });
    const a = await setup(insp);
    const r = await a.app.inject({ method: "POST", url: "/api/portals/kleinanzeigen/inspect", cookies: a.cookies, payload: { match: "/s-anzeige/", compare: true } });
    expect(r.json()).toEqual({ tabs: [{ url: "https://x/", title: "T" }], tab: null });
    expect(insp).toHaveBeenCalledWith("kleinanzeigen", { match: "/s-anzeige/", compare: true });

    insp.mockRejectedValueOnce(new Error("Unbekanntes Portal"));
    expect((await a.app.inject({ method: "POST", url: "/api/portals/x/inspect", cookies: a.cookies, payload: {} })).statusCode).toBe(502);
  });
});

// Echter Browser (Dev-Stack: docker compose -f docker-compose.dev.yml up -d browser mock-portal), E2E_BROWSER=1
describe.skipIf(!process.env.E2E_BROWSER)("inspectPortal gegen echten Browser", () => {
  it("beschreibt die offene Mock-Seite und vergleicht mit dem ausgeloggten Besuch", async () => {
    const ctl = (p: string) => fetch("http://localhost:4000/" + p);
    await ctl("__clear"); await ctl("__login");
    const def = mockPortal("http://mock-portal:4000");
    const { chromium } = await import("playwright-core");
    const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
    const page = await (b.contexts()[0] ?? (await b.newContext())).newPage();
    await page.goto("http://mock-portal:4000/expose/1");
    try {
      const r = await inspectPortal("http://localhost:9223", def, { match: "mock-portal", compare: true });
      expect(r.tabs.some((t) => t.url.includes("/expose/1"))).toBe(true);
      expect(r.tab!.textareas).toHaveLength(1);
      expect(JSON.stringify(r.tab!.buttons)).toContain("Senden");
      // Mock-Server ist ein globaler Zustand ohne Cookies, daher sind beide Besuche gleich: Struktur vorhanden, Vergleich liefert Listen
      expect(r.compare).toMatchObject({ onlyLoggedIn: expect.any(Array), onlyLoggedOut: expect.any(Array) });
    } finally {
      await page.close();
      await b.close();
    }
  }, 90_000);
});
