// ---------------------------------------------------------------------------
// OpsPilot — FileStorage Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStorage } from '../src/core/storage/FileStorage';

// ── Helpers ────────────────────────────────────────────────────────────────

let testDir: string;

async function createTestStorage(): Promise<FileStorage> {
  testDir = path.join(os.tmpdir(), `opspilot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(testDir, { recursive: true });
  return new FileStorage(testDir);
}

async function cleanupTestDir(): Promise<void> {
  if (testDir) {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe('FileStorage', () => {
  let storage: FileStorage;

  beforeEach(async () => {
    storage = await createTestStorage();
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  describe('get/set', () => {
    it('should store and retrieve a value', async () => {
      await storage.set('users', 'user-1', { name: 'Alice', age: 30 });
      const result = await storage.get<{ name: string; age: number }>('users', 'user-1');
      assert.deepStrictEqual(result, { name: 'Alice', age: 30 });
    });

    it('should return undefined for missing keys', async () => {
      const result = await storage.get('users', 'non-existent');
      assert.strictEqual(result, undefined);
    });

    it('should overwrite existing values', async () => {
      await storage.set('users', 'user-1', { name: 'Alice' });
      await storage.set('users', 'user-1', { name: 'Bob' });
      const result = await storage.get<{ name: string }>('users', 'user-1');
      assert.deepStrictEqual(result, { name: 'Bob' });
    });

    it('should store complex nested objects', async () => {
      const complex = {
        id: 'test',
        nested: { array: [1, 2, 3], obj: { deep: true } },
        tags: ['a', 'b'],
      };
      await storage.set('data', 'complex', complex);
      const result = await storage.get('data', 'complex');
      assert.deepStrictEqual(result, complex);
    });

    it('should handle special characters in collection names', async () => {
      await storage.set('system::audit', 'entry-1', { action: 'test' });
      const result = await storage.get<{ action: string }>('system::audit', 'entry-1');
      assert.deepStrictEqual(result, { action: 'test' });
    });
  });

  describe('delete', () => {
    it('should delete a value', async () => {
      await storage.set('items', 'item-1', { data: 'test' });
      const deleted = await storage.delete('items', 'item-1');
      assert.strictEqual(deleted, true);

      const result = await storage.get('items', 'item-1');
      assert.strictEqual(result, undefined);
    });

    it('should return false when deleting non-existent key', async () => {
      const deleted = await storage.delete('items', 'ghost');
      assert.strictEqual(deleted, false);
    });
  });

  describe('list', () => {
    it('should list all values in a collection', async () => {
      await storage.set('items', 'a', { id: 'a', value: 1 });
      await storage.set('items', 'b', { id: 'b', value: 2 });
      await storage.set('items', 'c', { id: 'c', value: 3 });

      const items = await storage.list<{ id: string; value: number }>('items');
      assert.strictEqual(items.length, 3);
      const ids = items.map((i) => i.id).sort();
      assert.deepStrictEqual(ids, ['a', 'b', 'c']);
    });

    it('should return empty array for missing collection', async () => {
      const items = await storage.list('nonexistent');
      assert.deepStrictEqual(items, []);
    });

    it('should support limit and offset in list', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.set('nums', `n${i}`, { n: i });
      }

      const limited = await storage.list('nums', { limit: 2 });
      assert.strictEqual(limited.length, 2);

      const offset = await storage.list('nums', { offset: 3 });
      assert.strictEqual(offset.length, 2);

      const both = await storage.list('nums', { limit: 2, offset: 1 });
      assert.strictEqual(both.length, 2);
    });
  });

  describe('has', () => {
    it('should check existence', async () => {
      await storage.set('col', 'key1', 'value');
      assert.strictEqual(await storage.has('col', 'key1'), true);
      assert.strictEqual(await storage.has('col', 'key2'), false);
      assert.strictEqual(await storage.has('empty', 'key'), false);
    });
  });

  describe('count', () => {
    it('should count records', async () => {
      assert.strictEqual(await storage.count('empty'), 0);

      await storage.set('col', 'a', 1);
      await storage.set('col', 'b', 2);
      assert.strictEqual(await storage.count('col'), 2);
    });
  });

  describe('clear', () => {
    it('should clear a collection', async () => {
      await storage.set('col', 'a', 1);
      await storage.set('col', 'b', 2);
      await storage.clear('col');

      assert.strictEqual(await storage.count('col'), 0);
      assert.deepStrictEqual(await storage.list('col'), []);
    });

    it('should not throw when clearing non-existent collection', async () => {
      await storage.clear('ghost');
      // No error = pass
    });
  });

  describe('isolation', () => {
    it('should isolate collections', async () => {
      await storage.set('col-a', 'key', { from: 'a' });
      await storage.set('col-b', 'key', { from: 'b' });

      const a = await storage.get<{ from: string }>('col-a', 'key');
      const b = await storage.get<{ from: string }>('col-b', 'key');
      assert.strictEqual(a!.from, 'a');
      assert.strictEqual(b!.from, 'b');
    });
  });

  describe('persistence', () => {
    it('should persist data across storage instances', async () => {
      await storage.set('persist', 'data', { hello: 'world' });

      // Create a new instance pointing to the same directory
      const storage2 = new FileStorage(testDir);
      const result = await storage2.get<{ hello: string }>('persist', 'data');
      assert.deepStrictEqual(result, { hello: 'world' });
    });

    it('should persist list data across instances', async () => {
      await storage.set('items', 'x', { id: 'x' });
      await storage.set('items', 'y', { id: 'y' });

      const storage2 = new FileStorage(testDir);
      const items = await storage2.list('items');
      assert.strictEqual(items.length, 2);
    });

    it('should persist deletes across instances', async () => {
      await storage.set('items', 'x', { id: 'x' });
      await storage.delete('items', 'x');

      const storage2 = new FileStorage(testDir);
      assert.strictEqual(await storage2.has('items', 'x'), false);
    });
  });
});
