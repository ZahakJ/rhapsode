import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import path from "node:path"

export function openDb(file: string): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  migrate(db)
  return db
}

// The ladder: index i is the step that takes user_version from i to i+1.
// Append only — never edit a rung that has shipped.
export const MIGRATIONS: string[] = [
  `
    CREATE TABLE sources (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL CHECK (kind IN ('url','upload')),
      media        TEXT NOT NULL CHECK (media IN ('video','image')),
      status       TEXT NOT NULL CHECK (status IN ('pending','ready','failed')),
      url          TEXT,
      title        TEXT NOT NULL DEFAULT '',
      ext          TEXT NOT NULL DEFAULT '',
      duration     REAL,
      width        INTEGER,
      height       INTEGER,
      fps          REAL,
      has_audio    INTEGER NOT NULL DEFAULT 0,
      window_start REAL,
      window_end   REAL,
      sha256       TEXT,
      bytes        INTEGER NOT NULL DEFAULT 0,
      error        TEXT,
      job_id       TEXT,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX sources_sha ON sources(sha256);
    CREATE INDEX sources_created ON sources(created_at);

    CREATE TABLE renders (
      id          INTEGER PRIMARY KEY,
      slug        TEXT NOT NULL UNIQUE,
      title       TEXT NOT NULL DEFAULT '',
      recipe_json TEXT NOT NULL,
      duration    REAL NOT NULL,
      width       INTEGER NOT NULL,
      height      INTEGER NOT NULL,
      bytes       INTEGER NOT NULL,
      job_id      TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX renders_created ON renders(created_at DESC, id DESC);

    CREATE TABLE render_sources (
      render_id INTEGER NOT NULL REFERENCES renders(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id),
      PRIMARY KEY (render_id, source_id)
    );
    CREATE INDEX render_sources_source ON render_sources(source_id);

    CREATE TABLE jobs (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL CHECK (kind IN ('fetch','render')),
      status       TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
      stage        TEXT,
      progress     REAL,
      error        TEXT,
      payload_json TEXT NOT NULL,
      result_json  TEXT,
      created_at   INTEGER NOT NULL,
      started_at   INTEGER,
      finished_at  INTEGER
    );
    CREATE INDEX jobs_status ON jobs(status, created_at);
  `,
]

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]!)
    // PRAGMA takes no bind parameters; v is a loop counter, not input
    db.exec(`PRAGMA user_version = ${v + 1}`)
  }
}
