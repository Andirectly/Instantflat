import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { hashPassword, verifyPassword } from "./password.js";
import { ingest } from "./ingest.js";
import { approveDraft, createDraft, DraftError, latestDraft, localGenerator, saveDraft, templateGenerator, type Generator } from "./draft.js";
import { activateProfile, activeProfile, createProfile, deleteProfile, listProfiles, profileSchema, updateProfile } from "./profiles.js";
import proxy from "@fastify/http-proxy";
import type { SessionMonitor } from "./portals/monitor.js";
import { getDailyLimit, getMode, NIGHT_FROM, NIGHT_TO, setDailyLimit, setMode } from "./outbox.js";
import { filtersSchema } from "./filter.js";
import type { TelegramHubApi } from "./telegram.js";
import type { Inspector } from "./portals/inspect.js";
import { FredyClient, getFredySettings, setFredySettings, type FredyPort } from "./fredy.js";
import { enrichListing } from "./enrich.js";
import { createUpdater, type Updater } from "./update.js";
import { cachedGeocode, nominatimGeocoder, type Geocoder } from "./geo.js";
import { autoSendable, geoCheck, getFilters, listListings, overview, setFilters, STATES, transition, TransitionError, type State } from "./listings.js";

const SESSION_MS = 14 * 24 * 3600 * 1000;
const COOKIE = "if_session";
const pwBody = z.object({ password: z.string().min(10, "Mind. 10 Zeichen").max(200) });

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function buildApp(cfg: Config, db: Database.Database, opts: { webDir?: string; generator?: Generator; notify?: (listingId: number) => Promise<void>; monitor?: SessionMonitor; geocoder?: Geocoder; updater?: Updater; telegram?: TelegramHubApi; inspector?: Inspector; fredy?: FredyPort } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", bodyLimit: 2 * 1024 * 1024 });
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof z.ZodError) return reply.code(400).send({ error: "Ungültige Eingabe", issues: e.issues });
    return reply.send(e);
  });
  await app.register(cookie,{ secret: cfg.APP_SECRET });
  await app.register(rateLimit, { global: false });

  const hasUser = () => !!db.prepare("SELECT 1 FROM users").get();
  const isAuthed = (req: FastifyRequest) => {
    const raw = req.cookies[COOKIE];
    const sid = raw ? req.unsignCookie(raw) : null;
    if (!sid?.valid) return false;
    const row = db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(sid.value) as { expires_at: number } | undefined;
    return !!row && row.expires_at > Date.now();
  };
  const startSession = (reply: import("fastify").FastifyReply) => {
    const id = randomBytes(24).toString("hex");
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    db.prepare("INSERT INTO sessions (id, expires_at) VALUES (?, ?)").run(id, Date.now() + SESSION_MS);
    reply.setCookie(COOKIE, id, { httpOnly: true, sameSite: "lax", signed: true, path: "/", maxAge: SESSION_MS / 1000, secure: cfg.PUBLIC_URL.startsWith("https://") });
  };

  const gen = opts.generator ?? (cfg.LLM_PROVIDER === "local" ? localGenerator(cfg) : templateGenerator);
  const notify = opts.notify ?? (async () => {});
  const geocoder = opts.geocoder ?? nominatimGeocoder();
  const fredy: FredyPort = opts.fredy ?? new FredyClient(db);
  // Im Hintergrund und nacheinander: Geocoder (1 Anfrage/s) und lokales Modell sind langsam.
  async function processNew(ids: number[]) {
    for (const id of ids) {
      try {
        // Zweite Stufe: Details von Fredy (nur für Inserate, die den ersten Filter bestanden haben), dann noch einmal filtern.
        if ((await enrichListing(db, fredy, id)) === "dropped") continue;
      } catch (e) { app.log.warn({ err: (e as Error).message, id }, "Detail-Anreicherung fehlgeschlagen, es geht ohne weiter"); }
      try {
        if ((await geoCheck(db, geocoder, id)) === "dropped") continue;
      } catch (e) { app.log.warn({ err: (e as Error).message, id }, "Radius-Prüfung fehlgeschlagen, Inserat bleibt zur manuellen Prüfung"); }
      if (!cfg.AUTO_DRAFT || !activeProfile(db)) continue;
      try {
        await createDraft(db, gen, id);
        await notify(id);
        // Automodus: auch bearbeitete Entwürfe gehen ohne Rückfrage in die Queue (Limits und Nachtruhe gelten im Worker),
        // aber nur mit bekanntem Ort, wenn ein Radius gilt, und nie mit Text vom lokalen Modell (erfindet gelegentlich Details, braucht Sichtprüfung).
        if (getMode(db) === "auto" && autoSendable(db, id) && latestDraft(db, id)?.provider !== "local") approveDraft(db, id);
      } catch (e) { app.log.warn({ err: (e as Error).message, id }, "Auto-Entwurf fehlgeschlagen"); }
    }
  }

  app.get("/api/health", async () => ({ ok: true, dryRun: cfg.DRY_RUN }));


  app.get("/api/auth/status", async (req) => ({ setup: !hasUser(), authed: isAuthed(req) }));

  const strict = { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } };

  app.post("/api/auth/setup", strict, async (req, reply) => {
    if (hasUser()) return reply.code(409).send({ error: "Bereits eingerichtet" });
    const b = pwBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]!.message });
    db.prepare("INSERT INTO users (id, password_hash) VALUES (1, ?)").run(hashPassword(b.data.password));
    startSession(reply);
    return { ok: true };
  });

  app.post("/api/auth/login", strict, async (req, reply) => {
    const b = pwBody.safeParse(req.body);
    const user = db.prepare("SELECT password_hash FROM users WHERE id = 1").get() as { password_hash: string } | undefined;
    if (!b.success || !user || !verifyPassword(b.data.password, user.password_hash)) return reply.code(401).send({ error: "Passwort falsch" });
    startSession(reply);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const raw = req.cookies[COOKIE];
    const sid = raw ? req.unsignCookie(raw) : null;
    if (sid?.valid) db.prepare("DELETE FROM sessions WHERE id = ?").run(sid.value);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  const auth = { preHandler: async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "Nicht angemeldet" });
  } };

