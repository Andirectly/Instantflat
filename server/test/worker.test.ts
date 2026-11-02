import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { ingest } from "../src/ingest.js";
import { createProfile, profileSchema } from "../src/profiles.js";
import { approveDraft, createDraft, templateGenerator } from "../src/draft.js";
import { enqueue, getDailyLimit, isNight, setDailyLimit } from "../src/outbox.js";
import { mockPortal } from "../src/portals/defs.js";
import { SendError } from "../src/portals/sender.js";
import { Worker } from "../src/worker.js";
import type { PortalDef } from "../src/portals/types.js";

const send = vi.hoisted(() => vi.fn());
const report = vi.hoisted(() => vi.fn());
vi.mock("../src/portals/sender.js", async (orig) => ({ ...(await orig<typeof import("../src/portals/sender.js")>()), sendMessage: send }));

const DAY = new Date("2026-11-02T10:00:00+01:00");
const at = (min: number) => new Date(DAY.getTime() + min * 60_000);
const defA: PortalDef = { ...mockPortal("http://a"), id: "immoscout24", name: "A" };
const defB: PortalDef = { ...mockPortal("http://b"), id: "immowelt", name: "B" };

async function setup(n: { portal: string; count: number }[] = [{ portal: "immoscout24", count: 1 }], dryRun = false, defs = [defA, defB]) {
  const db = openDb(":memory:");
  createProfile(db, "P", profileSchema.parse({ fullName: "Max M" }));
  let i = 0;
  for (const { portal, count } of n) {
    for (let k = 0; k < count; k++) {
      const id = ++i;
      ingest(db, { provider: portal, listings: [{ id: String(id), title: `Wohnung ${id}`, url: `http://x/expose/${id}` }] });
      await createDraft(db, templateGenerator, id);
      approveDraft(db, id);
    }
  }
  const state = { value: "ok" };
  const notes: string[] = [];
  const mk = (dry = dryRun) => new Worker(db, defs, { report, status: () => defs.map((d) => ({ portal: d.id, name: d.name, state: state.value as "ok", detail: null, checkedAt: null, since: null })) },
    (async (_u: string, fn: (p: unknown) => unknown) => fn({})) as never, { dryRun: dry, shotDir: mkdtempSync(join(tmpdir(), "if-")), notify: async (t) => void notes.push(t), rand: () => 0.5 });
  return { db, state, notes, worker: mk(), mk };
}
const okSend = () => send.mockResolvedValue({ result: "sent", shots: [Buffer.from("png")] });
const status = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT id, status FROM outbox ORDER BY id").all() as { id: number; status: string }[]).map((r) => r.status);

beforeEach(() => { send.mockReset(); report.mockReset(); okSend(); });

describe("Outbox", () => {
  it("doppelte Freigabe erzeugt nur einen Eintrag", async () => {
    const { db } = await setup();
    enqueue(db, 1); enqueue(db, 1);
    expect(db.prepare("SELECT count(*) c FROM outbox").get()).toEqual({ c: 1 });
  });
  it("Nachtruhe 22-7 Uhr (Berlin), Standardlimit 7", () => {
    expect(isNight(new Date("2026-11-02T22:30:00+01:00"))).toBe(true);
    expect(isNight(new Date("2026-11-02T06:59:00+01:00"))).toBe(true);
    expect(isNight(new Date("2026-11-02T07:00:00+01:00"))).toBe(false);
    expect(getDailyLimit(openDb(":memory:"))).toBe(7);
  });
});

