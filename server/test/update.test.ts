import { describe, expect, it, vi } from "vitest";
import { createUpdater } from "../src/update.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";

const base = { UPDATE_REPO: "Andirectly/Instantflat" };
const runs = (sha: string | null) => new Response(JSON.stringify({ workflow_runs: sha ? [{ head_sha: sha }] : [] }));

describe("createUpdater", () => {
  it("meldet ein Update, wenn der letzte Image-Lauf ein anderer Commit ist", async () => {
    const f = vi.fn().mockResolvedValue(runs("b".repeat(40)));
    const u = createUpdater({ ...base, BUILD_SHA: "a".repeat(40), UPDATE_URL: "http://wt:8080", UPDATE_TOKEN: "t" }, f);
    expect(await u.version()).toEqual({ current: "aaaaaaa", latest: "bbbbbbb", updateAvailable: true, canUpdate: true });
    await u.version();
    expect(f).toHaveBeenCalledTimes(1); // zehn Minuten im Zwischenspeicher
  });

  it("fresh=true umgeht den Zwischenspeicher", async () => {
    const f = vi.fn().mockResolvedValueOnce(runs("b".repeat(40))).mockResolvedValueOnce(runs("c".repeat(40)));
    const u = createUpdater({ ...base, BUILD_SHA: "a".repeat(40) }, f);
    expect((await u.version()).latest).toBe("bbbbbbb");
    expect((await u.version()).latest).toBe("bbbbbbb"); // gecacht
    expect((await u.version(true)).latest).toBe("ccccccc"); // frisch
  });

  it("gleicher Stand, Entwicklungsstand oder GitHub nicht erreichbar: kein Update gemeldet", async () => {
    const same = createUpdater({ ...base, BUILD_SHA: "c".repeat(40) }, vi.fn().mockResolvedValue(runs("c".repeat(40))));
    expect((await same.version()).updateAvailable).toBe(false);
    const dev = createUpdater({ ...base, BUILD_SHA: "dev" }, vi.fn().mockResolvedValue(runs("d".repeat(40))));
    expect((await dev.version()).updateAvailable).toBe(false);
    const down = createUpdater({ ...base, BUILD_SHA: "e".repeat(40) }, vi.fn().mockRejectedValue(new Error("offline")));
    expect(await down.version()).toMatchObject({ latest: null, updateAvailable: false });
    const limit = createUpdater({ ...base, BUILD_SHA: "e".repeat(40) }, vi.fn().mockResolvedValue(new Response("", { status: 403 })));
    expect((await limit.version()).latest).toBeNull();
  });

  it("trigger ruft Watchtower mit Token auf, ohne Einrichtung wirft es", () => {
    const f = vi.fn().mockResolvedValue(new Response("{}"));
    createUpdater({ ...base, BUILD_SHA: "x", UPDATE_URL: "http://wt:8080", UPDATE_TOKEN: "geheim" }, f).trigger();
    expect(f).toHaveBeenCalledWith("http://wt:8080/v1/update", { method: "POST", headers: { authorization: "Bearer geheim" } });
    expect(() => createUpdater({ ...base, BUILD_SHA: "x" }, f).trigger()).toThrow();
  });
});

describe("Update-API", () => {
  const env = { APP_SECRET: "x".repeat(32), INGEST_TOKEN: "t".repeat(24) };
  it("nur mit Login; ohne Watchtower 409; mit Watchtower startet es", async () => {
    process.env.NODE_ENV = "test";
    const mk = async (extra: object) => {
      const f = vi.fn().mockResolvedValue(runs("f".repeat(40)));
      const cfg = loadConfig({ ...env, ...extra });
      const app = await buildApp(cfg, openDb(":memory:"), { webDir: "/nonexistent", updater: createUpdater(cfg, f) });
      const s = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse 1" } });
      return { app, f, cookies: { [s.cookies[0]!.name]: s.cookies[0]!.value } };
    };
    const a = await mk({});
    expect((await a.app.inject({ url: "/api/version" })).statusCode).toBe(401);
    expect((await a.app.inject({ method: "POST", url: "/api/update" })).statusCode).toBe(401);
    expect((await a.app.inject({ method: "POST", url: "/api/update", cookies: a.cookies })).statusCode).toBe(409);
    const b = await mk({ BUILD_SHA: "1".repeat(40), UPDATE_URL: "http://wt:8080", UPDATE_TOKEN: "t" });
    expect((await b.app.inject({ url: "/api/version", cookies: b.cookies })).json()).toMatchObject({ updateAvailable: true, canUpdate: true });
    expect((await b.app.inject({ method: "POST", url: "/api/update", cookies: b.cookies })).json()).toEqual({ started: true });
    expect(b.f.mock.calls.some((c) => String(c[0]).endsWith("/v1/update"))).toBe(true);
  });
});
