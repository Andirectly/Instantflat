import { Bot, InlineKeyboard } from "grammy";
import type Database from "better-sqlite3";
import { approveDraft, DraftError, latestDraft, saveDraft } from "./draft.js";
import { transition, TransitionError } from "./listings.js";
import { getKv, setKv } from "./outbox.js";

export type TgApi = {
  sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<{ message_id: number }>;
  sendPhoto(chatId: string, photo: string, other?: Record<string, unknown>): Promise<unknown>;
  answerCallbackQuery(id: string, text?: string, alert?: boolean): Promise<unknown>;
  editMessageText(chatId: string, messageId: number, text: string, other?: Record<string, unknown>): Promise<unknown>;
};

type L = { contactName: string | null; contactKind: string | null; contactSalutation: string | null; id: number; title: string; address: string | null; price: string | null; size: string | null; url: string | null; imageUrl: string | null; state: string };

// Kernlogik ohne grammY-Abhängigkeit, damit sie mit einer Fake-API testbar ist.
export class TelegramService {
  private pendingEdit = new Map<number, number>(); // Message-ID der "Bearbeiten"-Aufforderung → Inserat-ID
  constructor(private db: Database.Database, private chatId: string, private api: TgApi, private publicUrl: string) {}

  private listing(id: number) {
    return this.db.prepare("SELECT id, title, address, price, size, url, image_url AS imageUrl, state, contact_name AS contactName, contact_kind AS contactKind, contact_salutation AS contactSalutation FROM listings WHERE id = ?").get(id) as L | undefined;
  }

  async sendText(text: string): Promise<void> {
    await this.api.sendMessage(this.chatId, text);
  }

  async notifyDraft(listingId: number): Promise<void> {
    const l = this.listing(listingId);
    const d = latestDraft(this.db, listingId);
    if (!l || !d) return;
    const contact = l.contactName ? `Ansprechpartner: ${l.contactKind === "person" ? [l.contactSalutation, l.contactName].filter(Boolean).join(" ") : l.contactName}` : "";
    const facts = [l.title, [l.address, l.size, l.price].filter(Boolean).join(" · "), contact, l.url, `${this.publicUrl}/#freigaben`].filter(Boolean).join("\n");
    if (l.imageUrl) await this.api.sendPhoto(this.chatId, l.imageUrl, { caption: facts.slice(0, 1000) }).catch(() => this.api.sendMessage(this.chatId, facts));
    else await this.api.sendMessage(this.chatId, facts);
    const kb = new InlineKeyboard().text("Senden", `a:${l.id}:${d.id}`).text("Verwerfen", `x:${l.id}:${d.id}`).text("Bearbeiten", `e:${l.id}:${d.id}`);
    await this.api.sendMessage(this.chatId, d.body, { reply_markup: kb });
  }

  async onCallback(fromChat: string, data: string, callbackId: string, messageId?: number): Promise<void> {
    if (fromChat !== this.chatId) return; // fremde Chats werden ignoriert
    const [kind, lid, did] = data.split(":");
    const listingId = Number(lid), draftId = Number(did);
    const answer = (t: string, alert = false) => this.api.answerCallbackQuery(callbackId, t, alert);
    // Karte aktualisieren: Knöpfe entfernen und das Ergebnis anhängen, damit der Stand ohne Hinweisfenster sichtbar bleibt.
    const finish = async (status: string) => {
      if (messageId === undefined) return;
      const body = (this.db.prepare("SELECT body FROM drafts WHERE id = ?").get(draftId) as { body: string } | undefined)?.body ?? "";
      await this.api.editMessageText(this.chatId, messageId, `${body}

${status}`.trim(), { reply_markup: { inline_keyboard: [] } }).catch(() => {});
    };
    try {
      if (kind === "a") {
        approveDraft(this.db, listingId, draftId);
        await finish("✅ Freigegeben – wartet in der Queue");
        return void (await answer("Freigegeben. Wartet in der Queue."));
      }
      if (kind === "x") {
        if (latestDraft(this.db, listingId)?.id !== draftId) throw new DraftError("Entwurf wurde inzwischen geändert");
        transition(this.db, listingId, "verworfen", "Per Telegram verworfen");
        await finish("🗑 Verworfen");
        return void (await answer("Verworfen."));
      }
      if (kind === "e") {
        const m = await this.api.sendMessage(this.chatId, "Antworte auf diese Nachricht mit dem neuen Text.", { reply_markup: { force_reply: true } });
        this.pendingEdit.set(m.message_id, listingId);
        return void (await answer("Warte auf deinen Text."));
      }
      await answer("Unbekannte Aktion.");
    } catch (e) {
      // Doppelklick oder veraltete Karte: nichts ändern, nur melden.
      if (e instanceof DraftError || e instanceof TransitionError) {
        await finish(`⚠️ Nicht mehr möglich: ${e.message}`);
        return void (await answer(e.message, true));
      }
      throw e;
    }
  }

  async onReply(fromChat: string, replyTo: number | undefined, text: string): Promise<void> {
    if (fromChat !== this.chatId || replyTo === undefined) return;
    const listingId = this.pendingEdit.get(replyTo);
    if (listingId === undefined) return;
    this.pendingEdit.delete(replyTo);
    if (this.listing(listingId)?.state !== "entwurf") return void (await this.api.sendMessage(this.chatId, "Dieses Inserat ist nicht mehr im Entwurf."));
    saveDraft(this.db, listingId, text.trim(), "manuell");
    await this.notifyDraft(listingId);
  }
}

