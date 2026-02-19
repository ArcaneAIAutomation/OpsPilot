// ---------------------------------------------------------------------------
// OpsPilot — detector.anomaly Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AnomalyDetector } from '../src/modules/detector.anomaly/index';
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
    moduleId: 'detector.anomaly',
    config: {
      maxIncidentsPerMinute: 30,
      metrics: [
        {
          id: 'cpu-metric',
          name: 'CPU Usage',
          pattern: 'cpu_usage',
          valuePattern: 'cpu_usage[=:](\\d+\\.?\\d*)',
          flags: 'i',
          method: 'zscore',
          sensitivity: 2.0,
          direction: 'both',
          trainingWindowSize: 100,
          minTrainingSamples: 5,
          ewmaAlpha: 0.3,
          severity: 'warning',
          cooldownMs: 0,
          enabled: true,
        },
      ],
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'detector.anomaly'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function emitLog(infra: ReturnType<typeof createTestInfra>, line: string) {
  const payload: LogIngestedPayload = {
    source: '/var/log/metrics',
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

describe('AnomalyDetector', () => {
  let detector: AnomalyDetector;
  let infra: ReturnType<typeof createTestInfra>;

  beforeEach(() => {
    detector = new AnomalyDetector();
    infra = createTestInfra();
  });

  afterEach(async () => {
    try { await detector.stop(); } catch { /* may not be started */ }
    try { await detector.destroy(); } catch { /* ok */ }
  });

  // ── Manifest ─────────────────────────────────────────────────────────────

  describe('manifest', () => {
    it('should have correct manifest', () => {
      assert.strictEqual(detector.manifest.id, 'detector.anomaly');
      assert.strictEqual(detector.manifest.type, 'detector');
      assert.ok(detector.manifest.configSchema);
    });
  });

  // ── Initialization ───────────────────────────────────────────────────────

  describe('initialization', () => {
    it('should compile valid metrics', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);

      const h = detector.health();
      assert.ok(h.details);
      assert.strictEqual(h.details!.activeMetrics, 1);
    });

    it('should fail on invalid regex pattern', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'bad',
            name: 'Bad Metric',
            pattern: '[invalid',
            valuePattern: '(\\d+)',
            method: 'zscore',
            sensitivity: 2.0,
            severity: 'warning',
            enabled: true,
          },
        ],
      });
      await assert.rejects(() => detector.initialize(ctx), /invalid regex/i);
    });

    it('should skip disabled metrics', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'disabled-metric',
            name: 'Disabled',
            pattern: 'cpu',
            valuePattern: '(\\d+)',
            method: 'zscore',
            sensitivity: 2.0,
            severity: 'critical',
            enabled: false,
          },
        ],
      });
      await detector.initialize(ctx);
      assert.strictEqual(detector.health().details!.activeMetrics, 0);
    });

    it('should apply defaults for optional config fields', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'minimal',
            name: 'Minimal Config',
            pattern: 'test',
            valuePattern: '(\\d+)',
          },
        ],
      });
      await detector.initialize(ctx);
      const compiled = detector.getCompiledMetrics();
      assert.strictEqual(compiled.length, 1);
      assert.strictEqual(compiled[0].method, 'zscore');
      assert.strictEqual(compiled[0].sensitivity, 3.0);
      assert.strictEqual(compiled[0].direction, 'both');
      assert.strictEqual(compiled[0].trainingWindowSize, 100);
      assert.strictEqual(compiled[0].minTrainingSamples, 20);
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should subscribe and unsubscribe from events', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      // Should process log events
      emitLog(infra, 'cpu_usage=50');
      assert.strictEqual(detector.getMetrics().linesScanned, 1);

      await detector.stop();

      // After stop, should not process further events
      emitLog(infra, 'cpu_usage=60');
      assert.strictEqual(detector.getMetrics().linesScanned, 1);
    });

    it('should report healthy status', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      const health = detector.health();
      assert.strictEqual(health.status, 'healthy');
      assert.ok(health.lastCheck);
    });

    it('should clear windows on destroy', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      detector.injectValue('cpu-metric', 50);
      assert.ok(detector.getWindow('cpu-metric').length > 0);

      await detector.destroy();
      assert.strictEqual(detector.getWindow('cpu-metric').length, 0);
    });
  });

  // ── Training Phase ───────────────────────────────────────────────────────

  describe('training phase', () => {
    it('should not detect anomalies before reaching minTrainingSamples', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'train-test',
            name: 'Training Test',
            pattern: 'temp',
            valuePattern: 'temp=(\\d+)',
            method: 'zscore',
            sensitivity: 2.0,
            minTrainingSamples: 10,
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

      // Feed 9 normal values and 1 extreme — but we're still in training
      for (let i = 0; i < 9; i++) {
        emitLog(infra, `temp=${50 + i}`);
      }
      // This line is extreme but we don't have enough samples yet
      emitLog(infra, 'temp=999');

      assert.strictEqual(incidents.length, 0);
      assert.strictEqual(detector.getMetrics().samplesCollected, 10);
    });

    it('injectValue should return non-anomaly result during training', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);

      const result = detector.injectValue('cpu-metric', 999);
      assert.ok(result);
      assert.strictEqual(result!.isAnomaly, false);
    });
  });

  // ── Z-Score Detection ────────────────────────────────────────────────────

  describe('z-score detection', () => {
    it('should detect high anomaly with z-score', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      // Train with stable values around 50
      for (let i = 0; i < 10; i++) {
        emitLog(infra, `cpu_usage=${50 + (i % 3)}`);
      }

      // Now inject an extreme value
      emitLog(infra, 'cpu_usage=200');

      assert.strictEqual(incidents.length, 1);
      assert.ok(incidents[0].title.includes('CPU Usage'));
      assert.strictEqual(incidents[0].severity, 'warning');
      assert.strictEqual(incidents[0].detectedBy, 'detector.anomaly');
    });

    it('should detect low anomaly with z-score', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      // Train with values around 100
      for (let i = 0; i < 10; i++) {
        emitLog(infra, `cpu_usage=${100 + (i % 3)}`);
      }

      // Anomalously low — but still positive so the regex matches
      emitLog(infra, 'cpu_usage=0');

      assert.strictEqual(incidents.length, 1);
      assert.ok(incidents[0].title.includes('below'));
    });

    it('should not fire for values within normal range', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      // Train with stable values
      for (let i = 0; i < 10; i++) {
        emitLog(infra, `cpu_usage=${50}`);
      }

      // Value within range
      emitLog(infra, 'cpu_usage=51');

      assert.strictEqual(incidents.length, 0);
    });

    it('should return correct deviation score via injectValue', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);

      // Build baseline: all 50s
      for (let i = 0; i < 10; i++) {
        detector.injectValue('cpu-metric', 50);
      }

      // stddev is 0 => effectiveSD = 1, z = |100 - 50| / 1 = 50
      const result = detector.injectValue('cpu-metric', 100);
      assert.ok(result);
      assert.strictEqual(result!.isAnomaly, true);
      assert.ok(result!.deviationScore > 2.0);
      assert.strictEqual(result!.method, 'zscore');
    });
  });

  // ── MAD Detection ────────────────────────────────────────────────────────

  describe('MAD detection', () => {
    it('should detect anomaly using MAD method', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'mad-metric',
            name: 'MAD Metric',
            pattern: 'metric_val',
            valuePattern: 'metric_val=(\\d+\\.?\\d*)',
            method: 'mad',
            sensitivity: 2.0,
            minTrainingSamples: 5,
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);

      // Train with stable data
      const trainValues = [50, 51, 49, 50, 52, 48, 50, 51, 49, 50];
      detector.trainMetric('mad-metric', trainValues);

      // Inject outlier
      const result = detector.injectValue('mad-metric', 200);
      assert.ok(result);
      assert.strictEqual(result!.isAnomaly, true);
      assert.strictEqual(result!.method, 'mad');
    });

    it('should not flag normal values with MAD', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'mad-metric',
            name: 'MAD Metric',
            pattern: 'metric_val',
            valuePattern: 'metric_val=(\\d+)',
            method: 'mad',
            sensitivity: 3.0,
            minTrainingSamples: 5,
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);

      detector.trainMetric('mad-metric', [50, 51, 49, 50, 52, 48, 50, 51, 49, 50]);

      const result = detector.injectValue('mad-metric', 51);
      assert.ok(result);
      assert.strictEqual(result!.isAnomaly, false);
    });
  });

  // ── IQR Detection ────────────────────────────────────────────────────────

  describe('IQR detection', () => {
    it('should detect anomaly using IQR method', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'iqr-metric',
            name: 'IQR Metric',
            pattern: 'iqr_val',
            valuePattern: 'iqr_val=(\\d+\\.?\\d*)',
            method: 'iqr',
            sensitivity: 1.5,
            minTrainingSamples: 5,
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);

      // Create a spread dataset
      detector.trainMetric('iqr-metric', [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);

      // Way outside IQR bounds
      const result = detector.injectValue('iqr-metric', 500);
      assert.ok(result);
      assert.strictEqual(result!.isAnomaly, true);
      assert.strictEqual(result!.method, 'iqr');
    });

    it('should not flag values within IQR range', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'iqr-metric',
            name: 'IQR Metric',
            pattern: 'iqr_val',
            valuePattern: 'iqr_val=(\\d+)',
            method: 'iqr',
            sensitivity: 1.5,
            minTrainingSamples: 5,
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);

      detector.trainMetric('iqr-metric', [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);

      const result = detector.injectValue('iqr-metric', 55);
      assert.ok(result);
      assert.strictEqual(result!.isAnomaly, false);
    });
  });

  // ── EWMA Detection ──────────────────────────────────────────────────────

  describe('EWMA detection', () => {
    it('should detect anomaly using EWMA method', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'ewma-metric',
            name: 'EWMA Metric',
            pattern: 'ewma_val',
            valuePattern: 'ewma_val=(\\d+\\.?\\d*)',
            method: 'ewma',
            sensitivity: 2.0,
            ewmaAlpha: 0.3,
            minTrainingSamples: 5,
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);

      // Train with stable values
      detector.trainMetric('ewma-metric', [50, 51, 49, 50, 52, 48, 50, 51, 49, 50]);

      // Inject large spike
      const result = detector.injectValue('ewma-metric', 200);
      assert.ok(result);
      assert.strictEqual(result!.isAnomaly, true);
      assert.strictEqual(result!.method, 'ewma');
    });

    it('should not flag gradual shifts with EWMA', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'ewma-metric',
            name: 'EWMA Metric',
            pattern: 'ewma_val',
            valuePattern: 'ewma_val=(\\d+)',
            method: 'ewma',
            sensitivity: 3.0,
            ewmaAlpha: 0.3,
            minTrainingSamples: 5,
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);

      // Gradually increasing values
      const values = Array.from({ length: 20 }, (_, i) => 50 + i * 0.5);
      detector.trainMetric('ewma-metric', values);

      // Slightly higher — EWMA should have adapted
      const result = detector.injectValue('ewma-metric', 60.5);
      assert.ok(result);
      assert.strictEqual(result!.isAnomaly, false);
    });
  });

  // ── Direction Filtering ──────────────────────────────────────────────────

  describe('direction filtering', () => {
    it('should only detect high anomalies when direction=high', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'high-only',
            name: 'High Only',
            pattern: 'val',
            valuePattern: 'val=([-\\d.]+)',
            method: 'zscore',
            direction: 'high',
            sensitivity: 2.0,
            minTrainingSamples: 5,
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);

      // Train baseline
      detector.trainMetric('high-only', [50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);

      // Low anomaly — should NOT be detected
      const resultLow = detector.injectValue('high-only', -100);
      assert.ok(resultLow);
      assert.strictEqual(resultLow!.isAnomaly, false);

      // High anomaly — should be detected
      const resultHigh = detector.injectValue('high-only', 200);
      assert.ok(resultHigh);
      assert.strictEqual(resultHigh!.isAnomaly, true);
    });

    it('should only detect low anomalies when direction=low', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'low-only',
            name: 'Low Only',
            pattern: 'val',
            valuePattern: 'val=([-\\d.]+)',
            method: 'zscore',
            direction: 'low',
            sensitivity: 2.0,
            minTrainingSamples: 5,
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);

      detector.trainMetric('low-only', [50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);

      // High anomaly — should NOT be detected
      const resultHigh = detector.injectValue('low-only', 200);
      assert.ok(resultHigh);
      assert.strictEqual(resultHigh!.isAnomaly, false);

      // Low anomaly — should be detected
      const resultLow = detector.injectValue('low-only', -100);
      assert.ok(resultLow);
      assert.strictEqual(resultLow!.isAnomaly, true);
    });

    it('should detect both directions when direction=both', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);

      detector.trainMetric('cpu-metric', [50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);

      const high = detector.injectValue('cpu-metric', 200);
      assert.ok(high);
      assert.strictEqual(high!.isAnomaly, true);

      // Rebuild window
      detector.trainMetric('cpu-metric', [50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);

      const low = detector.injectValue('cpu-metric', -100);
      assert.ok(low);
      assert.strictEqual(low!.isAnomaly, true);
    });
  });

  // ── Cooldown ─────────────────────────────────────────────────────────────

  describe('cooldown', () => {
    it('should suppress incidents within cooldown period', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'cooldown-metric',
            name: 'Cooldown Metric',
            pattern: 'cd_val',
            valuePattern: 'cd_val=(\\d+)',
            method: 'zscore',
            sensitivity: 2.0,
            minTrainingSamples: 5,
            cooldownMs: 60_000,
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

      // Train
      for (let i = 0; i < 10; i++) {
        emitLog(infra, `cd_val=50`);
      }

      // First anomaly — should fire
      emitLog(infra, 'cd_val=999');
      assert.strictEqual(incidents.length, 1);

      // Second anomaly immediately — should be suppressed by cooldown
      emitLog(infra, 'cd_val=998');
      assert.strictEqual(incidents.length, 1);
    });

    it('should fire again after cooldown expires', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'cd-expire',
            name: 'Cooldown Expire',
            pattern: 'cd_val',
            valuePattern: 'cd_val=(\\d+)',
            method: 'zscore',
            sensitivity: 2.0,
            minTrainingSamples: 5,
            cooldownMs: 50,
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

      // Train
      for (let i = 0; i < 10; i++) {
        emitLog(infra, `cd_val=50`);
      }

      emitLog(infra, 'cd_val=999');
      assert.strictEqual(incidents.length, 1);

      // Wait for cooldown to expire
      await sleep(60);

      emitLog(infra, 'cd_val=999');
      assert.strictEqual(incidents.length, 2);
    });
  });

  // ── Rate Limiting ────────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('should enforce global rate limit', async () => {
      const ctx = buildContext(infra, {
        maxIncidentsPerMinute: 3,
        metrics: [
          {
            id: 'rate-metric',
            name: 'Rate Metric',
            pattern: 'rate_v',
            valuePattern: 'rate_v=(\\d+)',
            method: 'zscore',
            sensitivity: 2.0,
            trainingWindowSize: 200,
            minTrainingSamples: 5,
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

      // Train with many stable values so anomalies don't shift baseline
      for (let i = 0; i < 50; i++) {
        emitLog(infra, `rate_v=50`);
      }

      // Fire more anomalies than the rate limit allows
      for (let i = 0; i < 10; i++) {
        emitLog(infra, `rate_v=${99999 + i}`);
      }

      assert.strictEqual(incidents.length, 3);
    });
  });

  // ── Log Line Parsing ─────────────────────────────────────────────────────

  describe('log line parsing', () => {
    it('should extract values from matching log lines', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      emitLog(infra, 'cpu_usage=72.5');
      assert.strictEqual(detector.getMetrics().samplesCollected, 1);
      assert.deepStrictEqual(detector.getWindow('cpu-metric'), [72.5]);
    });

    it('should ignore non-matching log lines', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      emitLog(infra, 'memory_free=4096');
      assert.strictEqual(detector.getMetrics().samplesCollected, 0);
      assert.strictEqual(detector.getMetrics().linesScanned, 1);
    });

    it('should ignore lines matching pattern but without valid number', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      emitLog(infra, 'cpu_usage=notanumber');
      assert.strictEqual(detector.getMetrics().samplesCollected, 0);
    });

    it('should handle multiple metrics from a single line', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'metric-a',
            name: 'Metric A',
            pattern: 'alpha',
            valuePattern: 'alpha=(\\d+)',
            method: 'zscore',
            sensitivity: 2.0,
            minTrainingSamples: 5,
            cooldownMs: 0,
            enabled: true,
          },
          {
            id: 'metric-b',
            name: 'Metric B',
            pattern: 'beta',
            valuePattern: 'beta=(\\d+)',
            method: 'zscore',
            sensitivity: 2.0,
            minTrainingSamples: 5,
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);
      await detector.start();

      emitLog(infra, 'alpha=50 beta=60');
      assert.strictEqual(detector.getMetrics().samplesCollected, 2);
    });
  });

  // ── Window Management ────────────────────────────────────────────────────

  describe('window management', () => {
    it('should bound window to trainingWindowSize', async () => {
      const ctx = buildContext(infra, {
        metrics: [
          {
            id: 'bounded',
            name: 'Bounded',
            pattern: 'bw',
            valuePattern: 'bw=(\\d+)',
            method: 'zscore',
            sensitivity: 2.0,
            trainingWindowSize: 10,
            minTrainingSamples: 5,
            cooldownMs: 0,
            enabled: true,
          },
        ],
      });
      await detector.initialize(ctx);

      for (let i = 0; i < 20; i++) {
        detector.injectValue('bounded', i);
      }

      assert.strictEqual(detector.getWindow('bounded').length, 10);
      // Should contain the latest 10 values: 10..19
      assert.strictEqual(detector.getWindow('bounded')[0], 10);
    });

    it('should return empty window for unknown metric', () => {
      assert.deepStrictEqual(detector.getWindow('nonexistent'), []);
    });
  });

  // ── Incident Payload ─────────────────────────────────────────────────────

  describe('incident payload', () => {
    it('should emit well-formed incidents', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      const incidents: IncidentCreatedPayload[] = [];
      infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (evt) => {
        incidents.push(evt.payload);
      });

      // Train
      for (let i = 0; i < 10; i++) {
        emitLog(infra, `cpu_usage=50`);
      }

      emitLog(infra, 'cpu_usage=500');

      assert.strictEqual(incidents.length, 1);
      const inc = incidents[0];
      assert.ok(inc.incidentId.startsWith('INC-ANOM-'));
      assert.ok(inc.title.includes('CPU Usage'));
      assert.ok(inc.description.includes('500'));
      assert.strictEqual(inc.severity, 'warning');
      assert.strictEqual(inc.detectedBy, 'detector.anomaly');
      assert.ok(inc.detectedAt instanceof Date);
      assert.ok(inc.context);

      const ctx2 = inc.context as Record<string, unknown>;
      assert.strictEqual(ctx2.metricId, 'cpu-metric');
      assert.strictEqual(ctx2.method, 'zscore');
      assert.strictEqual(ctx2.value, 500);
    });
  });

  // ── Health Report ────────────────────────────────────────────────────────

  describe('health', () => {
    it('should report complete health details', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);
      await detector.start();

      // Feed data
      for (let i = 0; i < 5; i++) {
        emitLog(infra, `cpu_usage=50`);
      }

      const h = detector.health();
      assert.ok(h.details);
      assert.strictEqual(h.details!.activeMetrics, 1);
      assert.strictEqual(h.details!.linesScanned, 5);
      assert.strictEqual(h.details!.samplesCollected, 5);
      assert.ok(typeof (h.details!.windowSizes as Record<string, number>)['cpu-metric'] === 'number');
    });
  });

  // ── Test Accessors ───────────────────────────────────────────────────────

  describe('test accessors', () => {
    it('injectValue should return null for unknown metric', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);

      const result = detector.injectValue('no-such-metric', 42);
      assert.strictEqual(result, null);
    });

    it('trainMetric should populate window', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);

      const values = [10, 20, 30, 40, 50];
      detector.trainMetric('cpu-metric', values);

      assert.strictEqual(detector.getWindow('cpu-metric').length, 5);
    });

    it('getConfig should return parsed config', async () => {
      const ctx = buildContext(infra);
      await detector.initialize(ctx);

      const cfg = detector.getConfig();
      assert.strictEqual(cfg.maxIncidentsPerMinute, 30);
      assert.ok(Array.isArray(cfg.metrics));
    });
  });
});
