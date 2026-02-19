// ---------------------------------------------------------------------------
// OpsPilot — In-Memory Storage Engine
// ---------------------------------------------------------------------------
// Default storage backend for development and testing.
// Data is NOT persisted across restarts.
// ---------------------------------------------------------------------------

import { IStorageEngine, StorageFilter } from '../types/storage';

export class MemoryStorage implements IStorageEngine {
  /**
   * Two-level map: collection → (key → value).
   */
  private readonly data = new Map<string, Map<string, unknown>>();

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.data.get(collection)?.get(key) as T | undefined;
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    let col = this.data.get(collection);
    if (!col) {
      col = new Map();
      this.data.set(collection, col);
    }
    col.set(key, value);
  }

  async delete(collection: string, key: string): Promise<boolean> {
    const col = this.data.get(collection);
    if (!col) return false;
    const existed = col.delete(key);
    if (col.size === 0) this.data.delete(collection);
    return existed;
  }

  async list<T>(collection: string, filter?: StorageFilter): Promise<T[]> {
    const col = this.data.get(collection);
    if (!col) return [];

    let values = [...col.values()] as T[];

    // Basic pagination
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? values.length;
    values = values.slice(offset, offset + limit);

    return values;
  }

  async has(collection: string, key: string): Promise<boolean> {
    return this.data.get(collection)?.has(key) ?? false;
  }

  async count(collection: string): Promise<number> {
    return this.data.get(collection)?.size ?? 0;
  }

  async clear(collection: string): Promise<void> {
    this.data.delete(collection);
  }
}
