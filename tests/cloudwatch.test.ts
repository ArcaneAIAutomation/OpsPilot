// ---------------------------------------------------------------------------
// OpsPilot — connector.cloudwatch Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CloudWatchConnector, CloudWatchLogEvent } from '../src/modules/connector.cloudwatch/index';
import { ModuleContext, ModuleType } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { OpsPilotEvent } from '../src/core/types/events';
import { LogIngestedPayload } from '../src/shared/events';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'connector.cloudwatch',
    config: {
      region: 'us-east-1',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      logGroups: ['/aws/lambda/my-func', '/aws/ecs/web'],
      pollIntervalMs: 60000,
      source: 'cw-test',
      lookbackMs: 300000,
      maxEventsPerPoll: 100,
      filterPattern: '',
      endpointUrl: '',
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'connector.cloudwatch'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function makeEvent(logGroup: string, overrides: Partial<CloudWatchLogEvent> = {}): CloudWatchLogEvent {
  return {
    logGroupName: logGroup,
    logStreamName: 'stream-abc',
    timestamp: Date.now(),
    message: 'ERROR: Something went wrong',
    eventId: 'evt-001',
    ...overrides,
  };
}

// ── Lifecycle Tests ────────────────────────────────────────────────────────

describe('connector.cloudwatch — Lifecycle', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: CloudWatchConnector;

  beforeEach(() => {
    infra = createTestInfra();
    mod = new CloudWatchConnector();
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  it('has correct manifest', () => {
    assert.equal(mod.manifest.id, 'connector.cloudwatch');
    assert.equal(mod.manifest.type, ModuleType.Connector);
  });

  it('initializes with config', async () => {
    await mod.initialize(makeContext(infra));
    const config = mod.getConfig();
    assert.equal(config.region, 'us-east-1');
    assert.equal(config.source, 'cw-test');
    assert.deepEqual(config.logGroups, ['/aws/lambda/my-func', '/aws/ecs/web']);
  });

  it('initializes per-group state', async () => {
    await mod.initialize(makeContext(infra));
    const states = mod.getGroupStates();
    assert.equal(states.size, 2);
    assert.ok(states.has('/aws/lambda/my-func'));
    assert.ok(states.has('/aws/ecs/web'));
  });

  it('reports healthy status', async () => {
    await mod.initialize(makeContext(infra));
    const h = mod.health();
    assert.equal(h.status, 'healthy');
    assert.ok(h.details);
    assert.equal(h.details!.totalEventsProcessed, 0);
  });
});

// ── Event Injection ────────────────────────────────────────────────────────

describe('connector.cloudwatch — Event Injection', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: CloudWatchConnector;
  let emitted: OpsPilotEvent<LogIngestedPayload>[];

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new CloudWatchConnector();
    await mod.initialize(makeContext(infra));
    emitted = [];
    infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => { emitted.push(e); });
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  it('injects events and emits log.ingested', async () => {
    await mod.injectEvents([
      makeEvent('/aws/lambda/my-func', { message: 'Lambda timeout' }),
      makeEvent('/aws/ecs/web', { message: 'Container exited with code 1' }),
    ]);
    await sleep(10);

    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].payload.source, 'cw-test');
    assert.equal(emitted[0].payload.line, 'Lambda timeout');
    assert.equal(emitted[1].payload.line, 'Container exited with code 1');

    const meta0 = emitted[0].payload.metadata as Record<string, unknown>;
    assert.equal(meta0.collector, 'connector.cloudwatch');
    assert.equal(meta0.logGroup, '/aws/lambda/my-func');
    assert.equal(meta0.logStream, 'stream-abc');
    assert.equal(meta0.region, 'us-east-1');
  });

  it('updates cursor after injection', async () => {
    const now = Date.now();
    await mod.injectEvents([
      makeEvent('/aws/lambda/my-func', { timestamp: now }),
    ]);

    const state = mod.getGroupStates().get('/aws/lambda/my-func')!;
    assert.ok(state.lastTimestamp > now - 1);
  });

  it('tracks metrics', async () => {
    await mod.injectEvents([
      makeEvent('/aws/lambda/my-func'),
      makeEvent('/aws/lambda/my-func'),
      makeEvent('/aws/ecs/web'),
    ]);

    const metrics = mod.getMetrics();
    assert.equal(metrics.totalEventsProcessed, 3);
    assert.equal(metrics.totalErrors, 0);

    // Per-group counts
    const lambdaState = mod.getGroupStates().get('/aws/lambda/my-func')!;
    assert.equal(lambdaState.eventsProcessed, 2);

    const ecsState = mod.getGroupStates().get('/aws/ecs/web')!;
    assert.equal(ecsState.eventsProcessed, 1);
  });
});

// ── Health Reporting ───────────────────────────────────────────────────────

describe('connector.cloudwatch — Health', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: CloudWatchConnector;

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new CloudWatchConnector();
    await mod.initialize(makeContext(infra));
  });

  afterEach(async () => {
    await mod.destroy().catch(() => {});
  });

  it('includes per-group details in health', () => {
    const h = mod.health();
    assert.ok(h.details);
    const groupStates = h.details!.groupStates as Record<string, unknown>;
    assert.ok(groupStates['/aws/lambda/my-func']);
    assert.ok(groupStates['/aws/ecs/web']);
  });
});
