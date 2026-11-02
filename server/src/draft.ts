import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { activeProfile, type ProfileData } from "./profiles.js";
import { transition } from "./listings.js";
import { enqueue } from "./outbox.js";

export type ListingRow = {
  id: number; portal: string; title: string; address: string | null; price: string | null; size: string | null;
  rooms: number | null; description: string | null; state: string;
};
export type Draft = { id: number; listingId: number; version: number; body: string; provider: string; createdAt: string };

// ---------- Generatoren ----------

const FEATURES: [RegExp, string][] = [
  [/balkon/i, "der Balkon"], [/terrasse/i, "die Terrasse"], [/garten/i, "der Garten"], [/altbau/i, "der Altbaucharakter"],
  [/parkett|dielen/i, "der schöne Bodenbelag"], [/einbauküche|\bEBK\b/i, "die Einbauküche"], [/aufzug|fahrstuhl/i, "der Aufzug"],
  [/ruhig/i, "die ruhige Lage"], [/hell/i, "die helle Wohnung"], [/saniert|renoviert/i, "der gepflegte Zustand"],
];

export function templateDraft(l: ListingRow, p: ProfileData): string {
  const text = `${l.title} ${l.description ?? ""}`;
  const feats = FEATURES.filter(([re]) => re.test(text)).map(([, f]) => f).slice(0, 2);
  const area = l.address?.split(",")[0]?.trim();
  const what = l.rooms ? `${l.rooms}-Zimmer-Wohnung` : "Wohnung";
  const where = area ? ` in ${area}` : "";
  const why = feats.length ? `, vor allem ${feats.join(" und ")} sprechen mich an` : " und passt gut zu meiner Suche";
  const clauses = [
    p.age ? `bin ${p.age} Jahre alt` : "",
    p.city ? `lebe bereits in ${p.city}` : "",
    p.job ? `arbeite als ${p.job}${p.employment ? ` (${p.employment})` : ""}` : p.employment ? `bin ${p.employment}` : "",
  ].filter(Boolean);
  const intro = [
    clauses.length ? `Ich ${clauses.join(", ")}.` : "",
    p.household ? `Haushalt: ${p.household}.` : "",
    p.pets ? `${p.pets.replace(/\.$/, "")}.` : "",
  ].filter(Boolean).join(" ");
  const closing = [
    p.documentsReady ? "Alle Unterlagen liegen bereit." : "",
    p.moveIn ? `Ein Einzug ${p.moveIn} passt zu meiner Planung.` : "",
    p.viewingTimes ? `Für eine Besichtigung bin ich ${p.viewingTimes} verfügbar.` : "Gerne komme ich zu einer Besichtigung vorbei.",
  ].filter(Boolean).join(" ");
  return [
    "Guten Tag,",
    `Die ${what}${where} hat mein Interesse geweckt${why}.`,
    [intro, p.extra, closing].filter(Boolean).join(" "),
    "Über eine Rückmeldung würde ich mich sehr freuen.",
    `Viele Grüße\n${p.fullName}`,
  ].join("\n\n");
}

export type Generator = { name: string; generate(l: ListingRow, p: ProfileData): Promise<string> };

export const templateGenerator: Generator = { name: "template", generate: async (l, p) => templateDraft(l, p) };

const SYSTEM = `Du schreibst eine kurze, höfliche Wohnungsanfrage an einen Vermieter, auf Deutsch, mit "Sie", etwa 600 bis 900 Zeichen.
Regeln:
- Beginne mit "Guten Tag," und ende mit "Viele Grüße" und dem Namen.
- Nenne 1 bis 2 konkrete Merkmale aus dem Inserat (zum Beispiel Balkon oder Lage), aber nur solche, die dort wirklich stehen.
- Verwende ausschließlich die Angaben unter PROFIL. Erfinde nichts: keine Arbeitszeiten, keine Eigenschaften der Wohnung, keine Wünsche, keine Zahlen.
- Schreibe aus Sicht der Person im PROFIL (ich-Form), nicht über den Vermieter.
- Keine Platzhalter in Klammern.`;

// Das Profil als beschriftete Zeilen statt JSON: kleine Modelle verwechseln sonst Feldnamen (z. B. Besichtigungszeiten mit Arbeitszeiten).
function profileLines(p: ProfileData): string {
  return [
    `Name: ${p.fullName}`,
    p.age && `Alter: ${p.age} Jahre`,
    p.city && `Wohnort: ${p.city}`,
    p.job && `Beruf: ${p.job}`,
    p.employment && `Anstellung: ${p.employment}`,
    p.household && `Haushalt: ${p.household}`,
    p.pets && `Haustiere: ${p.pets}`,
    p.moveIn && `Gewünschter Einzug: ${p.moveIn}`,
    p.viewingTimes && `Zeiten für eine Besichtigung: ${p.viewingTimes}`,
    p.documentsReady && "Unterlagen: liegen bereit",
    p.extra && `Weiteres: ${p.extra}`,
  ].filter(Boolean).join("\n");
}

