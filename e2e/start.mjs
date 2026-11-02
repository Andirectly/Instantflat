// Startet den gebauten Server mit frischer Test-DB (nur für E2E).
import { rmSync } from "node:fs";
import { resolve } from "node:path";
const data = resolve("e2e/.data");
rmSync(data, { recursive: true, force: true });
Object.assign(process.env, { APP_SECRET: "e".repeat(32), INGEST_TOKEN: "e2e-ingest-token-123456", DATA_DIR: data, APP_PORT: "18080", NODE_ENV: "production" });
process.chdir("server");
await import("../server/dist/index.js");
