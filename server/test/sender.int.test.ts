import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ingest } from "../src/ingest.js";
import { createProfile, profileSchema } from "../src/profiles.js";
import { approveDraft, createDraft, templateGenerator } from "../src/draft.js";
import { mockPortal } from "../src/portals/defs.js";
import { cdpWithPage } from "../src/portals/cdp.js";
import { INSTANT_PACE } from "../src/portals/sender.js";
import { Worker } from "../src/worker.js";

// Echter Chromium per CDP gegen das Mock-Portal:
//   docker compose -f docker-compose.dev.yml up -d browser mock-portal   dann   E2E_BROWSER=1 npm test
describe.skipIf(!process.env.E2E_BROWSER)("Absender gegen echten Browser + Mock-Portal", () => {
  const ctl = (p: string) => fetch("http://localhost:4000/" + p);
  const sent = async () => (await (await ctl("__sent")).json()) as { id: string; message: string }[];
  const def = mockPortal("http://mock-portal:4000");
  const day = new Date("2026-11-02T10:00:00+01:00");

  async function setup(dryRun: boolean, listing = "1", d = def) {
    const db = openDb(":memory:");
    createProfile(db, "P", profileSchema.parse({ fullName: "Max Muster", job: "Videograf" }));
    ingest(db, { provider: "mock", listings: [{ id: listing, title: "Helle 3-Zimmer-Wohnung mit Balkon", address: "Ehrenfeld, Köln", url: `http://mock-portal:4000/expose/${listing}` }] });
    await createDraft(db, templateGenerator, 1);
    approveDraft(db, 1);
    const status = [{ portal: "mock", name: "Mock", state: "ok" as const, detail: null, checkedAt: null, since: null }];
    const shotDir = mkdtempSync(join(tmpdir(), "if-shots-"));
    const worker = new Worker(db, [d], { status: () => status }, cdpWithPage("http://localhost:9223"), { dryRun, shotDir, notify: async () => {}, pace: INSTANT_PACE, rand: () => 0.5 });
    return { db, worker };
  }

  it("Dry-Run füllt aus und sendet nichts; echter Lauf sendet genau einmal", async () => {
    await ctl("__clear"); await ctl("__login"); await ctl("__reset");

    const dry = await setup(true);
    expect(await dry.worker.tick(day)).toBe("dry_run");
    expect(await sent()).toEqual([]);
    expect(dry.db.prepare("SELECT status FROM outbox").get()).toEqual({ status: "dry_done" });

    const real = await setup(false);
    expect(await real.worker.tick(day)).toBe("sent");
    const got = await sent();
    expect(got).toHaveLength(1);
    expect(got[0]!.message).toContain("Max Muster");

    // Nochmal laufen lassen: nichts Neues in der Queue, kein zweiter Versand
    expect(await real.worker.tick(new Date(day.getTime() + 3_600_000))).toBe("idle");
    expect(await sent()).toHaveLength(1);
  }, 120_000);

  it("Formular hinter Öffner-Knopf (Interesse bekunden): klickt, tippt, sendet einmal", async () => {
    await ctl("__clear"); await ctl("__login"); await ctl("__reset");
    const d = { ...def, send: { ...def.send!, opener: "#open-contact" } };
    const { worker } = await setup(false, "2", d);
    expect(await worker.tick(day)).toBe("sent");
    expect(await sent()).toHaveLength(1);
  }, 120_000);

  it("abgelaufene Session: Eintrag bleibt in der Queue (kein Fehlversuch), nichts wird gesendet", async () => {
    await ctl("__expire"); await ctl("__reset");
    const { worker, db } = await setup(false);
    expect(await worker.tick(day)).toBe("blocked");
    expect(await sent()).toEqual([]);
    expect(db.prepare("SELECT status, attempts FROM outbox").get()).toEqual({ status: "queued", attempts: 0 });
    expect((db.prepare("SELECT last_error FROM outbox").get() as { last_error: string }).last_error).toMatch(/session_expired/);
    await ctl("__login");
  }, 120_000);
});
