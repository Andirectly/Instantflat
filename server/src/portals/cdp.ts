import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chromium, type Page } from "playwright-core";

// Chromium lehnt CDP-Anfragen mit Hostnamen als Host-Header ab, daher vorher in eine IP auflösen.
async function resolveHost(url: string): Promise<string> {
  const u = new URL(url);
  if (!isIP(u.hostname) && u.hostname !== "localhost") u.hostname = (await lookup(u.hostname)).address;
  return u.origin;
}

export type WithPage = <T>(url: string, fn: (page: Page) => Promise<T>) => Promise<T>;

// Öffnet je Prüfung einen eigenen Tab im laufenden Browser (mit dem persistenten Profil) und schließt ihn wieder.
export const cdpWithPage = (cdpUrl: string): WithPage => async (url, fn) => {
  const browser = await chromium.connectOverCDP(await resolveHost(cdpUrl), { timeout: 15_000 });
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {}); // trennt bei CDP nur die Verbindung
  }
};
