import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { openDb } from "../src/db.js";
import { ingest } from "../src/ingest.js";
import { createProfile, profileSchema } from "../src/profiles.js";
import { approveDraft, createDraft, templateGenerator } from "../src/draft.js";
import { mockPortal } from "../src/portals/defs.js";
import { cdpOpenTab, cdpWithPage } from "../src/portals/cdp.js";
import { SessionMonitor } from "../src/portals/monitor.js";
import { INSTANT_PACE } from "../src/portals/sender.js";
import { Worker } from "../src/worker.js";

// Echter Chromium: docker compose -f docker-compose.dev.yml up -d browser mock-portal, dann E2E_BROWSER=1 npm test
describe.skipIf(!process.env.E2E_BROWSER)("Captcha beim Senden mit echtem Browser", () => {
  const ctl = (p: string) => fetch("http://localhost:4000/" + p);
  const day = new Date("2026-11-02T10:00:00+01:00");
  const def = mockPortal("http://mock-portal:4000");

  it("blockiert, öffnet den Tab, meldet per Telegram, läuft nach dem Lösen von selbst weiter und sendet genau einmal", async () => {
    await ctl("__login"); await ctl("__reset"); await ctl("__captcha"); // Captcha auf allen Seiten
    const db = openDb(":memory:");
    createProfile(db, "P", profileSchema.parse({ fullName: "Max Muster" }));
    ingest(db, { provider: "mock", listings: [{ id: "1", title: "Helle Wohnung", address: "Köln", url: "http://mock-portal:4000/expose/1" }] });
    await createDraft(db, templateGenerator, 1);
    approveDraft(db, 1);

    const msgs: string[] = [];
    const cdp = "http://localhost:9223";
    const withPage = cdpWithPage(cdp);
    const monitor = new SessionMonitor(db, [def], withPage, async (t) => void msgs.push(t), "http://app/browser", () => 0.5, cdpOpenTab(cdp));
    // Das Portal gilt zunächst als angemeldet (Kontoseite hat kein Captcha, hier zeigt sie eins: zuerst Captcha weg)
    await ctl("__clear");
    expect((await monitor.check("mock")).state).toBe("ok");
    await ctl("__captcha");

    const worker = new Worker(db, [def], monitor, withPage, { dryRun: false, shotDir: mkdtempSync(join(tmpdir(), "if-cap-")), notify: async () => {}, pace: INSTANT_PACE, rand: () => 0.5 });
    expect(await worker.tick(day)).toBe("blocked");
    expect(db.prepare("SELECT status, attempts FROM outbox").get()).toEqual({ status: "queued", attempts: 0 });
    expect(monitor.status()[0]!.state).toBe("interaction_required");
    expect(msgs.at(-1)).toMatch(/verlangt eine Eingabe[\s\S]*http:\/\/app\/browser/);

    // Der Tab mit dem Captcha liegt offen im Server-Browser
    const b = await chromium.connectOverCDP(cdp);
    try {
      const open = b.contexts()[0]!.pages().filter((p) => p.url().includes("/expose/1"));
      expect(open.length).toBeGreaterThanOrEqual(1);
      expect(await open[0]!.locator("#captcha").count()).toBe(1);
    } finally {
      await b.close();
    }

    // Solange das Captcha da ist, bleibt es gesperrt und der Worker wartet
    expect((await monitor.check("mock")).state).toBe("interaction_required");
    expect(await worker.tick(new Date(day.getTime() + 3_600_000))).toBe("idle");
    expect(msgs.filter((m) => /verlangt eine Eingabe/.test(m))).toHaveLength(1); // keine Wiederholung

    // Du löst es: nächste Prüfung gibt frei, der Worker sendet
    await ctl("__clear");
    expect((await monitor.check("mock")).state).toBe("ok");
    expect(msgs.at(-1)).toMatch(/wieder angemeldet/);
    expect(await worker.tick(new Date(day.getTime() + 7_200_000))).toBe("sent");
    expect(await (await ctl("__sent")).json()).toHaveLength(1);

    // aufräumen: offene Test-Tabs schließen
    const c = await chromium.connectOverCDP(cdp);
    for (const p of c.contexts()[0]!.pages()) if (p.url().includes("mock-portal")) await p.close();
    await c.close();
  }, 120_000);
});
