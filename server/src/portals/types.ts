export type PortalState = "ok" | "session_expired" | "interaction_required" | "error";

// Selektoren zentral pro Portal. null = noch nicht kalibriert → Zustand "error", nie ein falsches "ok".
export type Selectors = { loggedIn: string; loggedOut: string; interaction: string };

// Kontaktformular am Inserat. null = nicht kalibriert → der Worker sendet für dieses Portal nie.
// loggedOut (optional): Merkmal "abgemeldet" auf der Inserat-Seite; ohne Angabe gilt selectors.loggedOut.
// requireLoggedIn (optional): positives Anmelde-Merkmal auf der Inserat-Seite; fehlt es, wird nicht gesendet (nie als Gast).
// host (optional): Formular darf nur auf dieser Domain benutzt werden (z. B. weiterleitende Fremdanbieter-Inserate).
// opener (optional): Knopf, der das Formular erst öffnet (z. B. "Interesse bekunden").
export type SendSelectors = { message: string; submit: string; success: string; loggedOut?: string; opener?: string; requireLoggedIn?: string; host?: string };

export type PortalDef = { id: string; name: string; url: string; selectors: Selectors | null; send: SendSelectors | null };

// Kleinste Schnittstelle, die die Erkennung von Playwright braucht (macht sie ohne Browser testbar).
export type PageLike = {
  locator(selector: string): { count(): Promise<number> };
  // Optional: echte Seiten sind oft Single-Page-Apps und rendern erst nach dem Laden.
  waitForSelector?(selector: string, opts: { state: "attached"; timeout: number }): Promise<unknown>;
};
