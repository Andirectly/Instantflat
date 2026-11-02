import { join } from "node:path";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { buildApp } from "./app.js";
import { startTelegram } from "./telegram.js";
import { SessionMonitor } from "./portals/monitor.js";
import { cdpWithPage } from "./portals/cdp.js";
import { mockPortal, REAL_PORTALS } from "./portals/defs.js";
import { loadPortalDefs } from "./portals/config.js";
import { Worker } from "./worker.js";

const cfg = loadConfig();
const db = openDb(join(cfg.DATA_DIR, "instantflat.db"));
const log = (m: string) => console.log(JSON.stringify({ msg: m }));
const tg = cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID ? startTelegram(db, cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID, cfg.PUBLIC_URL, log) : null;
const defs = loadPortalDefs(cfg.MOCK_PORTAL_URL ? [mockPortal(cfg.MOCK_PORTAL_URL)] : REAL_PORTALS, cfg.PORTALS_CONFIG ?? join(cfg.DATA_DIR, "portals.json"));
const say = async (t: string) => void (await tg?.sendText(t));
const withPage = cdpWithPage(cfg.BROWSER_CDP_URL);
const monitor = cfg.SESSION_MONITOR
  ? new SessionMonitor(db, defs, withPage, say, `${cfg.PUBLIC_URL}/browser/vnc.html?autoconnect=1&resize=scale&path=browser/websockify`)
  : undefined;
const app = await buildApp(cfg, db, { notify: tg ? (id) => tg.notifyDraft(id) : undefined, monitor });
monitor?.start();
// Der Worker sendet nur, wenn die Session-Überwachung läuft (er braucht den Portalstatus).
if (monitor) new Worker(db, defs, monitor, withPage, { dryRun: cfg.DRY_RUN, shotDir: join(cfg.DATA_DIR, "screenshots"), notify: say }).start();
await app.listen({ port: cfg.APP_PORT, host: "0.0.0.0" });
if (cfg.DRY_RUN) app.log.warn("DRY_RUN aktiv: es wird nichts final gesendet");
if (!tg) app.log.info("Telegram aus (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID fehlen)");
