import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { TelegramHub, type TelegramStarter } from "../src/telegram.js";

const reply = (j: object, status = 200) => new Response(JSON.stringify(j), { status });
const me = () => reply({ ok: true, result: { username: "mein_bot" } });

function setup(env: { token?: string; chatId?: string } = {}, fetchImpl: typeof fetch = vi.fn().mockImplementation(async () => me())) {
  const stops: number[] = [];
  const started: { token: string; chatId: string }[] = [];
  const starter = vi.fn((_db, token: string, chatId: string) => {
    started.push({ token, chatId });
    const n = started.length;
    return { svc: { sendText: vi.fn(), notifyDraft: vi.fn() } as never, stop: async () => void stops.push(n) };
  }) as unknown as TelegramStarter;
  const db = openDb(":memory:");
  const hub = new TelegramHub(db, env, "http://x", () => {}, starter, fetchImpl);
  return { hub, db, started, stops };
}

describe("TelegramHub", () => {
  it("ohne Angaben: nicht eingerichtet, kein Bot, sendText wirft", async () => {
    const { hub, started } = setup();
    hub.start();
    expect(hub.configured()).toBe(false);
    expect(started).toHaveLength(0);
    await expect(hub.sendText("x")).rejects.toThrow(/nicht eingerichtet/);
    await expect(hub.notifyDraft(1)).resolves.toBeUndefined(); // still, kein Fehler
  });

  it("Umgebung als Rückfall, gespeicherte Werte aus der App haben Vorrang", async () => {
    const { hub, started } = setup({ token: "env-token", chatId: "1" });
    hub.start();
    expect(hub.source()).toBe("env");
    expect(started).toEqual([{ token: "env-token", chatId: "1" }]);
    await hub.apply("app-token", "2");
    expect(hub.source()).toBe("app");
    expect(started.at(-1)).toEqual({ token: "app-token", chatId: "2" });
    expect(hub.chatId()).toBe("2");
  });

  it("apply prüft den Token (getMe), speichert erst danach und startet den Bot neu", async () => {
    const f = vi.fn().mockImplementation(async () => me());
    const { hub, started, stops } = setup({}, f);
    expect(await hub.apply("123:ABC", " 42 ")).toEqual({ bot: "@mein_bot" });
    expect(f.mock.calls[0]![0]).toBe("https://api.telegram.org/bot123:ABC/getMe");
    expect(started).toEqual([{ token: "123:ABC", chatId: "42" }]);
    await hub.apply(undefined, "43"); // Token behalten
    expect(started.at(-1)).toEqual({ token: "123:ABC", chatId: "43" });
    expect(stops).toEqual([1]); // der alte Bot wurde angehalten
  });

  it("ungültiger Token oder Chat-ID: nichts wird gespeichert", async () => {
    const bad = vi.fn().mockResolvedValue(reply({ ok: false, description: "Unauthorized" }, 401));
    const { hub, started } = setup({}, bad);
    await expect(hub.apply("falsch", "42")).rejects.toThrow("Der Token ist ungültig");
    expect(hub.configured()).toBe(false);
    await expect(hub.apply("123:ABC", "abc")).rejects.toThrow(/Ziffern/);
    await expect(hub.apply(undefined, "42")).rejects.toThrow(/Token eintragen/);
    expect(started).toHaveLength(0);
  });

  it("findChats: liefert Chats, die dem Bot geschrieben haben, und startet den Bot danach wieder", async () => {
    const f = vi.fn().mockImplementation(async (url: string) =>
      url.endsWith("getMe") ? me() : reply({ ok: true, result: [
        { message: { chat: { id: 8308947321, type: "private", first_name: "André" } } },
        { message: { chat: { id: 8308947321, type: "private", first_name: "André" } } },
        { message: { chat: { id: -100, type: "group", title: "Gruppe" } } },
        { edited_message: {} },
      ] }));
    const { hub, started, stops } = setup({}, f);
    await hub.apply("123:ABC", "1");
    const chats = await hub.findChats();
    expect(chats).toEqual([{ id: "8308947321", name: "André" }, { id: "-100", name: "Gruppe" }]);
    expect(stops).toEqual([1]); // Bot war für getUpdates angehalten
    expect(started).toHaveLength(2); // und läuft danach wieder
    await expect(setup().hub.findChats()).rejects.toThrow(/Token/);
  });
});
