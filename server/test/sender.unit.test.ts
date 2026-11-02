import { describe, expect, it, vi } from "vitest";
import { sendMessage, SendError, INSTANT_PACE } from "../src/portals/sender.js";
import { mockPortal } from "../src/portals/defs.js";

// Minimale Seite: ein Selektor "existiert", wenn er (als Teil einer Komma-Liste) in `present` steht.
const fakePage = (present: string[]) => {
  const hit = (s: string) => s.split(",").map((x) => x.trim()).some((x) => present.includes(x));
  const page = {
    waitForSelector: vi.fn(async (s: string) => { if (!hit(s)) throw new Error("timeout"); }),
    locator: (s: string) => ({ count: async () => (hit(s) ? 1 : 0), first: () => ({ fill: vi.fn(), click: vi.fn(async () => { present.push(page.__opened); }) }) }),
    click: vi.fn(), keyboard: { type: vi.fn() }, screenshot: vi.fn(async () => Buffer.from("png")), waitForTimeout: vi.fn(),
    url: () => "https://www.portal.test/inserat",
    __opened: "",
  };
  return page;
};
const def = (extra = {}) => { const d = mockPortal("http://x"); return { ...d, send: { ...d.send!, ...extra } }; };
const go = (page: ReturnType<typeof fakePage>, d = def()) => sendMessage(page as never, d, "Hallo", { dryRun: true, pace: INSTANT_PACE, formTimeout: 50 });

describe("sendMessage Vorprüfungen", () => {
  const f = "form#contact #message";
  it("normaler Dry-Run tippt und klickt nicht auf Absenden", async () => {
    const p = fakePage([f]);
    expect((await go(p)).result).toBe("dry_run");
    expect(p.keyboard.type).toHaveBeenCalledTimes(5);
    expect(p.click).not.toHaveBeenCalledWith("form#contact #send");
  });
  it("requireLoggedIn fehlt → session_expired, es wird nichts getippt", async () => {
    const p = fakePage([f]);
    await expect(go(p, def({ requireLoggedIn: "#eingeloggt" }))).rejects.toThrow(/session_expired/);
    expect(p.keyboard.type).not.toHaveBeenCalled();
  });
  it("requireLoggedIn vorhanden → weiter", async () => {
    expect((await go(fakePage([f, "#eingeloggt"]), def({ requireLoggedIn: "#eingeloggt" }))).result).toBe("dry_run");
  });
  it("Captcha und Abmeldung stoppen vor dem Tippen", async () => {
    await expect(go(fakePage([f, "#captcha"]))).rejects.toThrow(/interaction_required/);
    await expect(go(fakePage([f, "form#login"]))).rejects.toThrow(/session_expired/);
  });
  it("Host-Schutz: Formular auf fremder Domain wird nie benutzt, kein Wiederholen", async () => {
    const p = fakePage([f]);
    p.url = () => "https://www.fremd.example/anfrage";
    const e = await go(p, def({ host: "portal.test" })).catch((x) => x);
    expect(e.message).toMatch(/Externe Seite/);
    expect(e.retry).toBe(false);
    expect(p.keyboard.type).not.toHaveBeenCalled();
    expect((await go(fakePage([f]), def({ host: "portal.test" }))).result).toBe("dry_run"); // Subdomain/Hauptdomain passt
  });
  it("Captcha und Abmeldung tragen einen maschinenlesbaren Grund (für die Benachrichtigung)", async () => {
    expect(await go(fakePage([f, "#captcha"])).catch((x) => x)).toMatchObject({ reason: "interaction_required", phase: "before" });
    expect(await go(fakePage([f, "form#login"])).catch((x) => x)).toMatchObject({ reason: "session_expired" });
    expect(await go(fakePage([])).catch((x) => x)).toMatchObject({ reason: undefined }); // normales "kein Formular" bleibt ein Fehler
  });
  it("Öffner: Formular erscheint erst nach Klick", async () => {
    const p = fakePage(["#open"]);
    p.__opened = f;
    expect((await go(p, def({ opener: "#open" }))).result).toBe("dry_run");
  });
  it("kein Formular → SendError vor dem Klick (sicher wiederholbar)", async () => {
    const e = await go(fakePage([])).catch((x) => x);
    expect(e).toBeInstanceOf(SendError);
    expect(e.phase).toBe("before");
  });
});
