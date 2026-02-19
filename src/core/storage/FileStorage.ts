// ---------------------------------------------------------------------------
// OpsPilot — File-based Storage Engine
// ---------------------------------------------------------------------------
// Persists data as JSON files on the local filesystem.
//
// Layout:
//   <basePath>/
//     <collection>/
//       <key>.json          ← individual records
//
// Design:
//   - Each collection maps to a directory
//   - Each record maps to a single JSON file (<key>.json)
//   - Reads/writes are atomic via write-to-temp-then-rename
//   - Suitable for low-to-medium throughput (operational data, audit trails)
//   - NOT suited for high-frequency writes; for that, use a DB engine
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { IStorageEngine, StorageFilter } from '../types/storage';

export class FileStorage implements IStorageEngine {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = path.resolve(basePath);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Safe collection directory name (replace :: and special chars). */
  private collectionDir(collection: string): string {
    const safeName = collection.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.basePath, safeName);
  }

  /** Full path to a record's JSON file. */
  private recordPath(collection: string, key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.collectionDir(collection), `${safeKey}.json`);
  }

  /** Ensure a directory exists. */
  private async ensureDir(dirPath: string): Promise<void> {
    await fsp.mkdir(dirPath, { recursive: true });
  }

  // ── IStorageEngine ───────────────────────────────────────────────────────

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    const filePath = this.recordPath(collection, key);
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err: unknown) {
      if (this.isNotFound(err)) return undefined;
      throw err;
    }
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    const dir = this.collectionDir(collection);
    await this.ensureDir(dir);

    const filePath = this.recordPath(collection, key);
    const data = JSON.stringify(value, null, 2);

    // Atomic write: write a temp file then rename
    const tmpPath = filePath + '.tmp';
    await fsp.writeFile(tmpPath, data, 'utf-8');
    await fsp.rename(tmpPath, filePath);
  }

  async delete(collection: string, key: string): Promise<boolean> {
    const filePath = this.recordPath(collection, key);
    try {
      await fsp.unlink(filePath);
      return true;
    } catch (err: unknown) {
      if (this.isNotFound(err)) return false;
      throw err;
    }
  }

  async list<T>(collection: string, filter?: StorageFilter): Promise<T[]> {
    const dir = this.collectionDir(collection);

    let files: string[];
    try {
      files = await fsp.readdir(dir);
    } catch (err: unknown) {
      if (this.isNotFound(err)) return [];
      throw err;
    }

    // Only .json files, sorted for deterministic order
    const jsonFiles = files
      .filter((f) => f.endsWith('.json'))
      .sort();

    // Read all records
    const records: T[] = [];
    for (const file of jsonFiles) {
      try {
        const raw = await fsp.readFile(path.join(dir, file), 'utf-8');
        records.push(JSON.parse(raw) as T);
      } catch {
        // Skip corrupt files — log would be nice but we don't have logger here
        continue;
      }
    }

    // Apply pagination
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? records.length;
    return records.slice(offset, offset + limit);
  }

  async has(collection: string, key: string): Promise<boolean> {
    const filePath = this.recordPath(collection, key);
    try {
      await fsp.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async count(collection: string): Promise<number> {
    const dir = this.collectionDir(collection);
    try {
      const files = await fsp.readdir(dir);
      return files.filter((f) => f.endsWith('.json')).length;
    } catch (err: unknown) {
      if (this.isNotFound(err)) return 0;
      throw err;
    }
  }

  async clear(collection: string): Promise<void> {
    const dir = this.collectionDir(collection);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (err: unknown) {
      if (!this.isNotFound(err)) throw err;
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private isNotFound(err: unknown): boolean {
    return (
      err instanceof Error &&
      'code' in err &&
      ((err as NodeJS.ErrnoException).code === 'ENOENT' ||
        (err as NodeJS.ErrnoException).code === 'ENOTDIR')
    );
  }
}
