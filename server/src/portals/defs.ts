import type { PortalDef } from "./types.js";

// shortcut: Selektoren der echten Portale sind unkalibriert (brauchen eine eingeloggte Seite), bis dahin meldet der Monitor "error: nicht kalibriert".
export const REAL_PORTALS: PortalDef[] = [
  { id: "immoscout24", name: "ImmoScout24", url: "https://www.immobilienscout24.de/", selectors: null, send: null },
  { id: "kleinanzeigen", name: "Kleinanzeigen", url: "https://www.kleinanzeigen.de/", selectors: null, send: null },
  { id: "immowelt", name: "Immowelt", url: "https://www.immowelt.de/", selectors: null, send: null },
  { id: "wggesucht", name: "WG-Gesucht", url: "https://www.wg-gesucht.de/", selectors: null, send: null },
];

export const mockPortal = (baseUrl: string): PortalDef => ({
  id: "mock",
  name: "Mock-Portal",
  url: baseUrl,
  selectors: { loggedIn: "#account", loggedOut: "form#login", interaction: "#captcha, #verify-code" },
  send: { message: "form#contact #message", submit: "form#contact #send", success: "#sent-ok" },
});
