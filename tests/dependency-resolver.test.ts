// ---------------------------------------------------------------------------
// OpsPilot — DependencyResolver Unit Tests
// ---------------------------------------------------------------------------

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DependencyResolver } from '../src/core/modules/DependencyResolver';
import { ModuleManifest, ModuleType } from '../src/core/types/module';

function manifest(id: string, deps?: string[]): ModuleManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    type: ModuleType.Enricher,
    dependencies: deps,
  };
}

describe('DependencyResolver', () => {
  const resolver = new DependencyResolver();

  it('should resolve modules with no dependencies', () => {
    const result = resolver.resolve([
      manifest('a'),
      manifest('b'),
      manifest('c'),
    ]);
    assert.strictEqual(result.order.length, 3);
    assert.ok(result.order.includes('a'));
    assert.ok(result.order.includes('b'));
    assert.ok(result.order.includes('c'));
  });

  it('should place dependencies before dependents', () => {
    const result = resolver.resolve([
      manifest('child', ['parent']),
      manifest('parent'),
    ]);
    const parentIdx = result.order.indexOf('parent');
    const childIdx = result.order.indexOf('child');
    assert.ok(parentIdx < childIdx, `parent (${parentIdx}) should be before child (${childIdx})`);
  });

  it('should handle deep dependency chains', () => {
    const result = resolver.resolve([
      manifest('c', ['b']),
      manifest('b', ['a']),
      manifest('a'),
    ]);
    assert.deepStrictEqual(result.order, ['a', 'b', 'c']);
  });

  it('should handle diamond dependencies', () => {
    const result = resolver.resolve([
      manifest('d', ['b', 'c']),
      manifest('b', ['a']),
      manifest('c', ['a']),
      manifest('a'),
    ]);
    const aIdx = result.order.indexOf('a');
    const bIdx = result.order.indexOf('b');
    const cIdx = result.order.indexOf('c');
    const dIdx = result.order.indexOf('d');
    assert.ok(aIdx < bIdx);
    assert.ok(aIdx < cIdx);
    assert.ok(bIdx < dIdx);
    assert.ok(cIdx < dIdx);
  });

  it('should throw on circular dependencies', () => {
    assert.throws(
      () => resolver.resolve([
        manifest('a', ['b']),
        manifest('b', ['a']),
      ]),
      /[Cc]ircular dependency/,
    );
  });

  it('should throw on three-node cycle', () => {
    assert.throws(
      () => resolver.resolve([
        manifest('a', ['c']),
        manifest('b', ['a']),
        manifest('c', ['b']),
      ]),
      /[Cc]ircular dependency/,
    );
  });

  it('should throw on missing dependency', () => {
    assert.throws(
      () => resolver.resolve([
        manifest('a', ['missing']),
      ]),
      /not registered/,
    );
  });

  it('should throw on self-dependency', () => {
    assert.throws(
      () => resolver.resolve([
        manifest('a', ['a']),
      ]),
      /itself/,
    );
  });

  it('should produce deterministic order for modules with same dependencies', () => {
    const result1 = resolver.resolve([manifest('b'), manifest('a'), manifest('c')]);
    const result2 = resolver.resolve([manifest('c'), manifest('a'), manifest('b')]);
    assert.deepStrictEqual(result1.order, result2.order);
  });
});