export function startTelegram(db: Database.Database, token: string, chatId: string, publicUrl: string, log: (m: string) => void): { svc: TelegramService; stop: () => Promise<void> } {
  const bot = new Bot(token);
  // Eigener Adapter: grammY erwartet bei answerCallbackQuery ein Optionsobjekt, keinen Text.
  const api: TgApi = {
    sendMessage: (c, t, o) => bot.api.sendMessage(c, t, o as never),
    sendPhoto: (c, p, o) => bot.api.sendPhoto(c, p, o as never),
    answerCallbackQuery: (id, text, alert) => bot.api.answerCallbackQuery(id, { text, show_alert: alert }),
    editMessageText: (c, m, t, o) => bot.api.editMessageText(c, m, t, o as never),
  };
  const svc = new TelegramService(db, chatId, api, publicUrl);
  bot.on("callback_query:data", (ctx) => svc.onCallback(String(ctx.chat?.id ?? ctx.from.id), ctx.callbackQuery.data, ctx.callbackQuery.id, ctx.callbackQuery.message?.message_id));
  bot.on("message:text", (ctx) => svc.onReply(String(ctx.chat.id), ctx.message.reply_to_message?.message_id, ctx.message.text));
  bot.catch((e) => log(`Telegram-Fehler: ${e.message}`));
  void bot.start({ drop_pending_updates: true, onStart: () => log("Telegram-Bot läuft (Long Polling)") }).catch((e) => log(`Telegram-Start fehlgeschlagen: ${(e as Error).message}`));
  return { svc, stop: async () => { await bot.stop().catch(() => {}); } };
}

export type TelegramStarter = typeof startTelegram;

export type TelegramHubApi = {
  configured(): boolean;
  chatId(): string | null;
  source(): "app" | "env" | null;
  sendText(text: string): Promise<void>;
  notifyDraft(listingId: number): Promise<void>;
  /** Prüft den Token, speichert beides und startet den Bot neu. token = undefined behält den gespeicherten. */
  apply(token: string | undefined, chatId: string): Promise<{ bot: string }>;
  findChats(token?: string): Promise<{ id: string; name: string }[]>;
};

/**
 * Token und Chat-ID kommen aus den Einstellungen der App (Datenbank) oder, wenn dort nichts steht, aus der Umgebung.
 * Änderungen greifen sofort, der Bot wird ohne Neustart der App neu gestartet. Der Token wird von der API nie zurückgegeben.
 */
export class TelegramHub implements TelegramHubApi {
  private current: { svc: TelegramService; stop: () => Promise<void> } | null = null;

  constructor(
    private db: Database.Database,
    private env: { token?: string; chatId?: string },
    private publicUrl: string,
    private log: (m: string) => void,
    private starter: TelegramStarter = startTelegram,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private creds(): { token: string; chatId: string; source: "app" | "env" } | null {
    const t = getKv(this.db, "telegram_token"), c = getKv(this.db, "telegram_chat_id");
    if (t && c) return { token: t, chatId: c, source: "app" };
    if (this.env.token && this.env.chatId) return { token: this.env.token, chatId: this.env.chatId, source: "env" };
    return null;
  }

  configured() { return !!this.creds(); }
  chatId() { return this.creds()?.chatId ?? null; }
  source() { return this.creds()?.source ?? null; }

  start() {
    const c = this.creds();
    if (c && !this.current) this.current = this.starter(this.db, c.token, c.chatId, this.publicUrl, this.log);
  }

  private async stop() {
    const cur = this.current;
    this.current = null;
    await cur?.stop();
  }

  async sendText(text: string) {
    if (!this.current) throw new Error("Telegram ist nicht eingerichtet");
    await this.current.svc.sendText(text);
  }

  async notifyDraft(id: number) {
    await this.current?.svc.notifyDraft(id);
  }

  private async call<T>(token: string, method: string): Promise<T> {
    const r = await this.fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!r.ok || !j.ok) throw new Error(j.description === "Unauthorized" ? "Der Token ist ungültig" : j.description ?? `Telegram antwortet mit ${r.status}`);
    return j.result as T;
  }

  async apply(token: string | undefined, chatId: string) {
    const tok = token?.trim() || getKv(this.db, "telegram_token") || this.env.token;
    if (!tok) throw new Error("Bitte den Bot-Token eintragen");
    if (!/^-?\d+$/.test(chatId.trim())) throw new Error("Die Chat-ID besteht nur aus Ziffern (bei Gruppen mit Minuszeichen)");
    const me = await this.call<{ username: string }>(tok, "getMe");
    setKv(this.db, "telegram_token", tok);
    setKv(this.db, "telegram_chat_id", chatId.trim());
    await this.stop();
    this.start();
    return { bot: "@" + me.username };
  }

  /** Chats, die dem Bot geschrieben haben. getUpdates und der laufende Bot schließen sich aus, daher wird er kurz angehalten. */
  async findChats(token?: string) {
    const tok = token?.trim() || this.creds()?.token;
    if (!tok) throw new Error("Bitte zuerst den Bot-Token eintragen");
    const wasRunning = !!this.current;
    await this.stop();
    try {
      const updates = await this.call<{ message?: { chat: { id: number; type: string; first_name?: string; title?: string } } }[]>(tok, "getUpdates");
      const chats = new Map<string, string>();
      for (const u of updates) if (u.message) chats.set(String(u.message.chat.id), u.message.chat.first_name ?? u.message.chat.title ?? "Chat");
      return [...chats].map(([id, name]) => ({ id, name }));
    } finally {
      if (wasRunning) this.start();
    }
  }
}
