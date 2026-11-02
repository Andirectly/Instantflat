import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fehlen APP_SECRET oder INGEST_TOKEN (z. B. bei einer Custom-App-Installation ohne .env), werden sie beim ersten Start
 * erzeugt und in DATA_DIR/secrets.json abgelegt (nur für den Besitzer lesbar) und danach wiederverwendet.
 * Gesetzte Umgebungsvariablen haben immer Vorrang.
 */
export function ensureSecrets(env: Record<string, string | undefined>, dataDir: string): Record<string, string | undefined> {
  const need = (k: string) => !env[k];
  if (!need("APP_SECRET") && !need("INGEST_TOKEN")) return env;
  const file = join(dataDir, "secrets.json");
  let saved: Record<string, string> = {};
  if (existsSync(file)) saved = JSON.parse(readFileSync(file, "utf8"));
  const out = { ...env };
  let changed = false;
  for (const [k, bytes] of [["APP_SECRET", 32], ["INGEST_TOKEN", 24]] as const) {
    if (!need(k)) continue;
    if (!saved[k]) { saved[k] = randomBytes(bytes).toString("hex"); changed = true; }
    out[k] = saved[k];
  }
  if (changed) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* Windows: ignorieren */ }
  }
  return out;
}
