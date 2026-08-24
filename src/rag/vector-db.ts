import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * The sqlite-vec plumbing shared by the three corpora (§8.3, §18.1, §25).
 * They are deliberately separate databases: `memory.query` never returning
 * file content, `files.search` never returning memories, and `history.search`
 * never returning either is the context-pollution firewall, and separate files
 * make that structural rather than a query detail.
 */
export function openVectorDb(file: string): BetterSqlite3.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new BetterSqlite3(file);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  return db;
}

/** Embedding width this index was built at, or 0 when nothing is embedded yet. */
export function storedDimension(db: BetterSqlite3.Database): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key='dimension'`).get() as
    { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

/** Create the vec0 table for a width, and remember the width we settled on. */
export function ensureVectorTable(
  db: BetterSqlite3.Database,
  table: string,
  keyColumn: string,
  dimension: number,
): void {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
       ${keyColumn} TEXT PRIMARY KEY, embedding float[${dimension}])`,
  );
  if (storedDimension(db) !== dimension) {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('dimension', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(dimension));
  }
}

/**
 * Add a column an older cache database does not have yet (§31.2 stamping).
 * These indexes are derived data — a rebuild would also do — but a cache that
 * repairs itself in place saves an embedding pass the user never asked for.
 */
export function ensureColumn(
  db: BetterSqlite3.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function toBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

/** Remove a sqlite database and its WAL siblings — a rebuild starts empty. */
export function removeDbFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const sibling = `${file}${suffix}`;
    if (fs.existsSync(sibling)) fs.rmSync(sibling);
  }
}
