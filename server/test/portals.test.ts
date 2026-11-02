import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { detectState } from "../src/portals/detect.js";
import { SessionMonitor } from "../src/portals/monitor.js";
import { mockPortal } from "../src/portals/defs.js";
import { cdpWithPage } from "../src/portals/cdp.js";
import type { PageLike, PortalState } from "../src/portals/types.js";

process.env.NODE_ENV = "test";
const sel = mockPortal("http://x").selectors!;
const fakePage = (present: string[]): PageLike => ({ locator: (s) => ({ count: async () => (present.includes(s) ? 1 : 0) }) });

describe("detectState", () => {
  it.each<[string, string[], PortalState]>([
    ["eingeloggt", [sel.loggedIn], "ok"],
    ["Login-Formular", [sel.loggedOut], "session_expired"],
    ["Captcha schlägt Login-Formular", [sel.interaction, sel.loggedOut], "interaction_required"],
    ["unbekannte Seite", [], "error"],
  ])("%s", async (_n, present, want) => expect((await detectState(fakePage(present), sel)).state).toBe(want));

  it("unkalibrierte Selektoren → error, nie ok", async () => {
    expect(await detectState(fakePage([sel.loggedIn]), null)).toMatchObject({ state: "error", detail: expect.stringContaining("kalibriert") });
  });
});

describe("SessionMonitor", () => {
  let pageHas: string[];
  let fail: boolean;
  const msgs: string[] = [];
  const mk = (rand?: () => number) => new SessionMonitor(openDb(":memory:"), [mockPortal("http://x")], async (_u, fn) => {
    if (fail) throw new Error("Browser nicht erreichbar");
    return fn(fakePage(pageHas) as never);
  }, async (t) => void msgs.push(t), "http://app/browser", rand);
  beforeEach(() => { pageHas = [sel.loggedIn]; fail = false; msgs.length = 0; });

  it("erste Messung ok ist still; Wechsel melden genau einmal", async () => {
    const m = mk();
    await m.check("mock");
    expect(msgs).toEqual([]);
    pageHas = [sel.loggedOut];
    await m.check("mock");
    await m.check("mock"); // gleicher Zustand: keine zweite Nachricht
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/abgelaufen.*http:\/\/app\/browser/);
    pageHas = [sel.loggedIn];
    await m.check("mock");
    expect(msgs[1]).toMatch(/wieder angemeldet/);
  });

  it("Captcha wird gemeldet", async () => {
    const m = mk();
    pageHas = [sel.interaction];
    expect((await m.check("mock")).state).toBe("interaction_required");
    expect(msgs[0]).toMatch(/Captcha/);
  });

  it("ein einzelner Verbindungsfehler ändert den Zustand nicht, der zweite schon", async () => {
    const m = mk();
    await m.check("mock");
    fail = true;
    expect((await m.check("mock")).state).toBe("ok");
    expect((await m.check("mock")).state).toBe("error");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/fehlgeschlagen/);
  });

  it("Zeitplan: 30-60 Minuten", async () => {
    vi.useFakeTimers();
    const m = mk(() => 0.5); // deterministisch: erste Prüfung nach 3 Min, danach alle 45 Min
    const spy = vi.spyOn(m, "check").mockResolvedValue({} as never);
    m.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1); // Start-Versatz 1 bis 5 Min
    await vi.advanceTimersByTimeAsync(29 * 60_000); // bis Minute 34
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31 * 60_000); // bis Minute 65
    expect(spy).toHaveBeenCalledTimes(2);
    m.stop();
    vi.useRealTimers();
  });
});

describe("API und /browser-Proxy", () => {
  let upstream: Server;
  afterEach(() => upstream?.close());

  it("Proxy nur mit Login, Portal-API ohne Monitor", async () => {
    upstream = createServer((req, res) => res.end("noVNC:" + req.url));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const app = await buildApp(loadConfig({ APP_SECRET: "x".repeat(32), INGEST_TOKEN: "t".repeat(24), BROWSER_VNC_URL: url }), openDb(":memory:"), { webDir: "/nonexistent" });

    expect((await app.inject({ url: "/browser/vnc.html" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/portals" })).statusCode).toBe(401);

    const s = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
    const cookies = { [s.cookies[0]!.name]: s.cookies[0]!.value };
    const r = await app.inject({ url: "/browser/vnc.html", cookies });
    expect(r.body).toBe("noVNC:/vnc.html");
    expect((await app.inject({ url: "/api/portals", cookies })).json()).toMatchObject({ monitoring: false, portals: [] });
    expect((await app.inject({ method: "POST", url: "/api/portals/mock/check", cookies })).statusCode).toBe(409);
  });
});

// Echter Browser per CDP. Laufen lassen mit laufendem Dev-Stack:
//   docker compose -f docker-compose.dev.yml up -d browser mock-portal   dann   E2E_BROWSER=1 npm test
describe.skipIf(!process.env.E2E_BROWSER)("Monitor gegen echten Browser + Mock-Portal", () => {
  it("ok → Ablauf → Captcha → wieder ok", async () => {
    const ctl = (p: string) => fetch("http://localhost:4000/" + p);
    const msgs: string[] = [];
    const m = new SessionMonitor(openDb(":memory:"), [mockPortal("http://mock-portal:4000")], cdpWithPage("http://localhost:9223"), async (t) => void msgs.push(t), "http://app/browser");

    await ctl("__clear"); await ctl("__login");
    expect((await m.check("mock")).state).toBe("ok");
    await ctl("__expire");
    expect((await m.check("mock")).state).toBe("session_expired");
    await ctl("__captcha");
    expect((await m.check("mock")).state).toBe("interaction_required");
    await ctl("__clear"); await ctl("__login");
    expect((await m.check("mock")).state).toBe("ok");
    expect(msgs).toHaveLength(3);
  }, 90_000);
});
