import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { ingest } from "../src/ingest.js";
import { activateProfile, activeProfile, createProfile, deleteProfile, profileSchema } from "../src/profiles.js";
import { approveDraft, createDraft, DraftError, latestDraft, localGenerator, templateDraft, templateGenerator, validateDraft, type Generator, type ListingRow } from "../src/draft.js";
import { TelegramService, type TgApi } from "../src/telegram.js";

const profile = profileSchema.parse({ fullName: "André Test", age: 28, city: "Köln", job: "Videograf", employment: "fest angestellt", pets: "Keine Haustiere", documentsReady: true, viewingTimes: "abends und am Wochenende" });
const listing: ListingRow = { id: 1, portal: "immoscout24", title: "Helle 3-Zimmer-Wohnung mit Balkon", address: "Ehrenfeld, Köln", price: "1.150 €", size: "72 m²", rooms: 3, description: "Ruhige Lage.", state: "gefiltert" };

function seeded() {
  const db = openDb(":memory:");
  ingest(db, { provider: "immoscout", listings: [{ id: "1", title: listing.title, address: listing.address, price: listing.price, size: listing.size, description: listing.description }] });
  createProfile(db, "Standard", profile);
  return db;
}

describe("Profile", () => {
  it("erstes Profil aktiv, genau eines aktiv, aktives nicht löschbar", () => {
    const db = openDb(":memory:");
    const a = createProfile(db, "A", profile), b = createProfile(db, "B", profile);
    expect(activeProfile(db)).toMatchObject({ id: a });
    activateProfile(db, b);
    expect(activeProfile(db)).toMatchObject({ id: b });
    expect(deleteProfile(db, b)).toBe("active");
    expect(deleteProfile(db, a)).toBe("ok");
  });
});

describe("Template-Entwurf", () => {
  const t = templateDraft(listing, profile);
  it("nutzt nur belegte Fakten und besteht die eigene Prüfung", () => {
    expect(t).toContain("Balkon");
    expect(t).toContain("Ehrenfeld");
    expect(t).toContain("28 Jahre alt");
    expect(t).toContain("André Test");
    expect(validateDraft(t, listing, profile)).toEqual([]);
  });
  it("lässt unbekannte Profilfelder weg (kein Erfinden)", () => {
    const bare = templateDraft({ ...listing, description: null, title: "Wohnung" }, profileSchema.parse({ fullName: "X Y" }));
    expect(bare).not.toMatch(/Jahre|Unterlagen|Haustier|undefined|null/);
  });
});

describe("validateDraft", () => {
  it("erkennt Platzhalter, erfundene Zahlen, Länge", () => {
    expect(validateDraft("Hallo [Name] " + "x".repeat(300), listing, profile)).toContain("Platzhalter im Text");
    expect(validateDraft("Ich verdiene 4500 Euro. " + "x".repeat(300), listing, profile)).toContain('Zahl "4500" nicht belegt');
    expect(validateDraft("kurz", listing, profile)).toContain("zu kurz");
  });
});

describe("createDraft", () => {
  let db: ReturnType<typeof seeded>;
  beforeEach(() => { db = seeded(); });

  it("erzeugt Entwurf, setzt Status, Version zählt hoch", async () => {
    const d1 = await createDraft(db, templateGenerator, 1);
    expect(d1).toMatchObject({ version: 1, provider: "template" });
    expect(db.prepare("SELECT state FROM listings").get()).toEqual({ state: "entwurf" });
    expect((await createDraft(db, templateGenerator, 1)).version).toBe(2);
  });

  it("ohne Profil: Fehler", async () => {
    const empty = openDb(":memory:");
    ingest(empty, { provider: "immoscout", listings: [{ id: "1", title: "x" }] });
    await expect(createDraft(empty, templateGenerator, 1)).rejects.toThrow(DraftError);
  });

  it("KI mit erfundener Zahl → zweiter Versuch, dann Template-Fallback", async () => {
    const bad: Generator = { name: "local", generate: vi.fn().mockResolvedValue("Guten Tag, ich verdiene 9999 Euro. " + "x".repeat(300)) };
    const d = await createDraft(db, bad, 1);
    expect(bad.generate).toHaveBeenCalledTimes(2);
    expect(d.provider).toBe("template (Fallback)");
  });

  it("KI-Timeout/Fehler → Fallback statt Fehlerstatus", async () => {
    const boom: Generator = { name: "local", generate: vi.fn().mockRejectedValue(new Error("timeout")) };
    expect((await createDraft(db, boom, 1)).provider).toBe("template (Fallback)");
  });

  it("guter KI-Text wird übernommen", async () => {
    const text = templateDraft(listing, profile) + " Ergänzung.";
    const ok: Generator = { name: "local", generate: vi.fn().mockResolvedValue(text) };
    expect(await createDraft(db, ok, 1)).toMatchObject({ provider: "local", body: text });
  });

  it("Freigabe nur für aktuellen Entwurf", async () => {
    const d1 = await createDraft(db, templateGenerator, 1);
    await createDraft(db, templateGenerator, 1);
    expect(() => approveDraft(db, 1, d1.id)).toThrow(/geändert/);
    approveDraft(db, 1, latestDraft(db, 1)!.id);
    expect(db.prepare("SELECT state FROM listings").get()).toEqual({ state: "freigegeben" });
    expect(() => approveDraft(db, 1)).toThrow(); // zweiter Klick
  });
});

