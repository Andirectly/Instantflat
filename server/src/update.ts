import type { Config } from "./config.js";

export type VersionInfo = { current: string; latest: string | null; updateAvailable: boolean; canUpdate: boolean };

/**
 * Version und Selbst-Update. "Neueste Version" = Commit des letzten erfolgreichen Docker-Image-Laufs auf main
 * (Commits ohne neues Image, z. B. nur Doku, zählen dadurch nicht). Das Einspielen übernimmt Watchtower (nur auf Knopfdruck).
 */
export function createUpdater(cfg: Pick<Config, "BUILD_SHA" | "UPDATE_URL" | "UPDATE_TOKEN" | "UPDATE_REPO">, fetchImpl: typeof fetch = fetch) {
  let cache: { at: number; sha: string | null } | undefined;

  async function latest(): Promise<string | null> {
    if (cache && Date.now() - cache.at < 10 * 60_000) return cache.sha;
    let sha: string | null = null;
    try {
      const r = await fetchImpl(`https://api.github.com/repos/${cfg.UPDATE_REPO}/actions/workflows/docker.yml/runs?branch=main&status=success&per_page=1`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "Instantflat" },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) sha = ((await r.json()) as { workflow_runs?: { head_sha?: string }[] }).workflow_runs?.[0]?.head_sha ?? null;
    } catch { /* offline oder Limit erreicht: keine Aussage */ }
    cache = { at: Date.now(), sha };
    return sha;
  }

  const canUpdate = !!(cfg.UPDATE_URL && cfg.UPDATE_TOKEN);

  return {
    canUpdate,
    async version(fresh = false): Promise<VersionInfo> {
      if (fresh) cache = undefined; // Einstellungsseite: immer aktuell nachfragen
      const l = await latest();
      return { current: cfg.BUILD_SHA.slice(0, 7), latest: l?.slice(0, 7) ?? null, updateAvailable: cfg.BUILD_SHA !== "dev" && !!l && l !== cfg.BUILD_SHA, canUpdate };
    },
    /** Stößt Watchtower an und wartet nicht: das Update ersetzt diese App, die Antwort würde sonst abreißen. */
    trigger(): void {
      if (!canUpdate) throw new Error("Update nicht eingerichtet");
      void fetchImpl(`${cfg.UPDATE_URL}/v1/update`, { method: "POST", headers: { authorization: `Bearer ${cfg.UPDATE_TOKEN}` } }).catch(() => {});
      cache = undefined;
    },
  };
}
export type Updater = ReturnType<typeof createUpdater>;
