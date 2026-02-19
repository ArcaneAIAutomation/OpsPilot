// ---------------------------------------------------------------------------
// OpsPilot — Plugin Loader Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PluginLoader, PluginManifest } from '../src/core/plugins/PluginLoader';
import { ModuleType } from '../src/core/types/module';
import { createSilentLogger } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opspilot-plugin-test-'));
}

function writePlugin(
  dir: string,
  name: string,
  manifest: PluginManifest,
  moduleCode: string,
): string {
  const pluginDir = path.join(dir, name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  const entryFile = manifest.entry ?? 'index.js';
  fs.writeFileSync(path.join(pluginDir, entryFile), moduleCode);
  return pluginDir;
}

/** Minimal IModule implementation as JavaScript source. */
function minimalModuleCode(id: string): string {
  return `
"use strict";
class TestModule {
  constructor() {
    this.manifest = {
      id: "${id}",
      name: "Test Module ${id}",
      version: "0.1.0",
      type: "connector",
    };
    this._health = { status: "healthy", lastCheck: new Date() };
  }
  async initialize(ctx) { this.ctx = ctx; }
  async start() {}
  async stop() {}
  async destroy() {}
  health() { return this._health; }
}
module.exports = { TestModule };
`;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PluginLoader', () => {
  const logger = createSilentLogger();

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Discovery ──────────────────────────────────────────────────────────

  describe('Discovery', () => {
    it('discovers plugins with valid manifests', () => {
      writePlugin(tmpDir, 'my-plugin', {
        id: 'connector.test',
        name: 'Test Connector',
        version: '0.1.0',
        type: 'connector',
      }, minimalModuleCode('connector.test'));

      const loader = new PluginLoader(tmpDir, logger);
      const result = loader.discover();

      assert.equal(result.plugins.length, 1);
      assert.equal(result.errors.length, 0);
      assert.equal(result.plugins[0].manifest.id, 'connector.test');
    });

    it('discovers multiple plugins', () => {
      writePlugin(tmpDir, 'plugin-a', {
        id: 'connector.a',
        name: 'Plugin A',
        version: '1.0.0',
        type: 'connector',
      }, minimalModuleCode('connector.a'));

      writePlugin(tmpDir, 'plugin-b', {
        id: 'detector.b',
        name: 'Plugin B',
        version: '2.0.0',
        type: 'detector',
      }, minimalModuleCode('detector.b'));

      const loader = new PluginLoader(tmpDir, logger);
      const result = loader.discover();

      assert.equal(result.plugins.length, 2);
      const ids = result.plugins.map((p) => p.manifest.id).sort();
      assert.deepEqual(ids, ['connector.a', 'detector.b']);
    });

    it('returns empty when plugins directory does not exist', () => {
      const loader = new PluginLoader(path.join(tmpDir, 'nonexistent'), logger);
      const result = loader.discover();

      assert.equal(result.plugins.length, 0);
      assert.equal(result.errors.length, 0);
    });

    it('reports error for missing manifest.json', () => {
      const pluginDir = path.join(tmpDir, 'bad-plugin');
      fs.mkdirSync(pluginDir);
      // No manifest.json

      const loader = new PluginLoader(tmpDir, logger);
      const result = loader.discover();

      assert.equal(result.plugins.length, 0);
      assert.equal(result.errors.length, 1);
      assert.ok(result.errors[0].reason.includes('No manifest.json'));
    });

    it('reports error for invalid JSON in manifest', () => {
      const pluginDir = path.join(tmpDir, 'bad-json');
      fs.mkdirSync(pluginDir);
      fs.writeFileSync(path.join(pluginDir, 'manifest.json'), '{ invalid }');

      const loader = new PluginLoader(tmpDir, logger);
      const result = loader.discover();

      assert.equal(result.errors.length, 1);
      assert.ok(result.errors[0].reason.includes('Invalid JSON'));
    });

    it('reports error for missing required fields', () => {
      const pluginDir = path.join(tmpDir, 'missing-fields');
      fs.mkdirSync(pluginDir);
      fs.writeFileSync(
        path.join(pluginDir, 'manifest.json'),
        JSON.stringify({ id: 'test' }), // missing name, version, type
      );

      const loader = new PluginLoader(tmpDir, logger);
      const result = loader.discover();

      assert.equal(result.errors.length, 1);
      assert.ok(result.errors[0].reason.includes('missing required field'));
    });

    it('reports error for invalid module type', () => {
      const pluginDir = path.join(tmpDir, 'bad-type');
      fs.mkdirSync(pluginDir);
      fs.writeFileSync(
        path.join(pluginDir, 'manifest.json'),
        JSON.stringify({
          id: 'test.bad',
          name: 'Bad Type',
          version: '1.0.0',
          type: 'nonexistent',
        }),
      );
      fs.writeFileSync(path.join(pluginDir, 'index.js'), '');

      const loader = new PluginLoader(tmpDir, logger);
      const result = loader.discover();

      assert.equal(result.errors.length, 1);
      assert.ok(result.errors[0].reason.includes('Invalid module type'));
    });

    it('reports error when entry point file does not exist', () => {
      const pluginDir = path.join(tmpDir, 'no-entry');
      fs.mkdirSync(pluginDir);
      fs.writeFileSync(
        path.join(pluginDir, 'manifest.json'),
        JSON.stringify({
          id: 'test.noentry',
          name: 'No Entry',
          version: '1.0.0',
          type: 'connector',
          entry: 'missing.js',
        }),
      );

      const loader = new PluginLoader(tmpDir, logger);
      const result = loader.discover();

      assert.equal(result.errors.length, 1);
      assert.ok(result.errors[0].reason.includes('Entry point'));
    });

    it('ignores files (non-directories) in plugins folder', () => {
      fs.writeFileSync(path.join(tmpDir, 'not-a-plugin.txt'), 'hello');

      const loader = new PluginLoader(tmpDir, logger);
      const result = loader.discover();

      assert.equal(result.plugins.length, 0);
      assert.equal(result.errors.length, 0);
    });
  });

  // ── Loading ────────────────────────────────────────────────────────────

  describe('Loading', () => {
    it('loads a valid plugin and creates a factory', async () => {
      writePlugin(tmpDir, 'good-plugin', {
        id: 'connector.test',
        name: 'Test Connector',
        version: '0.1.0',
        type: 'connector',
      }, minimalModuleCode('connector.test'));

      const loader = new PluginLoader(tmpDir, logger);
      const discovery = loader.discover();
      assert.equal(discovery.plugins.length, 1);

      const result = await loader.loadPlugin(discovery.plugins[0]);
      assert.ok(result.factory, 'Should have a factory');
      assert.ok(!result.error, 'Should have no error');

      // Factory should produce valid modules
      const mod = result.factory!();
      assert.equal(mod.manifest.id, 'connector.test');
      assert.equal(typeof mod.initialize, 'function');
      assert.equal(typeof mod.start, 'function');
      assert.equal(typeof mod.stop, 'function');
      assert.equal(typeof mod.destroy, 'function');
      assert.equal(typeof mod.health, 'function');
    });

    it('reports error for module ID mismatch', async () => {
      // Manifest says plugin-a, code says plugin-b
      writePlugin(tmpDir, 'mismatch', {
        id: 'connector.a',
        name: 'Mismatch',
        version: '1.0.0',
        type: 'connector',
      }, minimalModuleCode('connector.b'));

      const loader = new PluginLoader(tmpDir, logger);
      const discovery = loader.discover();
      const result = await loader.loadPlugin(discovery.plugins[0]);

      assert.ok(result.error, 'Should have an error');
      assert.ok(result.error!.includes('mismatch'), `Error should mention mismatch: ${result.error}`);
    });

    it('reports error for non-module export', async () => {
      writePlugin(tmpDir, 'not-a-module', {
        id: 'connector.bad',
        name: 'Not A Module',
        version: '1.0.0',
        type: 'connector',
      }, `module.exports = { notAModule: true };`);

      const loader = new PluginLoader(tmpDir, logger);
      const discovery = loader.discover();
      const result = await loader.loadPlugin(discovery.plugins[0]);

      assert.ok(result.error, 'Should have an error');
    });
  });

  // ── loadAll ────────────────────────────────────────────────────────────

  describe('loadAll', () => {
    it('loads all valid plugins and reports errors for invalid ones', async () => {
      writePlugin(tmpDir, 'good', {
        id: 'connector.good',
        name: 'Good Plugin',
        version: '1.0.0',
        type: 'connector',
      }, minimalModuleCode('connector.good'));

      // Create a bad plugin (no entry file)
      const badDir = path.join(tmpDir, 'bad');
      fs.mkdirSync(badDir);
      // No manifest.json

      const loader = new PluginLoader(tmpDir, logger);
      const result = await loader.loadAll();

      assert.equal(result.factories.length, 1);
      assert.equal(result.factories[0].id, 'connector.good');
      assert.equal(result.errors.length, 1);
    });

    it('returns empty when no plugins directory', async () => {
      const loader = new PluginLoader(path.join(tmpDir, 'nope'), logger);
      const result = await loader.loadAll();

      assert.equal(result.factories.length, 0);
      assert.equal(result.errors.length, 0);
    });
  });

  // ── Misc ───────────────────────────────────────────────────────────────

  describe('Misc', () => {
    it('resolves plugins directory', () => {
      const loader = new PluginLoader('./plugins', logger);
      assert.ok(path.isAbsolute(loader.getPluginsDir()));
    });

    it('supports custom entry point', async () => {
      writePlugin(tmpDir, 'custom-entry', {
        id: 'connector.custom',
        name: 'Custom Entry',
        version: '1.0.0',
        type: 'connector',
        entry: 'main.js',
      }, ''); // empty default — won't be used

      // Write the actual entry point
      fs.writeFileSync(
        path.join(tmpDir, 'custom-entry', 'main.js'),
        minimalModuleCode('connector.custom'),
      );

      const loader = new PluginLoader(tmpDir, logger);
      const discovery = loader.discover();
      const result = await loader.loadPlugin(discovery.plugins[0]);

      assert.ok(result.factory, 'Should have a factory');
      const mod = result.factory!();
      assert.equal(mod.manifest.id, 'connector.custom');
    });
  });
});
