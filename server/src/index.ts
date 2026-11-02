import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureSecrets } from "./secrets.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { buildApp } from "./app.js";
import { TelegramHub } from "./telegram.js";
import { SessionMonitor } from "./portals/monitor.js";
import { cdpOpenTab, cdpWithPage } from "./portals/cdp.js";
import { mockPortal, REAL_PORTALS } from "./portals/defs.js";
import { loadPortalDefs } from "./portals/config.js";
import { Worker } from "./worker.js";
import { inspectPortal } from "./portals/inspect.js";

const cfg = loadConfig(ensureSecrets(process.env, process.env.DATA_DIR ?? "./data"));
const db = openDb(join(cfg.DATA_DIR, "instantflat.db"));
const log = (m: string) => console.log(JSON.stringify({ msg: m }));
const tg = new TelegramHub(db, { token: cfg.TELEGRAM_BOT_TOKEN, chatId: cfg.TELEGRAM_CHAT_ID }, cfg.PUBLIC_URL, log);
tg.start();
// Eigene portals.json im Datenordner gewinnt, sonst die im Image mitgelieferte (config/portals.json).
const portalsFile = () => {
  if (cfg.PORTALS_CONFIG) return cfg.PORTALS_CONFIG;
  const own = join(cfg.DATA_DIR, "portals.json");
  return existsSync(own) ? own : join(process.cwd(), "..", "config", "portals.json");
};
const defs = loadPortalDefs(cfg.MOCK_PORTAL_URL ? [mockPortal(cfg.MOCK_PORTAL_URL)] : REAL_PORTALS, portalsFile());
const say = async (t: string) => { if (tg.configured()) await tg.sendText(t); };
const withPage = cdpWithPage(cfg.BROWSER_CDP_URL);
const monitor = cfg.SESSION_MONITOR
  ? new SessionMonitor(db, defs, withPage, say, `${cfg.PUBLIC_URL}/browser/vnc.html?autoconnect=1&resize=scale&path=browser/websockify`, Math.random, cdpOpenTab(cfg.BROWSER_CDP_URL))
  : undefined;
const app = await buildApp(cfg, db, { notify: (id) => tg.notifyDraft(id), monitor, telegram: tg,
  inspector: async (id, o) => {
    const def = defs.find((d) => d.id === id);
    if (!def) throw new Error("Unbekanntes Portal");
    return inspectPortal(cfg.BROWSER_CDP_URL, def, o);
  },
});
monitor?.start();
// Der Worker sendet nur, wenn die Session-Überwachung läuft (er braucht den Portalstatus).
const worker = monitor ? new Worker(db, defs, monitor, withPage, { dryRun: cfg.DRY_RUN, shotDir: join(cfg.DATA_DIR, "screenshots"), notify: say }) : undefined;
worker?.start();
await app.listen({ port: cfg.APP_PORT, host: "0.0.0.0" });
if (cfg.DRY_RUN) app.log.warn("DRY_RUN aktiv: es wird nichts final gesendet");
if (!tg.configured()) app.log.info("Telegram noch nicht eingerichtet (Einstellungen → Telegram)");

// Sauber beenden (docker stop / Update): Timer anhalten, Server schließen, Datenbank flushen. Ohne das wartet Docker 30 s bis zum Kill.
const shutdown = async () => {
  monitor?.stop();
  worker?.stop();
  await app.close().catch(() => {});
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
