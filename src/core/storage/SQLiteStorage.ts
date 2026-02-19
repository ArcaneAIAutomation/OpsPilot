// ---------------------------------------------------------------------------
// OpsPilot — SQLite Storage Engine
// ---------------------------------------------------------------------------
// Persistent storage backed by SQLite via better-sqlite3.
// Uses a single key/value table with collection + key composite primary key.
// Values are stored as JSON text.
//
// better-sqlite3 is synchronous, but IStorageEngine methods are async —
// we wrap sync calls in async methods for interface compliance.
// ---------------------------------------------------------------------------

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { IStorageEngine, StorageFilter } from '../types/storage';

export class SQLiteStorage implements IStorageEngine {
  private readonly db: Database.Database;

  /**
   * @param dbPath  Path to the SQLite database file.
   *                Use `:memory:` for an ephemeral in-memory database.
   */
  constructor(dbPath: string) {
    // Ensure the parent directory exists (unless in-memory)
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Create the key/value table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opspilot_kv (
        collection TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        value      TEXT    NOT NULL,
        updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (collection, key)
      )
    `);

    // Index for collection-scoped queries (list, count, clear)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_opspilot_kv_collection
        ON opspilot_kv (collection)
    `);

    // Prepare reusable statements
    this._stmtGet = this.db.prepare(
      'SELECT value FROM opspilot_kv WHERE collection = ? AND key = ?',
    );
    this._stmtSet = this.db.prepare(`
      INSERT INTO opspilot_kv (collection, key, value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(collection, key) DO UPDATE SET
        value      = excluded.value,
        updated_at = excluded.updated_at
    `);
    this._stmtDelete = this.db.prepare(
      'DELETE FROM opspilot_kv WHERE collection = ? AND key = ?',
    );
    this._stmtHas = this.db.prepare(
      'SELECT 1 FROM opspilot_kv WHERE collection = ? AND key = ? LIMIT 1',
    );
    this._stmtCount = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM opspilot_kv WHERE collection = ?',
    );
    this._stmtClear = this.db.prepare(
      'DELETE FROM opspilot_kv WHERE collection = ?',
    );
    this._stmtListAll = this.db.prepare(
      'SELECT value FROM opspilot_kv WHERE collection = ? ORDER BY key ASC',
    );
    this._stmtListLimit = this.db.prepare(
      'SELECT value FROM opspilot_kv WHERE collection = ? ORDER BY key ASC LIMIT ? OFFSET ?',
    );
  }

  /* ── Prepared statements ─────────────────────────────────────────── */
  private readonly _stmtGet: Database.Statement;
  private readonly _stmtSet: Database.Statement;
  private readonly _stmtDelete: Database.Statement;
  private readonly _stmtHas: Database.Statement;
  private readonly _stmtCount: Database.Statement;
  private readonly _stmtClear: Database.Statement;
  private readonly _stmtListAll: Database.Statement;
  private readonly _stmtListLimit: Database.Statement;

  /* ── IStorageEngine implementation ───────────────────────────────── */

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    const row = this._stmtGet.get(collection, key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value) as T;
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    this._stmtSet.run(collection, key, JSON.stringify(value));
  }

  async delete(collection: string, key: string): Promise<boolean> {
    const result = this._stmtDelete.run(collection, key);
    return result.changes > 0;
  }

  async list<T>(collection: string, filter?: StorageFilter): Promise<T[]> {
    const offset = filter?.offset ?? 0;
    let rows: { value: string }[];

    if (filter?.limit !== undefined) {
      rows = this._stmtListLimit.all(collection, filter.limit, offset) as {
        value: string;
      }[];
    } else if (offset > 0) {
      // Offset without limit — fetch all then slice
      const all = this._stmtListAll.all(collection) as { value: string }[];
      rows = all.slice(offset);
    } else {
      rows = this._stmtListAll.all(collection) as { value: string }[];
    }

    return rows.map((r) => JSON.parse(r.value) as T);
  }

  async has(collection: string, key: string): Promise<boolean> {
    return this._stmtHas.get(collection, key) !== undefined;
  }

  async count(collection: string): Promise<number> {
    const row = this._stmtCount.get(collection) as { cnt: number };
    return row.cnt;
  }

  async clear(collection: string): Promise<void> {
    this._stmtClear.run(collection);
  }

  /* ── Lifecycle ───────────────────────────────────────────────────── */

  /** Close the database connection. Call when shutting down. */
  close(): void {
    this.db.close();
  }
}
