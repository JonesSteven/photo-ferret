import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { DEFAULT_SETTINGS, type AttributeValue, type ClassifyResult, type JevStatus, type SiteSettings } from "../shared/types.ts";
import type { JevAttribute } from "./jev.ts";
import { DATA_DIR } from "./storage.ts";

// Ordered migrations; the index + 1 is the schema version. Only ever append.
const MIGRATIONS = [
  `CREATE TABLE photos (
     id            TEXT PRIMARY KEY,
     original_name TEXT NOT NULL,
     original_ext  TEXT NOT NULL,
     mime          TEXT NOT NULL,
     bytes         INTEGER NOT NULL,
     sha256        TEXT NOT NULL UNIQUE,
     width         INTEGER,
     height        INTEGER,
     title         TEXT,
     description   TEXT,
     published     INTEGER NOT NULL DEFAULT 1,
     created_at    TEXT NOT NULL,
     derived_ready INTEGER NOT NULL DEFAULT 0,
     jev_status    TEXT NOT NULL DEFAULT 'pending',
     jev_error     TEXT,
     jev_model     TEXT,
     jev_result    TEXT,
     classified_at TEXT
   );
   CREATE INDEX photos_created ON photos (created_at);
   -- One row per photo per attribute (see ATTRIBUTES in questions.ts). New metadata = new attr names.
   CREATE TABLE photo_attributes (
     photo_id       TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
     attr           TEXT NOT NULL,
     jev_value      TEXT,
     jev_confidence REAL,
     override_value TEXT,
     PRIMARY KEY (photo_id, attr)
   );`,
  // Per-attribute detail from Jev (level probabilities, P(present), P(yes)) as JSON; see AttributeDetail.
  `ALTER TABLE photo_attributes ADD COLUMN jev_detail TEXT;`,
  // Site settings set in the admin (see SiteSettings), one JSON value per key.
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // When the photo was taken, from the original's EXIF DateTimeOriginal ("YYYY-MM-DDTHH:MM:SS", camera
  // local time, no zone); null when the original has none. Sorts "Newest first".
  `ALTER TABLE photos ADD COLUMN taken_at TEXT;`,
  // A sequential number per photo, for its public name ("Image 12", file "Image_12.jpg"); the original file
  // name is shown only in the admin. Existing photos are numbered in upload order.
  `ALTER TABLE photos ADD COLUMN seq INTEGER;
   UPDATE photos SET seq = (SELECT COUNT(*) FROM photos p2 WHERE p2.created_at < photos.created_at OR (p2.created_at = photos.created_at AND p2.id <= photos.id));
   CREATE UNIQUE INDEX photos_seq ON photos (seq);`,
];

// Bumped by every write, so readers (the public gallery cache in photos.ts) know when to reload.
let version = 0;

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "photos.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
{
  const current = (db.prepare("SELECT MAX(version) AS v FROM schema_version").get()?.v as number | null) ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(() => {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(v + 1);
    });
  }
}

// Changes after any write: this process's own counter, plus SQLite's data_version, which changes when
// another process (e.g. npm run remeasure) commits to the database.
export const dataVersion = () => `${version}:${(db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version}`;

function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    version++;
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface PhotoRow {
  id: string;
  original_name: string;
  original_ext: string;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  title: string | null;
  description: string | null;
  published: number;
  created_at: string;
  taken_at: string | null;
  seq: number;
  derived_ready: number;
  jev_status: JevStatus;
  jev_error: string | null;
  jev_model: string | null;
  jev_result: string | null;
  classified_at: string | null;
}

interface AttributeRow {
  photo_id: string;
  attr: string;
  jev_value: string | null;
  jev_confidence: number | null;
  jev_detail: string | null;
  override_value: string | null;
}

const now = () => new Date().toISOString();

export function insertPhoto(p: Pick<PhotoRow, "id" | "original_name" | "original_ext" | "mime" | "bytes" | "sha256">) {
  db.prepare(
    `INSERT INTO photos (id, original_name, original_ext, mime, bytes, sha256, created_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM photos))`,
  ).run(p.id, p.original_name, p.original_ext, p.mime, p.bytes, p.sha256, now());
  version++;
}

export function getPhoto(id: string) {
  return db.prepare("SELECT * FROM photos WHERE id = ?").get(id) as PhotoRow | undefined;
}

export function findBySha256(sha256: string) {
  return db.prepare("SELECT * FROM photos WHERE sha256 = ?").get(sha256) as PhotoRow | undefined;
}

// Public: what the gallery (data.json) shows.
const PUBLIC = "published = 1 AND derived_ready = 1 AND jev_status = 'done'";

export function listPhotos(opts: { publicOnly: boolean }) {
  const where = opts.publicOnly ? `WHERE ${PUBLIC}` : "";
  return db.prepare(`SELECT * FROM photos ${where} ORDER BY created_at DESC, id`).all() as unknown as PhotoRow[];
}

// A public photo by its image number, as the site's image paths name it.
export function getPublicBySeq(seq: number) {
  return db.prepare(`SELECT * FROM photos WHERE seq = ? AND ${PUBLIC}`).get(seq) as PhotoRow | undefined;
}

