import { z } from "zod";

const schema = z.object({
  APP_SECRET: z.string().min(32, "APP_SECRET braucht mind. 32 Zeichen"),
  INGEST_TOKEN: z.string().min(16, "INGEST_TOKEN braucht mind. 16 Zeichen"),
  PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  DRY_RUN: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  APP_PORT: z.coerce.number().int().default(8080),
  DATA_DIR: z.string().default("./data"),
  // template = Bausteintext ohne KI (Standard), local = OpenAI-kompatibler lokaler Server (llama-server)
  LLM_PROVIDER: z.enum(["template", "local"]).default("template"),
  LLM_URL: z.string().url().default("http://llm:8081"),
  LLM_MODEL: z.string().default("bonsai"),
  LLM_TIMEOUT_S: z.coerce.number().int().positive().default(300),
  AUTO_DRAFT: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Session-Überwachung (braucht den Container "browser")
  SESSION_MONITOR: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  BROWSER_CDP_URL: z.string().url().default("http://browser:9223"),
  BROWSER_VNC_URL: z.string().url().default("http://browser:6080"),
  PORTALS_CONFIG: z.string().optional(), // Pfad zu portals.json (Standard: DATA_DIR/portals.json)
  MOCK_PORTAL_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Leere Strings aus .env (z. B. `ANTHROPIC_API_KEY=`) gelten als nicht gesetzt.
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const r = schema.safeParse(clean);
  if (!r.success) {
    throw new Error("Ungültige Konfiguration:\n" + r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
  }
  return r.data;
}
