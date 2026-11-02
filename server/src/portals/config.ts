import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { PortalDef } from "./types.js";

const css = z.string().trim().min(1);
const entry = z.object({
  url: z.string().url().optional(),
  selectors: z.object({ loggedIn: css, loggedOut: css, interaction: css }).nullable().optional(),
  send: z.object({ message: css, submit: css, success: css, loggedOut: css.optional(), opener: css.optional(), requireLoggedIn: css.optional(), host: css.optional() }).nullable().optional(),
}).strict();

const fileSchema = z.record(entry);

/**
 * Kalibrierung ohne Codeänderung: portals.json (siehe portals.example.json) überschreibt URL, Selektoren
 * und Formular-Selektoren pro Portal-ID. Fehlt die Datei, bleiben die Standardwerte.
 */
export function loadPortalDefs(base: PortalDef[], file: string): PortalDef[] {
  if (!existsSync(file)) return base;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: kein gültiges JSON (${(e as Error).message})`);
  }
  const r = fileSchema.safeParse(json);
  if (!r.success) throw new Error(`${file}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const unknown = Object.keys(r.data).filter((id) => !base.some((d) => d.id === id));
  if (unknown.length) throw new Error(`${file}: unbekannte Portal-ID(s): ${unknown.join(", ")} (erlaubt: ${base.map((d) => d.id).join(", ")})`);
  return base.map((d) => {
    const o = r.data[d.id];
    return o ? { ...d, url: o.url ?? d.url, selectors: o.selectors === undefined ? d.selectors : o.selectors, send: o.send === undefined ? d.send : o.send } : d;
  });
}
