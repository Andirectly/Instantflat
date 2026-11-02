import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSecrets } from "../src/secrets.js";
import { loadConfig } from "../src/config.js";

const dir = () => mkdtempSync(join(tmpdir(), "if-sec-"));

describe("ensureSecrets", () => {
  it("erzeugt fehlende Secrets, speichert sie und nutzt sie beim nächsten Start wieder", () => {
    const d = dir();
    const a = ensureSecrets({}, d);
    expect(a.APP_SECRET).toHaveLength(64);
    expect(a.INGEST_TOKEN).toHaveLength(48);
    expect(() => loadConfig(a)).not.toThrow(); // erfüllt die Längenprüfung der Konfiguration
    const b = ensureSecrets({}, d);
    expect(b).toEqual(a);
    expect(JSON.parse(readFileSync(join(d, "secrets.json"), "utf8"))).toMatchObject({ APP_SECRET: a.APP_SECRET });
    if (process.platform !== "win32") expect(statSync(join(d, "secrets.json")).mode & 0o077).toBe(0);
  });
  it("gesetzte Variablen haben Vorrang, nur Fehlendes wird ergänzt", () => {
    const d = dir();
    const r = ensureSecrets({ APP_SECRET: "x".repeat(40) }, d);
    expect(r.APP_SECRET).toBe("x".repeat(40));
    expect(r.INGEST_TOKEN).toHaveLength(48);
  });
  it("beide gesetzt: keine Datei", () => {
    const d = dir();
    ensureSecrets({ APP_SECRET: "a".repeat(32), INGEST_TOKEN: "b".repeat(20) }, d);
    expect(() => readFileSync(join(d, "secrets.json"))).toThrow();
  });
});
