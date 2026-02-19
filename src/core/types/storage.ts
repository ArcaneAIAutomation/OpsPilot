// ---------------------------------------------------------------------------
// OpsPilot — Storage Abstraction Types
// ---------------------------------------------------------------------------
// A minimal key/value + collection interface that can be backed by
// in-memory maps, the filesystem, or a database.
// Modules receive a namespaced view — they can only access their own data.
// ---------------------------------------------------------------------------

/**
 * Generic storage engine contract.
 *
 * `collection` acts as a logical namespace (e.g. `incidents`, `audit`).
 * `key` uniquely identifies a record within a collection.
 */
export interface IStorageEngine {
  /** Retrieve a value, or `undefined` if not found. */
  get<T>(collection: string, key: string): Promise<T | undefined>;

  /** Upsert a value. */
  set<T>(collection: string, key: string, value: T): Promise<void>;

  /** Delete a value. Returns `true` if the key existed. */
  delete(collection: string, key: string): Promise<boolean>;

  /** List all values in a collection, optionally filtered. */
  list<T>(collection: string, filter?: StorageFilter): Promise<T[]>;

  /** Check existence without retrieving the value. */
  has(collection: string, key: string): Promise<boolean>;

  /** Return the number of records in a collection. */
  count(collection: string): Promise<number>;

  /** Remove all records in a collection. */
  clear(collection: string): Promise<void>;
}

/**
 * Basic filtering / pagination for `list()` operations.
 */
export interface StorageFilter {
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
}

/**
 * A storage engine wrapper that prefixes all collection names with a
 * module ID, preventing cross-module data access.
 */
export interface INamespacedStorage extends IStorageEngine {
  readonly namespace: string;
}
