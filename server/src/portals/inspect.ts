import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import type { PortalDef } from "./types.js";

// Als Text statt als Funktion, damit kein Build-Werkzeug Hilfscode einfügt, der im Browser nicht existiert.
const COLLECT = `(() => {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const q = (s) => [...document.querySelectorAll(s)];
  const short = (t) => (t || "").trim().replace(/\\s+/g, " ").slice(0, 30);
  const attrs = (e) => ({
    tag: e.tagName.toLowerCase(), id: e.id || undefined, testid: e.getAttribute("data-testid") || e.getAttribute("data-test") || undefined,
    name: e.getAttribute("name") || undefined, type: e.getAttribute("type") || undefined,
    cls: (typeof e.className === "string" ? e.className.split(/\\s+/).slice(0, 3).join(" ") : "") || undefined, visible: vis(e),
  });
  const keys = new Set();
  q("[id]").forEach((e) => { if (e.id.length < 40 && !/\\d{4,}/.test(e.id)) keys.add("id=" + e.id); });
  q("[data-testid]").forEach((e) => keys.add("testid=" + e.getAttribute("data-testid")));
  q("a[href]").forEach((e) => { const h = (e.getAttribute("href") || "").split("?")[0]; if (/login|logout|anmeld|abmeld|konto|account|nachricht|message|profil|mein/i.test(h)) keys.add("href=" + h.slice(0, 80)); });
  return {
    url: location.origin + location.pathname.slice(0, 100) + (location.hash ? location.hash.slice(0, 40) : ""), title: document.title.slice(0, 80),
    forms: q("form").map(attrs),
    textareas: q("textarea").map((e) => ({ ...attrs(e), filled: !!e.value })),
    inputs: q("form input, form select").map((e) => ({ ...attrs(e), filled: e.type === "checkbox" ? e.checked : !!e.value })).slice(0, 25),
    buttons: q("button, a[role=button], input[type=submit], a[class*=btn], a[class*=button]").filter(vis).map((e) => ({ ...attrs(e), text: short(e.innerText || e.value) })).filter((b) => b.text).slice(0, 40),
    dialogs: q("[role=dialog]").map(attrs),
    captcha: q('[class*="captcha" i], [id*="captcha" i], iframe[src*="captcha" i]').map(attrs).slice(0, 5),
    keys: [...keys].slice(0, 400),
  };
})()`;

export type PageStructure = {
  url: string; title: string;
  forms: unknown[]; textareas: unknown[]; inputs: unknown[]; buttons: unknown[]; dialogs: unknown[]; captcha: unknown[];
  keys: string[];
};
export type InspectResult = {
  tabs: { url: string; title: string }[];
  tab: Omit<PageStructure, "keys"> | null;
  compare?: { loggedOutUrl: string; onlyLoggedIn: string[]; onlyLoggedOut: string[] };
};

async function resolveHost(url: string): Promise<string> {
  const u = new URL(url);
  if (!isIP(u.hostname) && u.hostname !== "localhost") u.hostname = (await lookup(u.hostname)).address;
  return u.origin;
}

const collect = (p: Page) => p.evaluate(COLLECT) as Promise<PageStructure>;

/**
 * Nur lesend: listet die offenen Tabs des Portals und beschreibt die Struktur eines Tabs (ids, data-testid, Formulare, Buttons mit kurzem Text,
 * keine Formularwerte). Mit compare wird dieselbe Adresse zusätzlich in einem frischen, ausgeloggten Kontext geladen und verglichen.
 * Das ist die Grundlage, um Selektoren für ein Portal zu kalibrieren.
 */
export async function inspectPortal(cdpUrl: string, def: PortalDef, opts: { match?: string; index?: number; compare?: boolean } = {}): Promise<InspectResult> {
  const browser: Browser = await chromium.connectOverCDP(await resolveHost(cdpUrl), { timeout: 15_000 });
  try {
    const ctx = browser.contexts()[0];
    const host = new URL(def.url).hostname.replace(/^www\./, "");
    const pages = (ctx?.pages() ?? []).filter((p) => p.url().includes(opts.match ?? host));
    const tabs = await Promise.all(pages.map(async (p) => ({ url: p.url().split("?")[0]!.slice(0, 140), title: (await p.title()).slice(0, 80) })));
    const page = pages[opts.index ?? 0];
    if (!page) return { tabs, tab: null };
    const { keys, ...tab } = await collect(page);
    const res: InspectResult = { tabs, tab };
    if (opts.compare) {
      const fresh = await browser.newContext(); // leerer Kontext: keine Cookies, also ausgeloggt
      try {
        const p = await fresh.newPage();
        await p.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 30_000 });
        await p.waitForTimeout(4000);
        const out = await collect(p);
        res.compare = { loggedOutUrl: out.url, onlyLoggedIn: keys.filter((k) => !out.keys.includes(k)), onlyLoggedOut: out.keys.filter((k) => !keys.includes(k)) };
      } finally {
        await fresh.close().catch(() => {});
      }
    }
    return res;
  } finally {
    await browser.close().catch(() => {}); // trennt bei CDP nur die Verbindung
  }
}

export type Inspector = (portalId: string, opts: { match?: string; index?: number; compare?: boolean }) => Promise<InspectResult>;