describe("localGenerator", () => {
  const cfg = { LLM_URL: "http://llm:8081", LLM_MODEL: "bonsai", LLM_TIMEOUT_S: 5 };
  it("ruft /v1/chat/completions auf und liest die Antwort", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: " Text " } }] })));
    expect(await localGenerator(cfg, f).generate(listing, profile)).toBe("Text");
    expect(f.mock.calls[0]![0]).toBe("http://llm:8081/v1/chat/completions");
    expect(JSON.parse(f.mock.calls[0]![1].body).messages[1].content).toContain("Helle 3-Zimmer");
  });
  it("HTTP-Fehler wirft", async () => {
    await expect(localGenerator(cfg, vi.fn().mockResolvedValue(new Response("x", { status: 500 }))).generate(listing, profile)).rejects.toThrow(/500/);
  });
});

describe("Telegram", () => {
  const CHAT = "42";
  function setup() {
    const db = seeded();
    const sent: { text: string; other?: Record<string, unknown> }[] = [];
    const answers: string[] = [];
    const alerts: (boolean | undefined)[] = [];
    const edits: { id: number; text: string; other?: Record<string, unknown> }[] = [];
    let mid = 100;
    const api: TgApi = {
      sendMessage: async (_c, text, other) => (sent.push({ text, other }), { message_id: ++mid }),
      sendPhoto: async () => ({}),
      answerCallbackQuery: async (_id, t, alert) => void (answers.push(t ?? ""), alerts.push(alert)),
      editMessageText: async (_c, id, text, other) => void edits.push({ id, text, other }),
    };
    return { db, sent, answers, alerts, edits, svc: new TelegramService(db, CHAT, api, "http://x") };
  }

  it("Karte enthält Entwurf mit Senden/Verwerfen/Bearbeiten", async () => {
    const { db, sent, svc } = setup();
    await createDraft(db, templateGenerator, 1);
    await svc.notifyDraft(1);
    const kb = JSON.stringify(sent.at(-1)!.other);
    for (const w of ["Senden", "Verwerfen", "Bearbeiten"]) expect(kb).toContain(w);
  });

  it("fremde Chat-ID wird ignoriert", async () => {
    const { db, answers, svc } = setup();
    const d = await createDraft(db, templateGenerator, 1);
    await svc.onCallback("666", `a:1:${d.id}`, "cb");
    expect(answers).toEqual([]);
    expect(db.prepare("SELECT state FROM listings").get()).toEqual({ state: "entwurf" });
  });

  it("Senden, Doppelklick und veraltete Karte", async () => {
    const { db, answers, svc } = setup();
    const d1 = await createDraft(db, templateGenerator, 1);
    const d2 = await createDraft(db, templateGenerator, 1);
    await svc.onCallback(CHAT, `a:1:${d1.id}`, "cb1");
    expect(answers.at(-1)).toMatch(/geändert/);
    await svc.onCallback(CHAT, `a:1:${d2.id}`, "cb2");
    expect(answers.at(-1)).toMatch(/Freigegeben/);
    await svc.onCallback(CHAT, `a:1:${d2.id}`, "cb3");
    expect(answers.at(-1)).toMatch(/nicht erlaubt/);
    expect(db.prepare("SELECT count(*) c FROM listing_events WHERE to_state = 'freigegeben'").get()).toEqual({ c: 1 });
  });

  it("Senden/Verwerfen aktualisieren die Karte (ohne Knöpfe); Fehler als sichtbarer Hinweis", async () => {
    const { db, answers, alerts, edits, svc } = setup();
    const d1 = await createDraft(db, templateGenerator, 1);
    await svc.onCallback(CHAT, `a:1:${d1.id}`, "cb1", 555);
    expect(edits.at(-1)).toMatchObject({ id: 555, other: { reply_markup: { inline_keyboard: [] } } });
    expect(edits.at(-1)!.text).toMatch(/Guten Tag[\s\S]*✅ Freigegeben/);
    expect(alerts.at(-1)).toBe(false);
    await svc.onCallback(CHAT, `x:1:${d1.id}`, "cb2", 555); // schon freigegeben
    expect(alerts.at(-1)).toBe(true);
    expect(edits.at(-1)!.text).toMatch(/⚠️ Nicht mehr möglich/);
    expect(answers.at(-1)).toMatch(/nicht erlaubt/);
  });

  it("Verwerfen aktualisiert die Karte", async () => {
    const { db, edits, svc } = setup();
    const d = await createDraft(db, templateGenerator, 1);
    await svc.onCallback(CHAT, `x:1:${d.id}`, "cb", 7);
    expect(edits.at(-1)!.text).toMatch(/🗑 Verworfen/);
    expect(db.prepare("SELECT state FROM listings").get()).toEqual({ state: "verworfen" });
  });

  it("Bearbeiten: Antwort erzeugt neue Version und neue Karte", async () => {
    const { db, sent, svc } = setup();
    await createDraft(db, templateGenerator, 1);
    await svc.onCallback(CHAT, `e:1:${latestDraft(db, 1)!.id}`, "cb");
    await svc.onReply(CHAT, 101, "Mein neuer Text");
    expect(latestDraft(db, 1)).toMatchObject({ version: 2, body: "Mein neuer Text", provider: "manuell" });
    expect(sent.at(-1)!.text).toBe("Mein neuer Text");
    await svc.onReply(CHAT, 101, "nochmal"); // Aufforderung ist verbraucht
    expect(latestDraft(db, 1)!.version).toBe(2);
  });
});