export function localGenerator(cfg: Pick<Config, "LLM_URL" | "LLM_MODEL" | "LLM_TIMEOUT_S">, fetchImpl: typeof fetch = fetch): Generator {
  return {
    name: "local",
    async generate(l, p) {
      const user = `PROFIL:\n${JSON.stringify(p, null, 1)}\n\nINSERAT:\nTitel: ${l.title}\nAdresse: ${l.address ?? "unbekannt"}\nPreis: ${l.price ?? "unbekannt"}\nFläche: ${l.size ?? "unbekannt"}\nBeschreibung: ${l.description ?? "keine"}`;
      const r = await fetchImpl(`${cfg.LLM_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(cfg.LLM_TIMEOUT_S * 1000),
        body: JSON.stringify({
          model: cfg.LLM_MODEL, temperature: 0.3, max_tokens: 500,
          chat_template_kwargs: { enable_thinking: false },
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
        }),
      });
      if (!r.ok) throw new Error(`LLM antwortet mit ${r.status}`);
      const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      return (j.choices?.[0]?.message?.content ?? "").trim();
    },
  };
}

// ---------- Prüfung ----------

// Erfundene Fakten sind das Hauptrisiko: jede Zahl im Text muss in Profil oder Inserat vorkommen.
export function validateDraft(body: string, l: ListingRow, p: ProfileData): string[] {
  const problems: string[] = [];
  if (body.length < 200) problems.push("zu kurz");
  if (body.length > 1500) problems.push("zu lang");
  if (/\[[^\]]*\]|\{[^}]*\}|<[^>]*>/.test(body)) problems.push("Platzhalter im Text");
  const corpus = `${l.title} ${l.address} ${l.price} ${l.size} ${l.description} ${JSON.stringify(p)}`;
  for (const n of body.match(/\d+(?:[.,]\d+)*/g) ?? []) if (!corpus.includes(n)) problems.push(`Zahl "${n}" nicht belegt`);
  return problems;
}

// ---------- Erzeugen ----------

// Anfragen nacheinander: ein lokales Modell auf schwacher Hardware verträgt keine Parallelität.
let chain: Promise<unknown> = Promise.resolve();
const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

export class DraftError extends Error {}

export function latestDraft(db: Database.Database, listingId: number): Draft | null {
  return (db.prepare("SELECT id, listing_id AS listingId, version, body, provider, created_at AS createdAt FROM drafts WHERE listing_id = ? ORDER BY version DESC LIMIT 1").get(listingId) as Draft | undefined) ?? null;
}

export function saveDraft(db: Database.Database, listingId: number, body: string, provider: string): Draft {
  const v = ((db.prepare("SELECT max(version) m FROM drafts WHERE listing_id = ?").get(listingId) as { m: number | null }).m ?? 0) + 1;
  db.prepare("INSERT INTO drafts (listing_id, version, body, provider) VALUES (?, ?, ?, ?)").run(listingId, v, body, provider);
  return latestDraft(db, listingId)!;
}

export function createDraft(db: Database.Database, gen: Generator, listingId: number): Promise<Draft> {
  return serialize(async () => {
    const l = db.prepare("SELECT id, portal, title, address, price, size, rooms, description, state FROM listings WHERE id = ?").get(listingId) as ListingRow | undefined;
    if (!l) throw new DraftError("Inserat nicht gefunden");
    if (l.state !== "gefiltert" && l.state !== "entwurf") throw new DraftError(`Kein Entwurf im Status ${l.state}`);
    const p = activeProfile(db)?.data;
    if (!p) throw new DraftError("Kein aktives Profil");

    let body = "", provider = gen.name;
    for (let attempt = 0; attempt < 2 && gen !== templateGenerator; attempt++) {
      try {
        const t = await gen.generate(l, p);
        if (!validateDraft(t, l, p).length) { body = t; break; }
      } catch { /* nächster Versuch, danach Fallback */ }
    }
    if (!body) {
      body = templateDraft(l, p);
      if (gen !== templateGenerator) provider = "template (Fallback)";
    }
    const d = saveDraft(db, listingId, body, provider);
    if (l.state === "gefiltert") transition(db, listingId, "entwurf", "Entwurf erstellt");
    return d;
  });
}

// Freigabe nur für den Entwurf, den der Nutzer gesehen hat (verhindert Klicks auf veraltete Telegram-Karten).
export function approveDraft(db: Database.Database, listingId: number, draftId?: number): void {
  const d = latestDraft(db, listingId);
  if (!d) throw new DraftError("Kein Entwurf vorhanden");
  if (draftId !== undefined && d.id !== draftId) throw new DraftError("Entwurf wurde inzwischen geändert");
  transition(db, listingId, "freigegeben", "Freigegeben");
  enqueue(db, listingId);
}