export function listPendingIds() {
  return (db.prepare("SELECT id FROM photos WHERE jev_status = 'pending' ORDER BY created_at").all() as { id: string }[]).map((r) => r.id);
}

export function updatePhoto(id: string, fields: Partial<Omit<PhotoRow, "id">>) {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE photos SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k] as SQLInputValue), id);
  version++;
}

export function deletePhoto(id: string) {
  db.prepare("DELETE FROM photos WHERE id = ?").run(id);
  version++;
}

function upsertJev(id: string, attrs: JevAttribute[]) {
  const upsert = db.prepare(
    `INSERT INTO photo_attributes (photo_id, attr, jev_value, jev_confidence, jev_detail) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (photo_id, attr) DO UPDATE SET jev_value = excluded.jev_value, jev_confidence = excluded.jev_confidence,
       jev_detail = excluded.jev_detail`,
  );
  for (const a of attrs) upsert.run(id, a.attr, a.value, a.confidence, a.detail ? JSON.stringify(a.detail) : null);
}

// Saves a Jev run. Admin overrides are kept, so re-running Jev never undoes manual edits. Values from the
// previous run that this run didn't produce (e.g. sky drama when there is no sky) become unknown.
export function saveClassification(id: string, result: ClassifyResult, attrs: JevAttribute[]) {
  tx(() => {
    db.prepare("UPDATE photo_attributes SET jev_value = NULL, jev_confidence = NULL, jev_detail = NULL WHERE photo_id = ?").run(id);
    upsertJev(id, attrs);
    updatePhoto(id, {
      jev_status: "done",
      jev_error: null,
      jev_model: result.model,
      jev_result: JSON.stringify(result),
      classified_at: now(),
    });
  });
}

// Drops rows for attributes that no longer exist and overrides that are no longer valid (e.g. a removed
// primary-subject option), so changing ATTRIBUTES never leaves stale data behind.
export function pruneAttributes(validIds: Set<string>, isValid: (attr: string, value: string) => boolean) {
  tx(() => {
    const ids = JSON.stringify([...validIds]);
    db.prepare("DELETE FROM photo_attributes WHERE attr NOT IN (SELECT value FROM json_each(?))").run(ids);
    const rows = db.prepare("SELECT photo_id, attr, override_value FROM photo_attributes WHERE override_value IS NOT NULL").all() as unknown as AttributeRow[];
    const clear = db.prepare("UPDATE photo_attributes SET override_value = NULL WHERE photo_id = ? AND attr = ?");
    for (const r of rows) if (!isValid(r.attr, r.override_value!)) clear.run(r.photo_id, r.attr);
  });
}

// Saves values measured in code without touching the rest (used when re-measuring existing photos).
// `measuredIds` are all the tags being re-measured: any of them without a new value becomes unknown.
export function saveMeasured(id: string, attrs: JevAttribute[], measuredIds: string[]) {
  tx(() => {
    const clear = db.prepare("UPDATE photo_attributes SET jev_value = NULL, jev_confidence = NULL, jev_detail = NULL WHERE photo_id = ? AND attr = ?");
    for (const attr of measuredIds) clear.run(id, attr);
    upsertJev(id, attrs);
  });
}

export function markAllPending() {
  db.prepare("UPDATE photos SET jev_status = 'pending', jev_error = NULL WHERE derived_ready = 1").run();
  version++;
  return listPendingIds();
}

// Site settings: stored values over the defaults, so a new setting needs no migration. Rows for removed
// settings (simpleView, mainSubject, mapView) are ignored.
export function getSettings(): SiteSettings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const stored = Object.fromEntries(rows.filter((r) => r.key in DEFAULT_SETTINGS).map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(patch: Partial<SiteSettings>) {
  tx(() => {
    const upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    for (const [key, value] of Object.entries(patch)) if (key in DEFAULT_SETTINGS) upsert.run(key, JSON.stringify(value));
  });
  version++;
  return getSettings();
}

export function setOverrides(id: string, overrides: Record<string, string | null>) {
  tx(() => {
    const upsert = db.prepare(
      `INSERT INTO photo_attributes (photo_id, attr, override_value) VALUES (?, ?, ?)
       ON CONFLICT (photo_id, attr) DO UPDATE SET override_value = excluded.override_value`,
    );
    for (const [attr, value] of Object.entries(overrides)) upsert.run(id, attr, value);
  });
}

// Attributes for many photos at once, keyed by photo id.
export function attributesFor(ids: string[]): Map<string, AttributeValue[]> {
  const out = new Map<string, AttributeValue[]>(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const rows = db
    .prepare(`SELECT * FROM photo_attributes WHERE photo_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as unknown as AttributeRow[];
  for (const r of rows) {
    out.get(r.photo_id)?.push({
      attr: r.attr,
      jevValue: r.jev_value,
      jevConfidence: r.jev_confidence,
      detail: r.jev_detail ? JSON.parse(r.jev_detail) : null,
      override: r.override_value,
      value: r.override_value ?? r.jev_value,
    });
  }
  return out;
}
