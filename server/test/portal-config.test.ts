import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { loadPortalDefs } from "../src/portals/config.js";
import { REAL_PORTALS } from "../src/portals/defs.js";
import { SessionMonitor } from "../src/portals/monitor.js";

const dir = mkdtempSync(join(tmpdir(), "if-cfg-"));
const write = (name: string, content: unknown) => { const f = join(dir, name); writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content)); return f; };

describe("loadPortalDefs", () => {
  it("fehlende Datei: Standardwerte (unkalibriert)", () => {
    expect(loadPortalDefs(REAL_PORTALS, join(dir, "gibt-es-nicht.json")).every((d) => d.selectors === null && d.send === null)).toBe(true);
  });

  it("überschreibt Selektoren und Formular nur für das genannte Portal", () => {
    const f = write("ok.json", { immoscout24: { selectors: { loggedIn: "#konto", loggedOut: "#login", interaction: "#captcha" }, send: { message: "#msg", submit: "#go", success: "#ok" } } });
    const defs = loadPortalDefs(REAL_PORTALS, f);
    expect(defs.find((d) => d.id === "immoscout24")).toMatchObject({ selectors: { loggedIn: "#konto" }, send: { submit: "#go" }, url: "https://www.immobilienscout24.de/" });
    expect(defs.find((d) => d.id === "immowelt")!.selectors).toBeNull();
  });

  it("verständliche Fehler bei kaputter Datei", () => {
    expect(() => loadPortalDefs(REAL_PORTALS, write("a.json", "{kaputt"))).toThrow(/kein gültiges JSON/);
    expect(() => loadPortalDefs(REAL_PORTALS, write("b.json", { nixda: {} }))).toThrow(/unbekannte Portal-ID.*nixda/);
    expect(() => loadPortalDefs(REAL_PORTALS, write("c.json", { immowelt: { selectors: { loggedIn: "", loggedOut: "x", interaction: "y" } } }))).toThrow(/immowelt\.selectors\.loggedIn/);
    expect(() => loadPortalDefs(REAL_PORTALS, write("d.json", { immowelt: { tippfehler: 1 } }))).toThrow();
  });
});

describe("SessionMonitor.probe", () => {
  it("zählt jeden Selektor auf der geladenen Seite", async () => {
    const def = { ...REAL_PORTALS[0]!, selectors: { loggedIn: "#a", loggedOut: "#b", interaction: "#c" }, send: { message: "#m", submit: "#s", success: "#ok" } };
    const page = { url: () => "https://x/seite", title: async () => "Titel", locator: (s: string) => ({ count: async () => (s === "#a" ? 2 : 0) }) };
    const seen: string[] = [];
    const m = new SessionMonitor(openDb(":memory:"), [def], (async (u: string, fn: (p: unknown) => unknown) => (seen.push(u), fn(page))) as never, async () => {}, "x");
    const r = await m.probe("immoscout24", "https://x/seite");
    expect(seen).toEqual(["https://x/seite"]);
    expect(r).toMatchObject({ url: "https://x/seite", title: "Titel", counts: { loggedIn: 2, loggedOut: 0, interaction: 0, message: 0, submit: 0, success: 0 } });
  });
  it("zusätzliche Selektoren werden mitgezählt", async () => {
    const page = { url: () => "u", title: async () => "t", locator: (s: string) => ({ count: async () => (s === "#x" ? 3 : 0) }) };
    const m = new SessionMonitor(openDb(":memory:"), [REAL_PORTALS[0]!], (async (_u: string, fn: (p: unknown) => unknown) => fn(page)) as never, async () => {}, "x");
    expect((await m.probe("immoscout24", undefined, { eigener: "#x" })).counts).toEqual({ eigener: 3 });
  });

  it("unkalibriertes Portal: leere Zählung statt Fehler", async () => {
    const m = new SessionMonitor(openDb(":memory:"), [REAL_PORTALS[0]!], (async (_u: string, fn: (p: unknown) => unknown) => fn({ url: () => "u", title: async () => "t", locator: () => ({ count: async () => 0 }) })) as never, async () => {}, "x");
    expect((await m.probe("immoscout24")).counts).toEqual({});
  });
});
