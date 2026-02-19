// ---------------------------------------------------------------------------
// OpsPilot — ModuleRegistry & ModuleLoader Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleRegistry } from '../src/core/modules/ModuleRegistry';
import { ModuleLoader } from '../src/core/modules/ModuleLoader';
import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleState,
  ModuleContext,
  ModuleHealth,
} from '../src/core/types/module';
import { OpsPilotConfig } from '../src/core/types/config';
import { createTestInfra, createSilentLogger } from './helpers';

// ── Stub Module ────────────────────────────────────────────────────────────

function createStubModule(
  id: string,
  opts?: {
    deps?: string[];
    configSchema?: Record<string, unknown>;
    onInit?: (ctx: ModuleContext) => Promise<void>;
    onStart?: () => Promise<void>;
    onStop?: () => Promise<void>;
    onDestroy?: () => Promise<void>;
  },
): IModule {
  const manifest: ModuleManifest = {
    id,
    name: `Test Module ${id}`,
    version: '1.0.0',
    type: ModuleType.Connector,
    dependencies: opts?.deps,
    configSchema: opts?.configSchema,
  };

  let ctx: ModuleContext | undefined;

  return {
    manifest,
    async initialize(context: ModuleContext) {
      ctx = context;
      if (opts?.onInit) await opts.onInit(context);
    },
    async start() {
      if (opts?.onStart) await opts.onStart();
    },
    async stop() {
      if (opts?.onStop) await opts.onStop();
    },
    async destroy() {
      if (opts?.onDestroy) await opts.onDestroy();
    },
    health(): ModuleHealth {
      return { status: 'healthy', lastCheck: new Date() };
    },
  };
}

// ── Minimal valid config ───────────────────────────────────────────────────

function baseConfig(extras?: Record<string, unknown>): OpsPilotConfig {
  return {
    system: {
      name: 'test',
      environment: 'development',
    },
    modules: extras ?? {},
  } as OpsPilotConfig;
}

// ── ModuleLoader Tests ─────────────────────────────────────────────────────

describe('ModuleLoader', () => {
  let loader: ModuleLoader;

  beforeEach(() => {
    loader = new ModuleLoader(createSilentLogger());
  });

  it('should register and instantiate a module', () => {
    const mod = createStubModule('test.a');
    loader.registerFactory('test.a', () => mod);
    const result = loader.instantiate('test.a');
    assert.strictEqual(result.manifest.id, 'test.a');
  });

  it('should throw on duplicate factory registration', () => {
    loader.registerFactory('test.a', () => createStubModule('test.a'));
    assert.throws(
      () => loader.registerFactory('test.a', () => createStubModule('test.a')),
      /already registered/,
    );
  });

  it('should throw when instantiating unknown module', () => {
    assert.throws(() => loader.instantiate('nope'), /No factory registered/);
  });

  it('should throw on manifest ID mismatch', () => {
    loader.registerFactory('test.a', () => createStubModule('test.WRONG'));
    assert.throws(() => loader.instantiate('test.a'), /mismatched manifest/);
  });

  it('should instantiate only enabled modules', () => {
    loader.registerFactory('test.a', () => createStubModule('test.a'));
    loader.registerFactory('test.b', () => createStubModule('test.b'));

    const enabled = new Set(['test.a']);
    const modules = loader.instantiateAll(enabled);
    assert.strictEqual(modules.length, 1);
    assert.strictEqual(modules[0].manifest.id, 'test.a');
  });

  it('should list registered IDs', () => {
    loader.registerFactory('test.a', () => createStubModule('test.a'));
    loader.registerFactory('test.b', () => createStubModule('test.b'));
    const ids = loader.registeredIds();
    assert.deepStrictEqual(ids.sort(), ['test.a', 'test.b']);
  });
});

// ── ModuleRegistry Tests ───────────────────────────────────────────────────