describe("Worker", () => {
  it("sendet tagsüber, nachts nicht; Status und Log stimmen", async () => {
    const { db, worker, notes } = await setup();
    expect(await worker.tick(new Date("2026-11-02T23:00:00+01:00"))).toBe("night");
    expect(await worker.tick(DAY)).toBe("sent");
    expect(db.prepare("SELECT state FROM listings WHERE id = 1").get()).toEqual({ state: "gesendet" });
    expect(db.prepare("SELECT result, dry_run FROM send_log").get()).toEqual({ result: "ok", dry_run: 0 });
    expect(notes[0]).toMatch(/Gesendet/);
    expect(await worker.tick(at(60))).toBe("idle"); // nichts mehr in der Queue
  });

  it("Pause 2-8 Minuten pro Plattform zwischen zwei Nachrichten", async () => {
    const { worker } = await setup([{ portal: "immoscout24", count: 2 }]);
    expect(await worker.tick(DAY)).toBe("sent");
    expect(await worker.tick(at(1))).toBe("idle"); // zu früh (Pause hier 5 Min)
    expect(await worker.tick(at(9))).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("Tageslimit gilt pro Plattform", async () => {
    const { db, worker } = await setup([{ portal: "immoscout24", count: 3 }, { portal: "immowelt", count: 1 }]);
    setDailyLimit(db, 2);
    const r: string[] = [];
    for (let m = 0; m <= 60; m += 10) r.push(await worker.tick(at(m)));
    // A: 2 Stück, B: 1 Stück, das dritte A bleibt wegen Limit liegen
    expect(r.filter((x) => x === "sent")).toHaveLength(3);
    expect(status(db)).toEqual(["sent", "sent", "queued", "sent"]);
    // am nächsten Berliner Tag geht der Rest raus
    expect(await worker.tick(at(24 * 60))).toBe("sent");
  });

  it("Session-Verlust hält die Queue an, danach chronologisch weiter", async () => {
    const { db, worker, state } = await setup([{ portal: "immoscout24", count: 2 }]);
    state.value = "session_expired";
    expect(await worker.tick(DAY)).toBe("idle");
    state.value = "ok";
    await worker.tick(at(10));
    expect(send.mock.calls).toHaveLength(1);
    expect(status(db)).toEqual(["sent", "queued"]); // ältester zuerst
  });

  it("unkalibriertes Portal wird übersprungen, andere laufen weiter", async () => {
    const { db, worker } = await setup([{ portal: "immoscout24", count: 1 }, { portal: "immowelt", count: 1 }], false, [{ ...defA, send: null }, defB]);
    expect(await worker.tick(DAY)).toBe("sent");
    expect(status(db)).toEqual(["queued", "sent"]);
  });

  it("Dry-Run sendet nicht; im echten Betrieb wird nachgeholt", async () => {
    const { db, mk } = await setup([{ portal: "immoscout24", count: 1 }], true);
    send.mockResolvedValue({ result: "dry_run", shots: [Buffer.from("png")] });
    expect(await mk(true).tick(DAY)).toBe("dry_run");
    expect(status(db)).toEqual(["dry_done"]);
    expect(db.prepare("SELECT state FROM listings WHERE id = 1").get()).toEqual({ state: "freigegeben" });
    expect(await mk(true).tick(at(30))).toBe("idle"); // Dry-Run wiederholt sich nicht
    okSend();
    expect(await mk(false).tick(at(60))).toBe("sent"); // DRY_RUN=false: jetzt wirklich
    expect(status(db)).toEqual(["sent"]);
  });

  it("Dry-Run-Versuche verbrauchen das echte Tageslimit nicht", async () => {
    const { db, mk } = await setup([{ portal: "immoscout24", count: 1 }], true);
    setDailyLimit(db, 1);
    send.mockResolvedValue({ result: "dry_run", shots: [Buffer.from("png")] });
    await mk(true).tick(DAY);
    okSend();
    expect(await mk(false).tick(at(30))).toBe("sent");
  });

  it("Absturz im Versand → unknown, wird nie automatisch wiederholt", async () => {
    const { db, worker } = await setup();
    db.prepare("UPDATE outbox SET status = 'sending'").run();
    expect(worker.recover()).toBe(1);
    expect(await worker.tick(DAY)).toBe("idle");
    expect(send).not.toHaveBeenCalled();
    expect(status(db)).toEqual(["unknown"]);
  });

  it("Fehler nach dem Klick → unknown (kein zweiter Versuch)", async () => {
    const { db, worker, notes } = await setup();
    send.mockRejectedValue(new SendError("Keine Bestätigung", "after"));
    expect(await worker.tick(DAY)).toBe("unknown");
    expect(await worker.tick(at(30))).toBe("idle");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notes[0]).toMatch(/unklar/);
    expect(status(db)).toEqual(["unknown"]);
  });

  it("Fehler vor dem Klick → bis zu 3 Versuche, dann failed", async () => {
    const { db, worker } = await setup();
    send.mockRejectedValue(new SendError("Formular fehlt", "before"));
    expect(await worker.tick(DAY)).toBe("requeued");
    expect(await worker.tick(at(10))).toBe("requeued");
    expect(await worker.tick(at(20))).toBe("failed");
    expect(await worker.tick(at(30))).toBe("idle");
    expect(status(db)).toEqual(["failed"]);
  });

  it("Externes Inserat (retry=false) → sofort failed, kein zweiter Versuch", async () => {
    const { db, worker } = await setup();
    send.mockRejectedValue(new SendError("Externe Seite", "before", false));
    expect(await worker.tick(DAY)).toBe("failed");
    expect(status(db)).toEqual(["failed"]);
  });

  it("Captcha beim Senden: kein Fehlversuch, Eintrag bleibt in der Queue, Portal wird gemeldet", async () => {
    const { db, worker } = await setup();
    send.mockRejectedValue(new SendError("Portalzustand: interaction_required", "before", true, "interaction_required"));
    expect(await worker.tick(DAY)).toBe("blocked");
    expect(db.prepare("SELECT status, attempts, last_error AS e FROM outbox").get()).toEqual({ status: "queued", attempts: 0, e: "Portalzustand: interaction_required" });
    expect(report).toHaveBeenCalledWith("immoscout24", "interaction_required", "http://x/expose/1");
    expect(db.prepare("SELECT result FROM send_log").get()).toEqual({ result: "blocked" });
    // beliebig oft blockiert, nie "failed"
    for (let i = 1; i <= 4; i++) expect(await worker.tick(at(i * 10))).toBe("blocked");
    expect(status(db)).toEqual(["queued"]);
  });

  it("Abmeldung beim Senden wird genauso gemeldet", async () => {
    const { worker } = await setup();
    send.mockRejectedValue(new SendError("Portalzustand: session_expired", "before", true, "session_expired"));
    expect(await worker.tick(DAY)).toBe("blocked");
    expect(report).toHaveBeenCalledWith("immoscout24", "session_expired", "http://x/expose/1");
  });

  it("Screenshots werden gespeichert", async () => {
    const { db, worker } = await setup();
    await worker.tick(DAY);
    const shots = JSON.parse((db.prepare("SELECT shots FROM send_log").get() as { shots: string }).shots) as string[];
    expect(shots).toEqual(["1-1.png"]);
    expect(existsSync(join((worker as unknown as { opts: { shotDir: string } }).opts.shotDir, shots[0]!))).toBe(true);
  });
});
