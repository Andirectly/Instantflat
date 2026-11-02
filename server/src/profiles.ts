import type Database from "better-sqlite3";
import { z } from "zod";

const opt = z.string().trim().max(500).default("");
export const profileSchema = z.object({
  fullName: z.string().trim().min(1).max(100),
  age: z.number().int().min(16).max(110).nullable().default(null),
  city: opt, // aktueller Wohnort
  job: opt,
  employment: opt, // z. B. "fest angestellt"
  household: opt, // z. B. "1 Person"
  pets: opt, // leer = nichts erwähnen; "keine Haustiere" ist ein Fakt
  moveIn: opt,
  viewingTimes: opt,
  documentsReady: z.boolean().default(false),
  extra: z.string().trim().max(1000).default(""),
});
export type ProfileData = z.infer<typeof profileSchema>;
export type Profile = { id: number; name: string; active: boolean; data: ProfileData };

type Row = { id: number; name: string; data: string; active: number };
const toProfile = (r: Row): Profile => ({ id: r.id, name: r.name, active: !!r.active, data: profileSchema.parse(JSON.parse(r.data)) });

export const listProfiles = (db: Database.Database) => (db.prepare("SELECT * FROM profiles ORDER BY id").all() as Row[]).map(toProfile);

export function activeProfile(db: Database.Database): Profile | null {
  const r = db.prepare("SELECT * FROM profiles WHERE active = 1").get() as Row | undefined;
  return r ? toProfile(r) : null;
}

export function createProfile(db: Database.Database, name: string, data: ProfileData): number {
  const first = !db.prepare("SELECT 1 FROM profiles").get(); // erstes Profil wird automatisch aktiv
  return Number(db.prepare("INSERT INTO profiles (name, data, active) VALUES (?, ?, ?)").run(name, JSON.stringify(data), first ? 1 : 0).lastInsertRowid);
}

export const updateProfile = (db: Database.Database, id: number, name: string, data: ProfileData) =>
  db.prepare("UPDATE profiles SET name = ?, data = ? WHERE id = ?").run(name, JSON.stringify(data), id).changes > 0;

export function activateProfile(db: Database.Database, id: number): boolean {
  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(id)) return false;
    db.prepare("UPDATE profiles SET active = 0").run();
    db.prepare("UPDATE profiles SET active = 1 WHERE id = ?").run(id);
    return true;
  })();
}

export function deleteProfile(db: Database.Database, id: number): "ok" | "active" | "missing" {
  const r = db.prepare("SELECT active FROM profiles WHERE id = ?").get(id) as { active: number } | undefined;
  if (!r) return "missing";
  if (r.active) return "active";
  db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  return "ok";
}
