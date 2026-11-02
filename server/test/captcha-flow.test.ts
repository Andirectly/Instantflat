import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { SessionMonitor } from "../src/portals/monitor.js";
import { mockPortal } from "../src/portals/defs.js";
import { getKv } from "../src/outbox.js";

const def = mockPortal("http://x");
const LISTING = "http://x/expose/7";

function setup(opts: { openTab?: boolean; rand?: () => number } = {}) {
  const db = openDb(":memory:");
  const msgs: string[] = [];
  const opened: string[] = [];
  const page = { has: new Set<string>(), seen: [] as string[] };
  const withPage = (async (url: string, fn: (p: unknown) => unknown) => {
    page.seen.push(url);
    return fn({ locator: (s: string) => ({ count: async () => (s.split(",").map((x) => x.trim()).some((x) => page.has.has(x)) ? 1 : 0) }) });
  }) as never;
  const m = new SessionMonitor(db, [def], withPage, async (t) => void msgs.push(t), "http://app/browser", opts.rand, opts.openTab === false ? undefined : async (u) => void opened.push(u));
  return { db, m, msgs, opened, page };
}

afterEach(() => vi.useRealTimers());

describe("Captcha beim Senden: melden, Tab öffnen, selbstständig weitermachen", () => {
  it("report: Zustand gesetzt, Telegram mit Link, Tab geöffnet, Adresse gemerkt", async () => {
    const { m, db, msgs, opened } = setup();
    await m.report("mock", "interaction_required", LISTING);
    expect(m.status()[0]!.state).toBe("interaction_required");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/verlangt eine Eingabe/);
    expect(msgs[0]).toContain("http://app/browser");
    expect(msgs[0]).toMatch(/Tab ist im Server-Browser schon geöffnet/);
    expect(opened).toEqual([LISTING]);
    expect(getKv(db, "blocked:mock")).toBe(LISTING);
  });

  it("ohne Tab-Funktion fehlt der Hinweis auf den offenen Tab; Abmeldung öffnet keinen Tab", async () => {
    const a = setup({ openTab: false });
    await a.m.report("mock", "interaction_required", LISTING);
    expect(a.msgs[0]).not.toMatch(/Tab ist/);
    const b = setup();
    await b.m.report("mock", "session_expired", LISTING);
    expect(b.msgs[0]).toMatch(/Session abgelaufen/);
    expect(b.opened).toEqual([]);
  });

  it("Prüfung läuft auf der gesperrten Seite: solange das Captcha da ist, keine neue Nachricht; danach ok und Worker-frei", async () => {
    const { m, db, msgs, page } = setup();
    await m.report("mock", "interaction_required", LISTING);
    msgs.length = 0;
    page.has = new Set(["#captcha"]);
    expect((await m.check("mock")).state).toBe("interaction_required");
    expect(page.seen.at(-1)).toBe(LISTING); // nicht die Kontoseite
    expect(msgs).toEqual([]); // kein Spam
    page.has = new Set(); // Captcha gelöst
    expect((await m.check("mock")).state).toBe("ok");
    expect(msgs).toEqual(["✅ Mock-Portal: wieder angemeldet."]);
    expect(getKv(db, "blocked:mock")).toBeUndefined();
    page.has = new Set(["#account"]);
    await m.check("mock");
    expect(page.seen.at(-1)).toBe("http://x"); // wieder die normale Kontoseite
  });

  it("gesperrte Portale werden alle 3-5 Minuten geprüft, angemeldete alle 30-60", async () => {
    vi.useFakeTimers();
    const { m, page } = setup({ rand: () => 0.5 });
    const spy = vi.spyOn(m, "check");
    await m.report("mock", "interaction_required", LISTING);
    page.has = new Set(["#captcha"]); // das Captcha ist noch da
    m.start(); // erste Prüfung nach 3 Min
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000); // gesperrt: nächste nach 4 Min
    expect(spy).toHaveBeenCalledTimes(2);
    page.has = new Set(); // gelöst
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(spy).toHaveBeenCalledTimes(3); // jetzt ok
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(spy).toHaveBeenCalledTimes(3); // angemeldet: erst nach 45 Min
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(spy).toHaveBeenCalledTimes(4);
    m.stop();
  });
});
