// ---------------------------------------------------------------------------
// OpsPilot — detector.threshold Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ThresholdDetector } from '../src/modules/detector.threshold/index';
import { ModuleContext } from '../src/core/types/module';
import { OpsPilotEvent } from '../src/core/types/events';
import {
  LogIngestedPayload,
  IncidentCreatedPayload,
} from '../src/shared/events';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function buildContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'detector.threshold',
    config: {
      maxIncidentsPerMinute: 30,
      rules: [
        {
          id: 'cpu-high',
          metric: 'cpu usage',
          valuePattern: '(\\d+)%',
          flags: 'i',
          threshold: 90,
          operator: 'gt',
          windowMs: 60000,
          minSamples: 1,
          severity: 'critical',
          title: 'CPU usage exceeded $threshold%',
          description: 'CPU at $value% (threshold: $threshold%)',
          cooldownMs: 0,
          enabled: true,
        },
      ],
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'detector.threshold'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function emitLog(
  infra: ReturnType<typeof createTestInfra>,
  line: string,
) {
  const payload: LogIngestedPayload = {
    source: '/var/log/syslog',
    line,
    lineNumber: 1,
    ingestedAt: new Date(),
  };
  return infra.bus.publish<LogIngestedPayload>({
    type: 'log.ingested',
    source: 'connector.fileTail',
    timestamp: new Date(),
    payload,
  });
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe('ThresholdDetector', () => {
  let detector: ThresholdDetector;
  let infra: ReturnType<typeof createTestInfra>;

  beforeEach(() => {
    detector = new ThresholdDetector();
    infra = createTestInfra();
  });

  afterEach(async () => {
    try { await detector.stop(); } catch { /* may not be started */ }
    try { await detector.destroy(); } catch { /* ok */ }
  });

  describe('manifest', () => {
    it('should have correct manifest', () => {
      assert.strictEqual(detector.manifest.id, 'detector.threshold');
      assert.strictEqual(detector.manifest.type, 'detector');
      assert.ok(detector.manifest.configSchema);
    });
  });

  describe('initialization', () => {
    it('should compile valid rules', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);

      const h = detector.health();
      assert.strictEqual(h.details!.activeRules, 1);
    });

    it('should fail on invalid regex pattern', async () => {
      const ctx = buildContext(infra, {
        rules: [
          {
            id: 'bad',
            metric: '[invalid',
            valuePattern: '(\\d+)',
            threshold: 50,
            operator: 'gt',
            severity: 'warning',
            title: 'Bad rule',
            enabled: true,
          },
        ],
      });
      await assert.rejects(() => detector.initialize(ctx), /invalid regex/i);
    });

    it('should skip disabled rules', async () => {
      const ctx = buildContext(infra, {
        rules: [
          {
            id: 'disabled-rule',
            metric: 'cpu',
            valuePattern: '(\\d+)',
            threshold: 90,
            operator: 'gt',
            severity: 'critical',
            title: 'Test',
            enabled: false,
          },
        ],
      });
      await detector.initialize(ctx);
      assert.strictEqual(detector.health().details!.activeRules, 0);
    });
  });

  describe('threshold detection', () => {
    it('should create incident when value exceeds threshold', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      await emitLog(infra, 'cpu usage is at 95% and climbing');

      assert.strictEqual(incidents.length, 1);
      assert.strictEqual(incidents[0].severity, 'critical');
      assert.ok(incidents[0].title.includes('90'));
      assert.ok(incidents[0].description.includes('95'));
    });

    it('should not create incident when value is below threshold', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      await emitLog(infra, 'cpu usage is at 50%');

      assert.strictEqual(incidents.length, 0);
    });

    it('should not match lines without the metric pattern', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      await emitLog(infra, 'memory usage is at 95%');

      assert.strictEqual(incidents.length, 0);
    });

    it('should support lt operator', async () => {
      const ctx = buildContext(infra, {
        rules: [
          {
            id: 'mem-low',
            metric: 'free memory',
            valuePattern: '(\\d+)\\s*MB',
            threshold: 500,
            operator: 'lt',
            severity: 'warning',
            title: 'Low memory: $value MB',
            description: 'Free memory $value MB < $threshold MB',
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      await emitLog(infra, 'free memory: 256 MB available');

      assert.strictEqual(incidents.length, 1);
      assert.ok(incidents[0].title.includes('256'));
    });

    it('should support gte operator', async () => {
      const ctx = buildContext(infra, {
        rules: [
          {
            id: 'errors-high',
            metric: 'error rate',
            valuePattern: '(\\d+) errors/min',
            threshold: 100,
            operator: 'gte',
            severity: 'critical',
            title: 'Error rate $value errors/min',
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      // Exactly at threshold
      await emitLog(infra, 'error rate: 100 errors/min');
      assert.strictEqual(incidents.length, 1);
    });
  });

  describe('sliding window', () => {
    it('should require minSamples before firing', async () => {
      const ctx = buildContext(infra, {
        rules: [
          {
            id: 'cpu-sustained',
            metric: 'cpu',
            valuePattern: '(\\d+)%',
            threshold: 80,
            operator: 'gt',
            windowMs: 60000,
            minSamples: 3,
            severity: 'warning',
            title: 'Sustained high CPU',
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      // 1st sample — not enough
      await emitLog(infra, 'cpu at 95%');
      assert.strictEqual(incidents.length, 0);

      // 2nd sample — still not enough
      await emitLog(infra, 'cpu at 92%');
      assert.strictEqual(incidents.length, 0);

      // 3rd sample — now we have minSamples
      await emitLog(infra, 'cpu at 88%');
      assert.strictEqual(incidents.length, 1);
    });

    it('should not fire when some samples are below threshold', async () => {
      const ctx = buildContext(infra, {
        rules: [
          {
            id: 'cpu-sustained',
            metric: 'cpu',
            valuePattern: '(\\d+)%',
            threshold: 80,
            operator: 'gt',
            windowMs: 60000,
            minSamples: 3,
            severity: 'warning',
            title: 'Sustained high CPU',
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      await emitLog(infra, 'cpu at 95%');
      await emitLog(infra, 'cpu at 70%'); // below threshold
      await emitLog(infra, 'cpu at 85%');

      // Only 2 breaching samples (95, 85), need 3 minSamples breaching
      assert.strictEqual(incidents.length, 0);
    });
  });

  describe('cooldown', () => {
    it('should suppress incidents within cooldown window', async () => {
      const ctx = buildContext(infra, {
        rules: [
          {
            id: 'cpu-cooldown',
            metric: 'cpu',
            valuePattern: '(\\d+)%',
            threshold: 90,
            operator: 'gt',
            severity: 'critical',
            title: 'High CPU',
            cooldownMs: 60000,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      await emitLog(infra, 'cpu at 95%');
      await emitLog(infra, 'cpu at 98%');
      await emitLog(infra, 'cpu at 99%');

      // Only 1 due to cooldown
      assert.strictEqual(incidents.length, 1);
    });
  });

  describe('rate limiting', () => {
    it('should enforce global rate limit', async () => {
      const rules = [];
      for (let i = 0; i < 5; i++) {
        rules.push({
          id: `rule-${i}`,
          metric: `metric${i}`,
          valuePattern: '(\\d+)',
          threshold: 0,
          operator: 'gt',
          severity: 'info',
          title: `Rule ${i}`,
          cooldownMs: 0,
          enabled: true,
        });
      }

      const ctx = buildContext(infra, {
        rules,
        maxIncidentsPerMinute: 3,
      });
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      for (let i = 0; i < 5; i++) {
        await emitLog(infra, `metric${i}: 42`);
      }

      assert.strictEqual(incidents.length, 3);
    });
  });

  describe('lifecycle', () => {
    it('should not receive events after stop', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      await detector.stop();
      await emitLog(infra, 'cpu usage at 95%');

      assert.strictEqual(incidents.length, 0);
    });

    it('should report health correctly', () => {
      const h = detector.health();
      assert.strictEqual(h.status, 'healthy');
      assert.strictEqual(h.details!.linesScanned, 0);
      assert.strictEqual(h.details!.incidentsCreated, 0);
    });
  });

  describe('interpolation', () => {
    it('should interpolate $metric, $value, $threshold in title and description', async () => {
      const ctx = buildContext(infra, {
        rules: [
          {
            id: 'interpolation-test',
            metric: 'disk usage',
            valuePattern: '(\\d+)%',
            threshold: 85,
            operator: 'gte',
            severity: 'warning',
            title: 'Disk at $value% ($operator $threshold%)',
            description: '$metric detected $value% $operator $threshold%',
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      await emitLog(infra, 'disk usage at 92%');

      assert.strictEqual(incidents.length, 1);
      assert.ok(incidents[0].title.includes('92'));
      assert.ok(incidents[0].title.includes('85'));
      assert.ok(incidents[0].title.includes('>='));
      assert.ok(incidents[0].description.includes('disk usage'));
    });
  });
});
