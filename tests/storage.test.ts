// ---------------------------------------------------------------------------
// OpsPilot — Storage Engine Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/core/storage/MemoryStorage';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';

describe('MemoryStorage', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('should store and retrieve a value', async () => {
    await storage.set('col', 'key1', { name: 'test' });
    const val = await storage.get<{ name: string }>('col', 'key1');
    assert.deepStrictEqual(val, { name: 'test' });
  });

  it('should return undefined for missing keys', async () => {
    const val = await storage.get('col', 'nope');
    assert.strictEqual(val, undefined);
  });

  it('should overwrite existing values', async () => {
    await storage.set('col', 'key1', 'first');
    await storage.set('col', 'key1', 'second');
    const val = await storage.get('col', 'key1');
    assert.strictEqual(val, 'second');
  });

  it('should delete a value', async () => {
    await storage.set('col', 'key1', 'val');
    const deleted = await storage.delete('col', 'key1');
    assert.strictEqual(deleted, true);
    assert.strictEqual(await storage.get('col', 'key1'), undefined);
  });

  it('should return false when deleting non-existent key', async () => {
    const deleted = await storage.delete('col', 'nope');
    assert.strictEqual(deleted, false);
  });

  it('should list all values in a collection', async () => {
    await storage.set('col', 'a', 1);
    await storage.set('col', 'b', 2);
    await storage.set('col', 'c', 3);
    const values = await storage.list<number>('col');
    assert.strictEqual(values.length, 3);
    assert.deepStrictEqual(values.sort(), [1, 2, 3]);
  });

  it('should return empty array for missing collection', async () => {
    const values = await storage.list('nope');
    assert.deepStrictEqual(values, []);
  });

  it('should support limit and offset in list', async () => {
    await storage.set('col', 'a', 1);
    await storage.set('col', 'b', 2);
    await storage.set('col', 'c', 3);
    const values = await storage.list<number>('col', { offset: 1, limit: 1 });
    assert.strictEqual(values.length, 1);
  });

  it('should check existence with has()', async () => {
    assert.strictEqual(await storage.has('col', 'key'), false);
    await storage.set('col', 'key', 'val');
    assert.strictEqual(await storage.has('col', 'key'), true);
  });

  it('should count records', async () => {
    assert.strictEqual(await storage.count('col'), 0);
    await storage.set('col', 'a', 1);
    await storage.set('col', 'b', 2);
    assert.strictEqual(await storage.count('col'), 2);
  });

  it('should clear a collection', async () => {
    await storage.set('col', 'a', 1);
    await storage.set('col', 'b', 2);
    await storage.clear('col');
    assert.strictEqual(await storage.count('col'), 0);
    assert.deepStrictEqual(await storage.list('col'), []);
  });

  it('should isolate collections', async () => {
    await storage.set('col1', 'key', 'val1');
    await storage.set('col2', 'key', 'val2');
    assert.strictEqual(await storage.get('col1', 'key'), 'val1');
    assert.strictEqual(await storage.get('col2', 'key'), 'val2');
  });
});

describe('NamespacedStorage', () => {
  let base: MemoryStorage;
  let nsA: NamespacedStorage;
  let nsB: NamespacedStorage;

  beforeEach(() => {
    base = new MemoryStorage();
    nsA = new NamespacedStorage(base, 'moduleA');
    nsB = new NamespacedStorage(base, 'moduleB');
  });

  it('should isolate data between namespaces', async () => {
    await nsA.set('items', 'key1', 'fromA');
    await nsB.set('items', 'key1', 'fromB');

    assert.strictEqual(await nsA.get('items', 'key1'), 'fromA');
    assert.strictEqual(await nsB.get('items', 'key1'), 'fromB');
  });

  it('should not see data from other namespaces', async () => {
    await nsA.set('items', 'key1', 'val');
    assert.strictEqual(await nsB.get('items', 'key1'), undefined);
    assert.strictEqual(await nsB.has('items', 'key1'), false);
  });

  it('should prefix collection names in the underlying storage', async () => {
    await nsA.set('incidents', 'inc1', { id: 'inc1' });

    // The base storage should have it under the prefixed collection
    const baseVal = await base.get('moduleA::incidents', 'inc1');
    assert.deepStrictEqual(baseVal, { id: 'inc1' });
  });

  it('should expose namespace property', () => {
    assert.strictEqual(nsA.namespace, 'moduleA');
    assert.strictEqual(nsB.namespace, 'moduleB');
  });

  it('should clear only own namespace', async () => {
    await nsA.set('items', 'a', 1);
    await nsB.set('items', 'b', 2);

    await nsA.clear('items');
    assert.strictEqual(await nsA.count('items'), 0);
    assert.strictEqual(await nsB.count('items'), 1);
  });
});