describe('ModuleRegistry', () => {
  let registry: ModuleRegistry;
  let infra: ReturnType<typeof createTestInfra>;

  beforeEach(() => {
    infra = createTestInfra();
    registry = new ModuleRegistry(
      infra.logger,
      infra.bus,
      infra.storage,
      infra.approvalGate,
    );
  });

  // ── Registration ─────────────────────────────────────────────────────

  it('should register a module', () => {
    const mod = createStubModule('test.a');
    registry.register(mod);
    assert.strictEqual(registry.getState('test.a'), ModuleState.Registered);
  });

  it('should throw on duplicate registration', () => {
    registry.register(createStubModule('test.a'));
    assert.throws(
      () => registry.register(createStubModule('test.a')),
      /already registered/,
    );
  });

  // ── Initialize ───────────────────────────────────────────────────────

  it('should initialize modules in dependency order', async () => {
    const order: string[] = [];

    const modA = createStubModule('test.a', {
      deps: ['test.b'],
      onInit: async () => { order.push('a'); },
    });
    const modB = createStubModule('test.b', {
      onInit: async () => { order.push('b'); },
    });

    registry.register(modA);
    registry.register(modB);

    await registry.initializeAll(baseConfig());
    // B has no deps, A depends on B → B first
    assert.deepStrictEqual(order, ['b', 'a']);
    assert.strictEqual(registry.getState('test.a'), ModuleState.Initialized);
    assert.strictEqual(registry.getState('test.b'), ModuleState.Initialized);
  });

  it('should transition to Error on init failure', async () => {
    const mod = createStubModule('test.fail', {
      onInit: async () => { throw new Error('init boom'); },
    });
    registry.register(mod);

    await assert.rejects(
      () => registry.initializeAll(baseConfig()),
      /failed to initialize/,
    );

    assert.strictEqual(registry.getState('test.fail'), ModuleState.Error);
  });

  // ── Start / Stop / Destroy ───────────────────────────────────────────

  it('should start and stop modules', async () => {
    const events: string[] = [];
    const mod = createStubModule('test.a', {
      onStart: async () => { events.push('started'); },
      onStop: async () => { events.push('stopped'); },
    });

    registry.register(mod);
    await registry.initializeAll(baseConfig());
    assert.strictEqual(registry.isRunning('test.a'), false);

    await registry.startAll();
    assert.strictEqual(registry.isRunning('test.a'), true);
    assert.deepStrictEqual(events, ['started']);

    await registry.stopAll();
    assert.strictEqual(registry.isRunning('test.a'), false);
    assert.deepStrictEqual(events, ['started', 'stopped']);
  });

  it('should stop in reverse dependency order', async () => {
    const order: string[] = [];

    const modA = createStubModule('test.a', {
      deps: ['test.b'],
      onStop: async () => { order.push('a'); },
    });
    const modB = createStubModule('test.b', {
      onStop: async () => { order.push('b'); },
    });

    registry.register(modA);
    registry.register(modB);
    await registry.initializeAll(baseConfig());
    await registry.startAll();
    await registry.stopAll();

    // A depends on B, so A should be stopped FIRST (reverse dep order)
    assert.deepStrictEqual(order, ['a', 'b']);
  });

  it('should destroy after stop', async () => {
    const destroyed: string[] = [];
    const mod = createStubModule('test.a', {
      onDestroy: async () => { destroyed.push('a'); },
    });

    registry.register(mod);
    await registry.initializeAll(baseConfig());
    await registry.startAll();
    await registry.stopAll();
    await registry.destroyAll();

    assert.deepStrictEqual(destroyed, ['a']);
    assert.strictEqual(registry.getState('test.a'), ModuleState.Destroyed);
  });

  // ── Queries ──────────────────────────────────────────────────────────

  it('should return all states', async () => {
    registry.register(createStubModule('test.a'));
    registry.register(createStubModule('test.b'));

    const states = registry.getAllStates();
    assert.strictEqual(states.size, 2);
    assert.strictEqual(states.get('test.a'), ModuleState.Registered);
    assert.strictEqual(states.get('test.b'), ModuleState.Registered);
  });

  it('should return registered IDs', () => {
    registry.register(createStubModule('test.a'));
    registry.register(createStubModule('test.b'));

    const ids = registry.getRegisteredIds();
    assert.deepStrictEqual(ids.sort(), ['test.a', 'test.b']);
  });

  it('should return a module by ID', () => {
    const mod = createStubModule('test.a');
    registry.register(mod);
    assert.strictEqual(registry.getModule('test.a'), mod);
  });

  it('should return health', async () => {
    registry.register(createStubModule('test.a'));
    await registry.initializeAll(baseConfig());

    const health = registry.getHealth('test.a');
    assert.ok(health);
    assert.strictEqual(health.status, 'healthy');
  });

  it('should return undefined for unknown module queries', () => {
    assert.strictEqual(registry.getState('nope'), undefined);
    assert.strictEqual(registry.getModule('nope'), undefined);
    assert.strictEqual(registry.getHealth('nope'), undefined);
    assert.strictEqual(registry.isRunning('nope'), false);
  });

  // ── Lifecycle events ────────────────────────────────────────────────

  it('should emit module.lifecycle events on state transitions', async () => {
    const events: Array<{ moduleId: string; state: string }> = [];

    infra.bus.subscribe('module.lifecycle', (event) => {
      const p = event.payload as { moduleId: string; state: string };
      events.push({ moduleId: p.moduleId, state: p.state });
    });

    const mod = createStubModule('test.a');
    registry.register(mod);
    await registry.initializeAll(baseConfig());

    // Wait for async event emissions
    await new Promise<void>((r) => setTimeout(r, 50));

    const states = events.filter((e) => e.moduleId === 'test.a').map((e) => e.state);
    assert.ok(states.includes('initializing'));
    assert.ok(states.includes('initialized'));
  });
});
