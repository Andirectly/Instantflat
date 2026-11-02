import type { Page } from "playwright-core";
import type { PortalDef } from "./types.js";

/** phase "before": vor dem Absenden-Klick gescheitert (sicher wiederholbar). "after": danach, Ergebnis unklar. */
export class SendError extends Error {
  constructor(message: string, public phase: "before" | "after", public retry = true, public reason?: "interaction_required" | "session_expired") { super(message); }
}

export type Pace = { charMin: number; charMax: number; sentencePause: number; thinkMax: number };
export const HUMAN_PACE: Pace = { charMin: 45, charMax: 150, sentencePause: 700, thinkMax: 3000 };
export const INSTANT_PACE: Pace = { charMin: 0, charMax: 0, sentencePause: 0, thinkMax: 0 };

const between = (lo: number, hi: number, rand: () => number) => lo + rand() * (hi - lo);

// Variable Tippgeschwindigkeit, längere Pausen nach Satzzeichen, kurzes Nachdenken vorher.
export async function humanType(page: Page, selector: string, text: string, pace: Pace, rand: () => number = Math.random) {
  await page.locator(selector).first().fill(""); // Portale füllen teils eine Vorlage vor
  await page.click(selector);
  if (pace.thinkMax) await page.waitForTimeout(between(600, pace.thinkMax, rand));
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: pace.charMax ? between(pace.charMin, pace.charMax, rand) : 0 });
    if (pace.sentencePause && /[.!?\n]/.test(ch) && rand() < 0.6) await page.waitForTimeout(between(pace.sentencePause / 2, pace.sentencePause * 2, rand));
  }
}

export type SendResult = { result: "sent" | "dry_run"; shots: Buffer[] };

export async function sendMessage(page: Page, def: PortalDef, message: string, opts: { dryRun: boolean; pace?: Pace; rand?: () => number; formTimeout?: number }): Promise<SendResult> {
  const sel = def.send;
  if (!sel || !def.selectors) throw new SendError("Portal nicht kalibriert", "before");
  // Inserat-Seiten sind oft Single-Page-Apps: erst warten, bis Formular ODER ein Abmelde-/Captcha-Merkmal erscheint.
  const loggedOut = sel.loggedOut ?? def.selectors.loggedOut;
  const interaction = def.selectors.interaction;
  const timeout = opts.formTimeout ?? 15_000;
  await page.waitForSelector([sel.message, loggedOut, interaction, sel.opener].filter(Boolean).join(", "), { state: "attached", timeout }).catch(() => {
    throw new SendError("Kontaktformular nicht gefunden", "before");
  });
  const has = async (s: string) => (await page.locator(s).count()) > 0;
  if (await has(interaction)) throw new SendError("Portalzustand: interaction_required", "before", true, "interaction_required");
  if (await has(loggedOut)) throw new SendError("Portalzustand: session_expired", "before", true, "session_expired");
  if (sel.requireLoggedIn) {
    await page.waitForSelector(sel.requireLoggedIn, { state: "attached", timeout: 5_000 }).catch(() => { throw new SendError("Portalzustand: session_expired", "before", true, "session_expired"); });
  }
  if (!(await has(sel.message)) && sel.opener) {
    await page.locator(sel.opener).first().click();
    await page.waitForSelector(sel.message, { state: "attached", timeout }).catch(() => { throw new SendError("Formular öffnet sich nicht", "before"); });
  }
  if (!(await has(sel.message))) throw new SendError("Kontaktformular nicht gefunden", "before");

  const guardHost = () => {
    if (!sel.host) return;
    const h = new URL(page.url()).hostname;
    if (h !== sel.host && !h.endsWith("." + sel.host)) throw new SendError(`Externe Seite (${h}), kein Versand`, "before", false);
  };
  guardHost();

  await humanType(page, sel.message, message, opts.pace ?? HUMAN_PACE, opts.rand);
  const shots = [await page.screenshot({ fullPage: true })];
  if (opts.dryRun) return { result: "dry_run", shots }; // alles ausgefüllt, aber nicht abgeschickt

  guardHost();
  await page.click(sel.submit);
  try {
    await page.waitForSelector(sel.success, { state: "attached", timeout: 20_000 });
  } catch {
    throw new SendError("Keine Bestätigung nach dem Absenden", "after");
  }
  shots.push(await page.screenshot({ fullPage: true }));
  return { result: "sent", shots };
}
