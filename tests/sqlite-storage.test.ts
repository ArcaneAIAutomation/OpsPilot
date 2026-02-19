// ---------------------------------------------------------------------------
// OpsPilot — SQLiteStorage Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SQLiteStorage } from '../src/core/storage/SQLiteStorage';

describe('SQLiteStorage', () => {
  let storage: SQLiteStorage;
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opspilot-sqlite-'));
    dbPath = path.join(testDir, 'test.db');
    storage = new SQLiteStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── get / set ─────────────────────────────────────────────────────

  describe('get / set', () => {
    it('should store and retrieve a value', async () => {
      await storage.set('items', 'key1', { name: 'Widget', price: 9.99 });
      const result = await storage.get<{ name: string; price: number }>(
        'items',
        'key1',
      );
      assert.deepStrictEqual(result, { name: 'Widget', price: 9.99 });
    });

    it('should return undefined for missing key', async () => {
      const result = await storage.get('items', 'ghost');
      assert.strictEqual(result, undefined);
    });

    it('should return undefined for missing collection', async () => {
      const result = await storage.get('nonexistent', 'key');
      assert.strictEqual(result, undefined);
    });

    it('should overwrite existing value', async () => {
      await storage.set('col', 'key', 'first');
      await storage.set('col', 'key', 'second');
      assert.strictEqual(await storage.get('col', 'key'), 'second');
    });

    it('should handle complex nested objects', async () => {
      const complex = {
        id: 'inc-001',
        tags: ['critical', 'production'],
        metadata: {
          source: 'cloudwatch',
          region: 'us-east-1',
          dimensions: { cpu: 95, memory: 80 },
        },
        resolved: false,
      };
      await storage.set('incidents', 'inc-001', complex);
      const result = await storage.get('incidents', 'inc-001');
      assert.deepStrictEqual(result, complex);
    });

    it('should handle string values', async () => {
      await storage.set('col', 'key', 'hello world');
      assert.strictEqual(await storage.get('col', 'key'), 'hello world');
    });

    it('should handle numeric values', async () => {
      await storage.set('col', 'int', 42);
      await storage.set('col', 'float', 3.14);
      assert.strictEqual(await storage.get('col', 'int'), 42);
      assert.strictEqual(await storage.get('col', 'float'), 3.14);
    });

    it('should handle boolean values', async () => {
      await storage.set('col', 'yes', true);
      await storage.set('col', 'no', false);
      assert.strictEqual(await storage.get('col', 'yes'), true);
      assert.strictEqual(await storage.get('col', 'no'), false);
    });

    it('should handle null values', async () => {
      await storage.set('col', 'nil', null);
      assert.strictEqual(await storage.get('col', 'nil'), null);
    });

    it('should handle array values', async () => {
      const arr = [1, 'two', { three: 3 }, [4]];
      await storage.set('col', 'arr', arr);
      assert.deepStrictEqual(await storage.get('col', 'arr'), arr);
    });

    it('should handle keys with special characters', async () => {
      await storage.set('col', 'key/with/slashes', 'a');
      await storage.set('col', 'key.with.dots', 'b');
      await storage.set('col', 'key with spaces', 'c');
      await storage.set('col', 'key::with::colons', 'd');

      assert.strictEqual(await storage.get('col', 'key/with/slashes'), 'a');
      assert.strictEqual(await storage.get('col', 'key.with.dots'), 'b');
      assert.strictEqual(await storage.get('col', 'key with spaces'), 'c');
      assert.strictEqual(await storage.get('col', 'key::with::colons'), 'd');
    });
  });

  // ── delete ────────────────────────────────────────────────────────

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

    it('should not affect other keys in same collection', async () => {
      await storage.set('col', 'a', 1);
      await storage.set('col', 'b', 2);
      await storage.delete('col', 'a');
      assert.strictEqual(await storage.get('col', 'b'), 2);
      assert.strictEqual(await storage.count('col'), 1);
    });
  });

  // ── list ──────────────────────────────────────────────────────────

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

    it('should support limit', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.set('nums', `n${i}`, { n: i });
      }

      const limited = await storage.list('nums', { limit: 2 });
      assert.strictEqual(limited.length, 2);
    });

    it('should support offset', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.set('nums', `n${i}`, { n: i });
      }

      const offset = await storage.list('nums', { offset: 3 });
      assert.strictEqual(offset.length, 2);
    });

    it('should support limit + offset together', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.set('nums', `n${i}`, { n: i });
      }

      const both = await storage.list('nums', { limit: 2, offset: 1 });
      assert.strictEqual(both.length, 2);
    });

    it('should return ordered results (by key ASC)', async () => {
      await storage.set('col', 'c', { id: 'c' });
      await storage.set('col', 'a', { id: 'a' });
      await storage.set('col', 'b', { id: 'b' });

      const items = await storage.list<{ id: string }>('col');
      assert.deepStrictEqual(
        items.map((i) => i.id),
        ['a', 'b', 'c'],
      );
    });
  });

  // ── has ───────────────────────────────────────────────────────────

  describe('has', () => {
    it('should check existence', async () => {
      await storage.set('col', 'key1', 'value');
      assert.strictEqual(await storage.has('col', 'key1'), true);
      assert.strictEqual(await storage.has('col', 'key2'), false);
      assert.strictEqual(await storage.has('empty', 'key'), false);
    });

    it('should return false after deletion', async () => {
      await storage.set('col', 'key', 'val');
      await storage.delete('col', 'key');
      assert.strictEqual(await storage.has('col', 'key'), false);
    });
  });

  // ── count ─────────────────────────────────────────────────────────

  describe('count', () => {
    it('should count records', async () => {
      assert.strictEqual(await storage.count('empty'), 0);

      await storage.set('col', 'a', 1);
      await storage.set('col', 'b', 2);
      assert.strictEqual(await storage.count('col'), 2);
    });

    it('should not count records from other collections', async () => {
      await storage.set('col1', 'a', 1);
      await storage.set('col2', 'b', 2);
      await storage.set('col2', 'c', 3);
      assert.strictEqual(await storage.count('col1'), 1);
      assert.strictEqual(await storage.count('col2'), 2);
    });

    it('should update count after delete', async () => {
      await storage.set('col', 'a', 1);
      await storage.set('col', 'b', 2);
      await storage.delete('col', 'a');
      assert.strictEqual(await storage.count('col'), 1);
    });
  });

  // ── clear ─────────────────────────────────────────────────────────

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

    it('should not affect other collections', async () => {
      await storage.set('col1', 'a', 1);
      await storage.set('col2', 'b', 2);
      await storage.clear('col1');

      assert.strictEqual(await storage.count('col1'), 0);
      assert.strictEqual(await storage.count('col2'), 1);
      assert.strictEqual(await storage.get('col2', 'b'), 2);
    });
  });

  // ── isolation ─────────────────────────────────────────────────────

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

  // ── persistence ───────────────────────────────────────────────────

  describe('persistence', () => {
    it('should persist data across storage instances', async () => {
      await storage.set('persist', 'data', { hello: 'world' });
      storage.close();

      const storage2 = new SQLiteStorage(dbPath);
      const result = await storage2.get<{ hello: string }>('persist', 'data');
      assert.deepStrictEqual(result, { hello: 'world' });
      storage2.close();

      // Replace with fresh instance so afterEach close() doesn't error
      storage = new SQLiteStorage(dbPath);
    });

    it('should persist list data across instances', async () => {
      await storage.set('items', 'x', { id: 'x' });
      await storage.set('items', 'y', { id: 'y' });
      storage.close();

      const storage2 = new SQLiteStorage(dbPath);
      const items = await storage2.list('items');
      assert.strictEqual(items.length, 2);
      storage2.close();

      storage = new SQLiteStorage(dbPath);
    });

    it('should persist deletes across instances', async () => {
      await storage.set('items', 'x', { id: 'x' });
      await storage.delete('items', 'x');
      storage.close();

      const storage2 = new SQLiteStorage(dbPath);
      assert.strictEqual(await storage2.has('items', 'x'), false);
      storage2.close();

      storage = new SQLiteStorage(dbPath);
    });

    it('should persist clears across instances', async () => {
      await storage.set('col', 'a', 1);
      await storage.set('col', 'b', 2);
      await storage.clear('col');
      storage.close();

      const storage2 = new SQLiteStorage(dbPath);
      assert.strictEqual(await storage2.count('col'), 0);
      storage2.close();

      storage = new SQLiteStorage(dbPath);
    });
  });

  // ── in-memory mode ────────────────────────────────────────────────

  describe('in-memory mode', () => {
    it('should work with :memory: database', async () => {
      const memStorage = new SQLiteStorage(':memory:');
      await memStorage.set('col', 'key', 'value');
      assert.strictEqual(await memStorage.get('col', 'key'), 'value');
      assert.strictEqual(await memStorage.count('col'), 1);
      memStorage.close();
    });
  });

  // ── directory creation ────────────────────────────────────────────

  describe('directory creation', () => {
    it('should create parent directories for db path', () => {
      const deepPath = path.join(testDir, 'a', 'b', 'c', 'deep.db');
      const deepStorage = new SQLiteStorage(deepPath);
      // If we get here, directories were created
      assert.ok(fs.existsSync(path.join(testDir, 'a', 'b', 'c')));
      deepStorage.close();
    });
  });

  // ── bulk operations ───────────────────────────────────────────────

  describe('bulk operations', () => {
    it('should handle many records efficiently', async () => {
      const count = 500;
      for (let i = 0; i < count; i++) {
        await storage.set('bulk', `item-${String(i).padStart(4, '0')}`, {
          index: i,
          data: `record-${i}`,
        });
      }

      assert.strictEqual(await storage.count('bulk'), count);

      const page = await storage.list('bulk', { offset: 100, limit: 50 });
      assert.strictEqual(page.length, 50);

      // Verify the data is intact
      const item = await storage.get<{ index: number; data: string }>(
        'bulk',
        'item-0250',
      );
      assert.ok(item);
      assert.strictEqual(item.index, 250);
      assert.strictEqual(item.data, 'record-250');
    });
  });
});