// ---- Testlauf: prüft Telegram und den ganzen Weg Inserat → Filter → Entwurf → Telegram-Karte ----
  app.get("/api/telegram", auth, async () => ({ configured: !!opts.telegram?.configured(), chatId: opts.telegram?.chatId() ?? null, source: opts.telegram?.source() ?? null }));
  app.put("/api/telegram", auth, async (req, reply) => {
    if (!opts.telegram) return reply.code(409).send({ error: "Telegram ist in dieser Installation nicht verfügbar" });
    const b = z.object({ token: z.string().trim().max(200).optional(), chatId: z.string().trim().min(1).max(40) }).parse(req.body);
    try { return await opts.telegram.apply(b.token || undefined, b.chatId); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.post("/api/telegram/find-chat", auth, async (req, reply) => {
    if (!opts.telegram) return reply.code(409).send({ error: "Telegram ist in dieser Installation nicht verfügbar" });
    const b = z.object({ token: z.string().trim().max(200).optional() }).parse(req.body ?? {});
    try { return { chats: await opts.telegram.findChats(b.token || undefined) }; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.post("/api/test/telegram", auth, async (_req, reply) => {
    if (!opts.telegram?.configured()) return reply.code(409).send({ error: "Telegram ist nicht eingerichtet. Trage unten Token und Chat-ID ein." });
    try {
      await opts.telegram.sendText("✅ Testnachricht von Instantflat. Telegram ist verbunden.");
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({ error: `Telegram antwortet mit einem Fehler: ${(e as Error).message}` });
    }
  });
  // Das Test-Inserat umgeht die Filter (es soll den Rest der Kette prüfen), liegt im Umkreis und kann verworfen werden.
  app.post("/api/test/listing", auth, async () => {
    const flt = getFilters(db);
    const address = flt.center?.address ?? "Köln";
    const r = db.prepare(
      `INSERT INTO listings (portal, external_id, title, address, price, size, rent, size_m2, rooms, url, description, raw)
       VALUES ('test', ?, 'TESTWOHNUNG: Helle 2-Zimmer-Wohnung mit Balkon', ?, '650 €', '55 m²', 650, 55, 2, 'https://example.com/testwohnung',
               'Dies ist ein Test von Instantflat. Ruhige Lage, Balkon.', '{"test":true}')`,
    ).run(`test-${Date.now()}`, address);
    const id = Number(r.lastInsertRowid);
    transition(db, id, "gefiltert");
    await processNew([id]);
    const l = db.prepare("SELECT state FROM listings WHERE id = ?").get(id) as { state: string };
    const draft = latestDraft(db, id);
    return { id, state: l.state, draft: !!draft, telegram: !!opts.telegram?.configured() && !!draft, activeProfile: !!activeProfile(db) };
  });

  app.get("/api/overview", auth, async () => ({ ...overview(db), recent: listListings(db, { states: ["gefiltert", "entwurf"], limit: 5 }).items }));

  app.get("/api/listings", auth, async (req) => {
    const q = z.object({
      state: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const states = (q.state?.split(",") ?? []).filter((s): s is State => (STATES as readonly string[]).includes(s));
    return listListings(db, { states, limit: q.limit, offset: q.offset });
  });

  // Etappe 2: nur Verwerfen/Reaktivieren. Entwurf/Freigabe/Senden folgen mit KI und Queue.
  app.post("/api/listings/:id/state", auth, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { to } = z.object({ to: z.enum(["verworfen", "gefiltert"]) }).parse(req.body);
    try {
      transition(db, id, to, to === "verworfen" ? "Manuell verworfen" : "Manuell reaktiviert");
    } catch (e) {
      if (e instanceof TransitionError) return reply.code(409).send({ error: e.message });
      throw e;
    }
    return { ok: true };
  });

  const filtersInput = filtersSchema.omit({ center: true }).extend({ centerAddress: z.string().trim().max(200).nullable().default(null) });
  app.get("/api/filters", auth, async () => getFilters(db));
  app.put("/api/filters", auth, async (req, reply) => {
    const { centerAddress, ...rest } = filtersInput.parse(req.body);
    const f = filtersSchema.parse({ ...rest, center: null });
    const radiusOn = f.radiusKm != null;
    if (radiusOn && !centerAddress) return reply.code(400).send({ error: "Für den Radius fehlt der Mittelpunkt (Adresse)" });
    if (centerAddress && radiusOn) {
      const old = getFilters(db).center;
      if (old && old.address === centerAddress) f.center = old; // unverändert: keine neue Anfrage
      else {
        let hit;
        try { hit = await cachedGeocode(db, geocoder, centerAddress); } catch { return reply.code(502).send({ error: "Adresssuche gerade nicht erreichbar, bitte später erneut speichern" }); }
        if (!hit) return reply.code(400).send({ error: "Mittelpunkt nicht gefunden, bitte genauer angeben (Straße, Ort)" });
        f.center = { address: centerAddress, lat: hit.lat, lon: hit.lon, label: hit.label };
      }
    }
    setFilters(db, f);
    return f; // gilt nur für neue Inserate, bestehende werden nicht neu bewertet
  });

  // ---- Portale / Browser ----
  const LOGIN_URL = "/browser/vnc.html?autoconnect=1&resize=scale&path=browser/websockify";
  app.get("/api/portals", auth, async () => ({ monitoring: !!opts.monitor, loginUrl: LOGIN_URL, portals: opts.monitor?.status() ?? [] }));
  app.post("/api/portals/:id/check", auth, async (req, reply) => {
    if (!opts.monitor) return reply.code(409).send({ error: "Session-Überwachung ist aus (SESSION_MONITOR=true)" });
    try { return await opts.monitor.check((req.params as { id: string }).id); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
  });
  app.post("/api/portals/:id/probe", auth, async (req, reply) => {
    if (!opts.monitor) return reply.code(409).send({ error: "Session-Überwachung ist aus (SESSION_MONITOR=true)" });
    const { url, selectors } = z.object({ url: z.string().url().optional(), selectors: z.record(z.string().max(300)).refine((o) => Object.keys(o).length <= 20).optional() }).parse(req.body ?? {});
    try { return await opts.monitor.probe((req.params as { id: string }).id, url, selectors); } catch (e) { return reply.code(502).send({ error: (e as Error).message.split("\n")[0] }); }
  });
  // Kalibrierhilfe: beschreibt eine im Server-Browser offene Seite (nur lesend). Mit compare zusätzlich der Vergleich mit einem ausgeloggten Besuch.
  app.post("/api/portals/:id/inspect", auth, async (req, reply) => {
    if (!opts.inspector) return reply.code(409).send({ error: "Nicht verfügbar (Browser-Container fehlt)" });
    const b = z.object({ match: z.string().max(200).optional(), index: z.number().int().min(0).max(20).optional(), compare: z.boolean().optional() }).parse(req.body ?? {});
    try { return await opts.inspector((req.params as { id: string }).id, b); } catch (e) { return reply.code(502).send({ error: (e as Error).message.split("\n")[0] }); }
  });
  // noVNC des Browser-Containers, nur mit App-Login erreichbar (HTTP und WebSocket).
  await app.register(proxy, { upstream: cfg.BROWSER_VNC_URL, prefix: "/browser", rewritePrefix: "/", websocket: true, ...auth });

  // ---- Einstellungen, Verlauf, Outbox ----
  // Zugangsdaten für Fredys HTTP-Adapter (nur mit Login sichtbar).
  const updater = opts.updater ?? createUpdater(cfg);
  app.get("/api/version", auth, async (req) => updater.version((req.query as { fresh?: string }).fresh === "1"));
  app.post("/api/update", auth, async (_req, reply) => {
    if (!updater.canUpdate) return reply.code(409).send({ error: "Update nicht eingerichtet (Watchtower fehlt in der Compose-Datei)" });
    updater.trigger();
    return { started: true };
  });

  // ---- Fredy-Zugang für die Detail-Anreicherung ----
  app.get("/api/fredy", auth, async () => getFredySettings(db));
  app.put("/api/fredy", auth, async (req) => {
    const b = z.object({ url: z.string().url().max(200).optional(), user: z.string().trim().max(100).optional(), password: z.string().max(200).optional(), enabled: z.boolean().optional() }).parse(req.body);
    setFredySettings(db, b);
    return getFredySettings(db);
  });
  app.post("/api/fredy/test", auth, async (_req, reply) => {
    try { await fredy.test(); return { ok: true }; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  // Für ein vorhandenes Inserat die Details nachladen und neu bewerten (z. B. wenn der Zugang erst jetzt eingerichtet ist).
  app.post("/api/listings/:id/enrich", auth, async (req, reply) => {
    if (!fredy.active()) return reply.code(409).send({ error: "Der Fredy-Zugang ist nicht eingerichtet oder aus (Einstellungen → Fredy-Details)" });
    return { result: await enrichListing(db, fredy, idParam(req)) };
  });

  app.get("/api/ingest-info", auth, async () => ({ endpoint: "http://instantflat:8080/api/ingest", token: cfg.INGEST_TOKEN }));

  app.get("/api/settings", auth, async () => ({ mode: getMode(db), dailyLimit: getDailyLimit(db), dryRun: cfg.DRY_RUN, nightFrom: NIGHT_FROM, nightTo: NIGHT_TO }));
  app.put("/api/settings", auth, async (req) => {
    const b = z.object({ mode: z.enum(["manual", "auto"]).optional(), dailyLimit: z.number().int().min(1).max(50).optional() }).parse(req.body);
    if (b.mode) setMode(db, b.mode);
    if (b.dailyLimit) setDailyLimit(db, b.dailyLimit);
    return { mode: getMode(db), dailyLimit: getDailyLimit(db) };
  });

  app.get("/api/log", auth, async () =>
    (db.prepare(`SELECT s.id, s.portal, s.dry_run AS dryRun, s.result, s.detail, s.shots, s.duration_ms AS durationMs, s.at, l.title
                 FROM send_log s JOIN listings l ON l.id = s.listing_id ORDER BY s.id DESC LIMIT 100`).all() as { shots: string }[]).map((r) => ({ ...r, shots: JSON.parse(r.shots) })));

  app.get("/api/outbox", auth, async () =>
    db.prepare(`SELECT o.id, o.portal, o.status, o.attempts, o.last_error AS lastError, o.queued_at AS queuedAt, l.title
                FROM outbox o JOIN listings l ON l.id = o.listing_id WHERE o.status NOT IN ('sent') ORDER BY o.id DESC LIMIT 100`).all());

  // Bei "unknown" entscheidet der Nutzer: wurde die Nachricht gesendet (dann nie wiederholen) oder nicht (dann zurück in die Queue)?
  app.post("/api/outbox/:id/resolve", auth, async (req, reply) => {
    const { to } = z.object({ to: z.enum(["sent", "queued"]) }).parse(req.body);
    const row = db.prepare("SELECT listing_id, status FROM outbox WHERE id = ?").get(idParam(req)) as { listing_id: number; status: string } | undefined;
    if (!row || row.status !== "unknown") return reply.code(409).send({ error: "Nur Einträge mit unklarem Status" });
    db.transaction(() => {
      db.prepare("UPDATE outbox SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') END WHERE id = ?").run(to, to, idParam(req));
      if (to === "sent") transition(db, row.listing_id, "gesendet", "Manuell als gesendet bestätigt");
    })();
    return { ok: true };
  });

  app.get("/api/screenshots/:name", auth, async (req, reply) => {
    const { name } = z.object({ name: z.string().regex(/^\d+-\d+\.png$/) }).parse(req.params);
    const file = join(cfg.DATA_DIR, "screenshots", name);
    if (!existsSync(file)) return reply.code(404).send({ error: "Nicht gefunden" });
    return reply.type("image/png").send(readFileSync(file));
  });

  // ---- Profile ----
  const idParam = (req: FastifyRequest) => z.object({ id: z.coerce.number().int() }).parse(req.params).id;
  const profileBody = z.object({ name: z.string().trim().min(1).max(60), data: profileSchema });
  app.get("/api/profiles", auth, async () => listProfiles(db));
  app.post("/api/profiles", auth, async (req) => {
    const b = profileBody.parse(req.body);
    return { id: createProfile(db, b.name, b.data) };
  });
  app.put("/api/profiles/:id", auth, async (req, reply) => {
    const b = profileBody.parse(req.body);
    return updateProfile(db, idParam(req), b.name, b.data) ? { ok: true } : reply.code(404).send({ error: "Profil nicht gefunden" });
  });
  app.post("/api/profiles/:id/activate", auth, async (req, reply) => (activateProfile(db, idParam(req)) ? { ok: true } : reply.code(404).send({ error: "Profil nicht gefunden" })));
  app.delete("/api/profiles/:id", auth, async (req, reply) => {
    const r = deleteProfile(db, idParam(req));
    if (r === "active") return reply.code(409).send({ error: "Das aktive Profil kann nicht gelöscht werden" });
    return r === "ok" ? { ok: true } : reply.code(404).send({ error: "Profil nicht gefunden" });
  });

  // ---- Entwürfe ----
  const draftErr = (e: unknown, reply: import("fastify").FastifyReply) => {
    if (e instanceof DraftError || e instanceof TransitionError) return reply.code(409).send({ error: e.message });
    throw e;
  };
  app.get("/api/listings/:id/draft", auth, async (req) => latestDraft(db, idParam(req)));
  app.post("/api/listings/:id/draft", auth, async (req, reply) => {
    try {
      const d = await createDraft(db, gen, idParam(req));
      void notify(d.listingId).catch((e) => app.log.warn({ err: (e as Error).message }, "Telegram-Benachrichtigung fehlgeschlagen"));
      return d;
    } catch (e) { return draftErr(e, reply); }
  });
  app.put("/api/listings/:id/draft", auth, async (req, reply) => {
    const id = idParam(req);
    const { body } = z.object({ body: z.string().trim().min(1).max(3000) }).parse(req.body);
    const l = db.prepare("SELECT state FROM listings WHERE id = ?").get(id) as { state: string } | undefined;
    if (l?.state !== "entwurf") return reply.code(409).send({ error: "Nur im Status Entwurf änderbar" });
    return saveDraft(db, id, body, "manuell");
  });
  app.post("/api/listings/:id/approve", auth, async (req, reply) => {
    try { approveDraft(db, idParam(req)); return { ok: true }; } catch (e) { return draftErr(e, reply); }
  });

  // Fredy → Instantflat. Eigene Token-Auth, keine Session.
  app.post("/api/ingest", async (req, reply) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m || !safeEq(m[1]!, cfg.INGEST_TOKEN)) return reply.code(401).send({ error: "Ungültiges Token" });
    try {
      const { passed, ...res } = ingest(db, req.body);
      void processNew(passed);
      return res;
    } catch (e) {
      if (e instanceof z.ZodError) return reply.code(400).send({ error: "Ungültige Payload", issues: e.issues });
      throw e;
    }
  });

  const webDir = resolve(opts.webDir ?? "../web/dist");
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html")));
  }
  return app;
}
