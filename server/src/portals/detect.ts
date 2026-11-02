import type { PageLike, PortalState, Selectors } from "./types.js";

// Reihenfolge zählt: eine Captcha-Seite hat oft auch ein Login-Formular im Hintergrund.
export async function detectState(page: PageLike, sel: Selectors | null): Promise<{ state: PortalState; detail?: string }> {
  if (!sel) return { state: "error", detail: "Selektoren nicht kalibriert" };
  // Auf irgendeines der Merkmale warten (bis 8 s), sonst zählt ein zu früher Blick "nichts gefunden".
  await page.waitForSelector?.([sel.interaction, sel.loggedIn, sel.loggedOut].join(", "), { state: "attached", timeout: 8000 }).catch(() => {});
  const has = async (s: string) => (await page.locator(s).count()) > 0;
  if (await has(sel.interaction)) return { state: "interaction_required" };
  if (await has(sel.loggedIn)) return { state: "ok" };
  if (await has(sel.loggedOut)) return { state: "session_expired" };
  return { state: "error", detail: "Seite nicht erkannt" };
}
