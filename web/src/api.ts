export type Listing = {
  id: number; portal: string; title: string; address: string | null; price: string | null; size: string | null;
  rent: number | null; sizeM2: number | null; rooms: number | null; url: string | null; imageUrl: string | null;
  description: string | null; state: string; filterReason: string | null; foundAt: string; distKm: number | null; geo: "ok" | "approx" | "unknown" | null;
  contactName: string | null; contactKind: "person" | "company" | null; contactSalutation: "Herr" | "Frau" | null; enriched: "ok" | "failed" | null;
};
export type Overview = { today: number; waiting: number; filtered: number; total: number; portals: { portal: string; count: number }[]; recent: Listing[] };
export type Filters = { maxRent: number | null; minSize: number | null; minRooms: number | null; districts: string[]; excludeWords: string[]; center: { address: string; lat: number; lon: number; label: string } | null; radiusKm: number | null };

export const PORTAL_NAMES: Record<string, string> = { immoscout24: "ImmoScout24", kleinanzeigen: "Kleinanzeigen", immowelt: "Immowelt", wggesucht: "WG-Gesucht", test: "Test" };

export async function api<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const r = await fetch(path, method === "GET" ? undefined : { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `Fehler ${r.status}`);
  return j as T;
}

export function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso.replace(" ", "T") + "Z").getTime()) / 60000));
  if (m < 1) return "gerade eben";
  if (m < 60) return `${m} Min`;
  return m < 1440 ? `${Math.round(m / 60)} Std` : `${Math.round(m / 1440)} T`;
}

export type ProfileData = {
  fullName: string; age: number | null; city: string; job: string; employment: string; household: string;
  pets: string; moveIn: string; viewingTimes: string; documentsReady: boolean; extra: string;
};
export type Profile = { id: number; name: string; active: boolean; data: ProfileData };
export type Draft = { id: number; listingId: number; version: number; body: string; provider: string; createdAt: string };

export type PortalStatus = { portal: string; name: string; state: "ok" | "session_expired" | "interaction_required" | "error" | "unknown"; detail: string | null; checkedAt: string | null; since: string | null };
export type AppSettings = { mode: "manual" | "auto"; dailyLimit: number; dryRun: boolean; nightFrom: number; nightTo: number };
export type LogEntry = { id: number; portal: string; dryRun: number; result: "ok" | "dry_run" | "failed"; detail: string | null; shots: string[]; durationMs: number | null; at: string; title: string };
export type OutboxEntry = { id: number; portal: string; status: "queued" | "sending" | "dry_done" | "failed" | "unknown"; attempts: number; lastError: string | null; queuedAt: string; title: string };
export type PortalsInfo ={ monitoring: boolean; loginUrl: string; portals: PortalStatus[] };
