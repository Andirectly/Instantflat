import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Nur anhängen, nie ändern: Index + 1 = user_version.
export const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     password_hash TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE listings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     portal TEXT NOT NULL,
     external_id TEXT NOT NULL,
     title TEXT NOT NULL,
     address TEXT,
     price TEXT,
     size TEXT,
     url TEXT,
     image_url TEXT,
     description TEXT,
     job_id TEXT,
     state TEXT NOT NULL DEFAULT 'gefunden',
     raw TEXT NOT NULL,
     found_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (portal, external_id)
   );`,
  `ALTER TABLE listings ADD COLUMN rent REAL;
   ALTER TABLE listings ADD COLUMN size_m2 REAL;
   ALTER TABLE listings ADD COLUMN rooms REAL;
   ALTER TABLE listings ADD COLUMN filter_reason TEXT;
   CREATE TABLE filters (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     data TEXT NOT NULL
   );
   CREATE TABLE listing_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     listing_id INTEGER NOT NULL REFERENCES listings(id),
     from_state TEXT NOT NULL,
     to_state TEXT NOT NULL,
     reason TEXT,
     at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_listings_state ON listings(state);`,
  `CREATE TABLE profiles (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     data TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 0
   );
   CREATE UNIQUE INDEX idx_one_active_profile ON profiles(active) WHERE active = 1;
   CREATE TABLE drafts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     listing_id INTEGER NOT NULL REFERENCES listings(id),
     version INTEGER NOT NULL,
     body TEXT NOT NULL,
     provider TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (listing_id, version)
   );`,
  `CREATE TABLE portal_sessions (
     portal TEXT PRIMARY KEY,
     state TEXT NOT NULL,
     detail TEXT,
     checked_at TEXT NOT NULL DEFAULT (datetime('now')),
     since TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE session_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     portal TEXT NOT NULL,
     from_state TEXT,
     to_state TEXT NOT NULL,
     at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     listing_id INTEGER NOT NULL UNIQUE REFERENCES listings(id),
     portal TEXT NOT NULL,
     draft_id INTEGER NOT NULL REFERENCES drafts(id),
     status TEXT NOT NULL DEFAULT 'queued',
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     queued_at TEXT NOT NULL DEFAULT (datetime('now')),
     sent_at TEXT
   );
   CREATE TABLE send_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     outbox_id INTEGER NOT NULL REFERENCES outbox(id),
     listing_id INTEGER NOT NULL,
     portal TEXT NOT NULL,
     dry_run INTEGER NOT NULL,
     result TEXT NOT NULL,
     detail TEXT,
     shots TEXT NOT NULL DEFAULT '[]',
     duration_ms INTEGER,
     at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
  `ALTER TABLE listings ADD COLUMN lat REAL;
   ALTER TABLE listings ADD COLUMN lon REAL;
   ALTER TABLE listings ADD COLUMN dist_km REAL;
   ALTER TABLE listings ADD COLUMN geo TEXT;
   CREATE TABLE geocache (
     q TEXT PRIMARY KEY,
     lat REAL,
     lon REAL,
     precision TEXT NOT NULL,
     label TEXT,
     at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
];

export function openDb(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
