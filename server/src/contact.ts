export type Contact = { name: string; kind: "person" | "company"; salutation: "Herr" | "Frau" | null };

const COMPANY = /\b(gmbh|mbh|ag|kg|ohg|ug|e\.?\s?k\.?|gbr|immobilien|immobilie|verwaltung|hausverwaltung|makler|gruppe|group|holding|team|service|wohnungsbau|wohnbau|genossenschaft|gesellschaft|stiftung|portal|agentur|gmbh & co)\b|\.(com|de)\b/i;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * Liest den Ansprechpartner aus Zeilen wie "Agent: …", "Ansprechpartner: …" oder "Kontakt: …" in der Beschreibung.
 * Nur eine klar erkennbare Person (Herr/Frau Name oder Vorname Nachname) gilt als Person. Firmen, Makler und alles Unklare
 * bekommen keine persönliche Anrede. Die Anrede "Herr/Frau" wird nie aus dem Vornamen geraten, nur übernommen, wenn sie dasteht.
 */
export function extractContact(description: string | null | undefined): Contact | null {
  if (!description) return null;
  const m = description.match(/^\s*(?:agent|ansprechpartner(?:in)?|kontakt|anbieter|vermieter(?:in)?)\s*:\s*(.+)$/im);
  if (!m) return null;
  const v = m[1]!.trim().replace(/\s+/g, " ");
  if (!v || v.length > 80) return null;
  if (COMPANY.test(v)) return { name: v, kind: "company", salutation: null };
  const s = v.match(/^(herr|frau)\s+(.+)$/i);
  if (s && /^[\p{L}.'-]+(?:\s+[\p{L}.'-]+){0,2}$/u.test(s[2]!)) return { name: s[2]!, kind: "person", salutation: cap(s[1]!) as "Herr" | "Frau" };
  if (/^[\p{L}.'-]+(?:\s+[\p{L}.'-]+){1,2}$/u.test(v)) return { name: v, kind: "person", salutation: null };
  return { name: v, kind: "company", salutation: null };
}

/** "Guten Tag Herr Müller," / "Guten Tag Max Müller," / "Guten Tag," */
export function greeting(c: { contactName?: string | null; contactKind?: string | null; contactSalutation?: string | null }): string {
  if (c.contactKind !== "person" || !c.contactName) return "Guten Tag,";
  const last = c.contactName.split(" ").at(-1)!;
  return c.contactSalutation ? `Guten Tag ${c.contactSalutation} ${last},` : `Guten Tag ${c.contactName},`;
}
