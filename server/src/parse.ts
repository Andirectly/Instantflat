// Fredy liefert Preis/Fläche als Anzeigetext ("ab 1.240,50 €", "72 m²", "k. A.").
export function parseNumber(s: string | null | undefined): number | null {
  const m = s?.match(/\d[\d.,]*/);
  if (!m) return null;
  let t = m[0].replace(/[.,]+$/, "");
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseRooms(...texts: (string | null | undefined)[]): number | null {
  for (const t of texts) {
    const m = t?.match(/(\d+(?:[.,]\d)?)[\s-]*(?:Zi\b|Zimmer|Zi\.|-Zi)/i);
    if (m) return Number(m[1]!.replace(",", "."));
  }
  return null;
}
