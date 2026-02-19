// ---------------------------------------------------------------------------
// OpsPilot — Namespaced Storage Wrapper
// ---------------------------------------------------------------------------
// Prefixes all collection names with a module ID so that modules cannot
// accidentally (or intentionally) access each other's data.
// ---------------------------------------------------------------------------

import { IStorageEngine, INamespacedStorage, StorageFilter } from '../types/storage';

export class NamespacedStorage implements INamespacedStorage {
  readonly namespace: string;
  private readonly inner: IStorageEngine;

  constructor(inner: IStorageEngine, namespace: string) {
    this.inner = inner;
    this.namespace = namespace;
  }

  private key(collection: string): string {
    return `${this.namespace}::${collection}`;
  }

  get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.inner.get<T>(this.key(collection), key);
  }

  set<T>(collection: string, key: string, value: T): Promise<void> {
    return this.inner.set<T>(this.key(collection), key, value);
  }

  delete(collection: string, key: string): Promise<boolean> {
    return this.inner.delete(this.key(collection), key);
  }

  list<T>(collection: string, filter?: StorageFilter): Promise<T[]> {
    return this.inner.list<T>(this.key(collection), filter);
  }

  has(collection: string, key: string): Promise<boolean> {
    return this.inner.has(this.key(collection), key);
  }

  count(collection: string): Promise<number> {
    return this.inner.count(this.key(collection));
  }

  clear(collection: string): Promise<void> {
    return this.inner.clear(this.key(collection));
  }
}
