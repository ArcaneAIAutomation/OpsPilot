// ---------------------------------------------------------------------------
// OpsPilot — detector.regex Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RegexDetector } from '../src/modules/detector.regex/index';
import { ModuleContext, ModuleState } from '../src/core/types/module';
import { OpsPilotEvent } from '../src/core/types/events';
import { LogIngestedPayload, IncidentCreatedPayload } from '../src/shared/events';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { createTestInfra, sleep } from './helpers';

// ── Helper: build module context ───────────────────────────────────────────

function buildContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown>,
): ModuleContext {
  return {
    moduleId: 'detector.regex',
    config,
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'detector.regex'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

// ── Helper: emit a log.ingested event ──────────────────────────────────────

function emitLog(
  infra: ReturnType<typeof createTestInfra>,
  line: string,
  source = '/var/log/test.log',
) {
  return infra.bus.publish<LogIngestedPayload>({
    type: 'log.ingested',
    source: 'connector.test',
    timestamp: new Date(),
    payload: {
      source,
      line,
      lineNumber: 1,
      ingestedAt: new Date(),
    },
  });
}

// ── Default rules ──────────────────────────────────────────────────────────

function defaultConfig(overrides?: Partial<Record<string, unknown>>) {
  return {
    maxIncidentsPerMinute: 30,
    rules: [
      {
        id: 'error-detect',
        pattern: 'ERROR',
        flags: 'i',
        severity: 'critical',
        title: 'Error Detected',
        description: 'Log line matched error pattern: $0',
        cooldownMs: 100,    // short for testing
        enabled: true,
      },
      {
        id: 'warning-detect',
        pattern: 'WARN(?:ING)?',
        flags: 'i',
        severity: 'warning',
        title: 'Warning Detected',
        description: 'Warning in logs: $0',
        cooldownMs: 100,
        enabled: true,
      },
    ],
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('detector.regex', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let detector: RegexDetector;

  beforeEach(() => {
    infra = createTestInfra();
    detector = new RegexDetector();
  });

  // ── Initialization ───────────────────────────────────────────────────

  it('should compile valid regex rules', async () => {
    const ctx = buildContext(infra, defaultConfig());
    await detector.initialize(ctx);

    const health = detector.health();
    assert.strictEqual(health.status, 'healthy');
    assert.strictEqual((health.details as any).activeRules, 2);
  });

  it('should fail on invalid regex pattern', async () => {
    const ctx = buildContext(infra, {
      rules: [
        {
          id: 'bad-regex',
          pattern: '[invalid(',
          severity: 'critical',
          title: 'Bad',
          enabled: true,
        },
      ],
    });

    await assert.rejects(
      () => detector.initialize(ctx),
      /invalid regex/i,
    );
  });

  it('should skip disabled rules', async () => {
    const ctx = buildContext(infra, {
      rules: [
        { id: 'disabled', pattern: 'TEST', severity: 'info', title: 'Test', enabled: false },
        { id: 'enabled', pattern: 'TEST', severity: 'info', title: 'Test', enabled: true },
      ],
    });

    await detector.initialize(ctx);
    assert.strictEqual((detector.health().details as any).activeRules, 1);
  });

  // ── Pattern Matching ─────────────────────────────────────────────────

  it('should create incident on matching log line', async () => {
    const ctx = buildContext(infra, defaultConfig());
    await detector.initialize(ctx);
    await detector.start();

    const incidents: OpsPilotEvent<IncidentCreatedPayload>[] = [];
    infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (e) => {
      incidents.push(e);
    });

    await emitLog(infra, '2024-01-01 ERROR: something went wrong');
    await sleep(10);

    assert.strictEqual(incidents.length, 1);
    assert.strictEqual(incidents[0].payload.severity, 'critical');
    assert.strictEqual(incidents[0].payload.title, 'Error Detected');
    assert.ok(incidents[0].payload.incidentId);

    await detector.stop();
    await detector.destroy();
  });

  it('should not create incident for non-matching line', async () => {
    const ctx = buildContext(infra, defaultConfig());
    await detector.initialize(ctx);
    await detector.start();

    const incidents: OpsPilotEvent<IncidentCreatedPayload>[] = [];
    infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (e) => {
      incidents.push(e);
    });

    await emitLog(infra, '2024-01-01 INFO: everything is fine');
    await sleep(10);

    assert.strictEqual(incidents.length, 0);

    await detector.stop();
    await detector.destroy();
  });

  it('should match multiple rules for a single line', async () => {
    // A line that contains both ERROR and WARNING
    const ctx = buildContext(infra, {
      maxIncidentsPerMinute: 30,
      rules: [
        { id: 'r1', pattern: 'foo', severity: 'info', title: 'Foo', cooldownMs: 0, enabled: true },
        { id: 'r2', pattern: 'bar', severity: 'warning', title: 'Bar', cooldownMs: 0, enabled: true },
      ],
    });

    await detector.initialize(ctx);
    await detector.start();

    const incidents: OpsPilotEvent<IncidentCreatedPayload>[] = [];
    infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (e) => {
      incidents.push(e);
    });

    await emitLog(infra, 'this line contains foo and bar');
    await sleep(10);

    assert.strictEqual(incidents.length, 2);

    await detector.stop();
    await detector.destroy();
  });

  // ── Capture Group Interpolation ──────────────────────────────────────

  it('should interpolate capture groups into description', async () => {
    const ctx = buildContext(infra, {
      maxIncidentsPerMinute: 30,
      rules: [
        {
          id: 'capture',
          pattern: '(\\w+)Error:\\s+(.*)',
          flags: '',
          severity: 'critical',
          title: 'Error',
          description: 'Type: $1, Message: $2',
          cooldownMs: 0,
          enabled: true,
        },
      ],
    });

    await detector.initialize(ctx);
    await detector.start();

    const incidents: OpsPilotEvent<IncidentCreatedPayload>[] = [];
    infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (e) => {
      incidents.push(e);
    });

    await emitLog(infra, 'RuntimeError: null pointer dereference');
    await sleep(10);

    assert.strictEqual(incidents.length, 1);
    assert.strictEqual(incidents[0].payload.description, 'Type: Runtime, Message: null pointer dereference');

    await detector.stop();
    await detector.destroy();
  });

  // ── Cooldown ─────────────────────────────────────────────────────────

  it('should suppress duplicate incidents within cooldown window', async () => {
    const ctx = buildContext(infra, {
      maxIncidentsPerMinute: 100,
      rules: [
        {
          id: 'cooldown-test',
          pattern: 'ERROR',
          severity: 'critical',
          title: 'Error',
          description: 'error',
          cooldownMs: 500,
          enabled: true,
        },
      ],
    });

    await detector.initialize(ctx);
    await detector.start();

    const incidents: OpsPilotEvent<IncidentCreatedPayload>[] = [];
    infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (e) => {
      incidents.push(e);
    });

    // First match — should fire
    await emitLog(infra, 'ERROR: first');
    await sleep(10);
    assert.strictEqual(incidents.length, 1);

    // Second match within cooldown — should be suppressed
    await emitLog(infra, 'ERROR: second');
    await sleep(10);
    assert.strictEqual(incidents.length, 1);

    // Wait for cooldown to expire
    await sleep(600);

    // Third match after cooldown — should fire
    await emitLog(infra, 'ERROR: third');
    await sleep(10);
    assert.strictEqual(incidents.length, 2);

    await detector.stop();
    await detector.destroy();
  });

  // ── Rate Limiting ────────────────────────────────────────────────────

  it('should enforce global rate limit', async () => {
    const ctx = buildContext(infra, {
      maxIncidentsPerMinute: 2,
      rules: [
        {
          id: 'rate-limit',
          pattern: 'ERROR',
          severity: 'critical',
          title: 'Error',
          description: 'error',
          cooldownMs: 0,
          enabled: true,
        },
      ],
    });

    await detector.initialize(ctx);
    await detector.start();

    const incidents: OpsPilotEvent<IncidentCreatedPayload>[] = [];
    infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (e) => {
      incidents.push(e);
    });

    // Fire 5 errors rapidly — only 2 should create incidents
    for (let i = 0; i < 5; i++) {
      await emitLog(infra, `ERROR: line ${i}`);
    }
    await sleep(10);

    assert.strictEqual(incidents.length, 2);

    await detector.stop();
    await detector.destroy();
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  it('should not receive events after stop', async () => {
    const ctx = buildContext(infra, defaultConfig());
    await detector.initialize(ctx);
    await detector.start();

    const incidents: OpsPilotEvent<IncidentCreatedPayload>[] = [];
    infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (e) => {
      incidents.push(e);
    });

    await detector.stop();

    await emitLog(infra, 'ERROR: after stop');
    await sleep(10);

    assert.strictEqual(incidents.length, 0);

    await detector.destroy();
  });

  it('should report health correctly', async () => {
    const ctx = buildContext(infra, defaultConfig());
    await detector.initialize(ctx);

    const health = detector.health();
    assert.strictEqual(health.status, 'healthy');
    assert.ok(health.lastCheck instanceof Date);
    assert.strictEqual((health.details as any).linesScanned, 0);
    assert.strictEqual((health.details as any).incidentsCreated, 0);
  });
});
