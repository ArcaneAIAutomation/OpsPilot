// ---------------------------------------------------------------------------
// OpsPilot — connector.healthCheck Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  HealthCheckConnector,
  ProbeResult,
  EndpointState,
} from '../src/modules/connector.healthCheck/index';
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
    moduleId: 'connector.healthCheck',
    config: {
      intervalMs: 60000, // long default so timer doesn't fire during tests
      timeoutMs: 5000,
      source: 'health-check-test',
      endpoints: [],
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'connector.healthCheck'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function makeEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ep-1',
    name: 'Test Service',
    url: 'http://localhost:9999/health',
    method: 'GET',
    expectedStatus: 200,
    severity: 'critical',
    consecutiveFailures: 1,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('connector.healthCheck — Health Check Connector', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: HealthCheckConnector;

  beforeEach(() => {
    infra = createTestInfra();
    mod = new HealthCheckConnector();
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  describe('Lifecycle', () => {
    it('has correct manifest', () => {
      assert.equal(mod.manifest.id, 'connector.healthCheck');
      assert.equal(mod.manifest.type, ModuleType.Connector);
    });

    it('initializes with config', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint()],
      }));
      const config = mod.getConfig();
      assert.equal(config.intervalMs, 60000);
      assert.equal(config.timeoutMs, 5000);
      assert.equal(config.endpoints.length, 1);
      assert.equal(config.endpoints[0].id, 'ep-1');
    });

    it('initializes endpoint states', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [
          makeEndpoint({ id: 'a', name: 'A' }),
          makeEndpoint({ id: 'b', name: 'B' }),
        ],
      }));
      const states = mod.getStates();
      assert.equal(states.size, 2);
      assert.equal(states.get('a')!.status, 'unknown');
      assert.equal(states.get('b')!.status, 'unknown');
    });

    it('reports healthy when no endpoints configured', async () => {
      await mod.initialize(makeContext(infra));
      const h = mod.health();
      assert.equal(h.status, 'healthy');
      assert.equal(h.details!['endpointCount'], 0);
    });

    it('applies endpoint defaults', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [{ id: 'x', name: 'X', url: 'http://example.com' }],
      }));
      const config = mod.getConfig();
      assert.equal(config.endpoints[0].method, 'GET');
      assert.equal(config.endpoints[0].expectedStatus, 200);
      assert.equal(config.endpoints[0].severity, 'critical');
      assert.equal(config.endpoints[0].consecutiveFailures, 1);
    });
  });

  describe('Health Check Cycle', () => {
    it('emits failure event when endpoint is unreachable', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint()],
      }));

      // Mock probe to simulate failure
      mod.probe = async () => ({
        success: false,
        responseMs: 150,
        error: 'Connection refused',
      });

      const events: OpsPilotEvent<LogIngestedPayload>[] = [];
      infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => {
        events.push(e);
      });

      await mod.runCycle();

      assert.equal(events.length, 1);
      assert.ok(events[0].payload.line.includes('[HEALTH_CHECK]'));
      assert.ok(events[0].payload.line.includes('[FAILURE]'));
      assert.ok(events[0].payload.line.includes('Connection refused'));
    });

    it('marks endpoint unhealthy after failure', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint()],
      }));

      mod.probe = async () => ({
        success: false,
        responseMs: 100,
        error: 'Timeout',
      });

      await mod.runCycle();

      const state = mod.getStates().get('ep-1')!;
      assert.equal(state.status, 'unhealthy');
      assert.equal(state.consecutiveFails, 1);
      assert.equal(state.lastError, 'Timeout');
    });

    it('marks endpoint healthy on success', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint()],
      }));

      mod.probe = async () => ({
        success: true,
        responseMs: 42,
        statusCode: 200,
      });

      await mod.runCycle();

      const state = mod.getStates().get('ep-1')!;
      assert.equal(state.status, 'healthy');
      assert.equal(state.consecutiveFails, 0);
      assert.equal(state.lastResponseMs, 42);
    });

    it('emits recovery event when endpoint recovers', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint()],
      }));

      // First cycle: failure
      mod.probe = async () => ({ success: false, responseMs: 100, error: 'Down' });
      await mod.runCycle();

      const events: OpsPilotEvent<LogIngestedPayload>[] = [];
      infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => {
        events.push(e);
      });

      // Second cycle: success (recovery)
      mod.probe = async () => ({ success: true, responseMs: 30, statusCode: 200 });
      await mod.runCycle();

      assert.equal(events.length, 1);
      assert.ok(events[0].payload.line.includes('[RECOVERY]'));
      assert.ok(events[0].payload.line.includes('Test Service'));
    });

    it('tracks recovery count', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint()],
      }));

      mod.probe = async () => ({ success: false, responseMs: 100, error: 'err' });
      await mod.runCycle();

      mod.probe = async () => ({ success: true, responseMs: 30, statusCode: 200 });
      await mod.runCycle();

      const metrics = mod.getMetrics();
      assert.equal(metrics.totalRecoveries, 1);
    });

    it('does not emit failure until consecutiveFailures threshold', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint({ consecutiveFailures: 3 })],
      }));

      mod.probe = async () => ({ success: false, responseMs: 100, error: 'fail' });

      const events: OpsPilotEvent<LogIngestedPayload>[] = [];
      infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => {
        events.push(e);
      });

      // 1st and 2nd failure — no event
      await mod.runCycle();
      await mod.runCycle();
      assert.equal(events.length, 0);

      // 3rd failure — threshold reached
      await mod.runCycle();
      assert.equal(events.length, 1);
      assert.ok(events[0].payload.line.includes('attempt 3'));
    });

    it('resets consecutive failures on success', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint({ consecutiveFailures: 3 })],
      }));

      mod.probe = async () => ({ success: false, responseMs: 100, error: 'fail' });
      await mod.runCycle(); // fail 1
      await mod.runCycle(); // fail 2

      mod.probe = async () => ({ success: true, responseMs: 30, statusCode: 200 });
      await mod.runCycle(); // success — resets counter

      const state = mod.getStates().get('ep-1')!;
      assert.equal(state.consecutiveFails, 0);
    });
  });

  describe('Multi-Endpoint', () => {
    it('checks all endpoints in a cycle', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [
          makeEndpoint({ id: 'a', name: 'Service A', url: 'http://a.test' }),
          makeEndpoint({ id: 'b', name: 'Service B', url: 'http://b.test' }),
        ],
      }));

      let probeCount = 0;
      mod.probe = async () => {
        probeCount++;
        return { success: true, responseMs: 10, statusCode: 200 };
      };

      await mod.runCycle();

      assert.equal(probeCount, 2);
      assert.equal(mod.getMetrics().totalProbes, 2);
    });

    it('reports degraded health when any endpoint is unhealthy', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [
          makeEndpoint({ id: 'a', name: 'A' }),
          makeEndpoint({ id: 'b', name: 'B' }),
        ],
      }));

      let callCount = 0;
      mod.probe = async () => {
        callCount++;
        if (callCount === 1) {
          return { success: true, responseMs: 10, statusCode: 200 };
        }
        return { success: false, responseMs: 100, error: 'Down' };
      };

      await mod.runCycle();

      const h = mod.health();
      assert.equal(h.status, 'degraded');
      assert.equal(h.details!['unhealthyEndpoints'], 1);
    });
  });

  describe('Metrics', () => {
    it('tracks total cycles and probes', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint()],
      }));

      mod.probe = async () => ({ success: true, responseMs: 10, statusCode: 200 });

      await mod.runCycle();
      await mod.runCycle();

      const m = mod.getMetrics();
      assert.equal(m.totalCycles, 2);
      assert.equal(m.totalProbes, 2);
    });

    it('tracks total failures', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint()],
      }));

      mod.probe = async () => ({ success: false, responseMs: 100, error: 'err' });
      await mod.runCycle();

      assert.equal(mod.getMetrics().totalFailures, 1);
    });

    it('tracks per-endpoint stats', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint()],
      }));

      mod.probe = async () => ({ success: false, responseMs: 100, error: 'err' });
      await mod.runCycle();
      await mod.runCycle();

      const state = mod.getStates().get('ep-1')!;
      assert.equal(state.totalChecks, 2);
      assert.equal(state.totalFailures, 2);
    });
  });

  describe('Event Metadata', () => {
    it('includes endpoint details in event metadata', async () => {
      await mod.initialize(makeContext(infra, {
        endpoints: [makeEndpoint({ severity: 'warning' })],
      }));

      mod.probe = async () => ({ success: false, responseMs: 100, error: 'fail' });

      const events: OpsPilotEvent<LogIngestedPayload>[] = [];
      infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => {
        events.push(e);
      });

      await mod.runCycle();

      assert.equal(events.length, 1);
      const meta = events[0].payload.metadata!;
      assert.equal(meta['endpointId'], 'ep-1');
      assert.equal(meta['endpointName'], 'Test Service');
      assert.equal(meta['severity'], 'warning');
      assert.equal(meta['collector'], 'connector.healthCheck');
    });

    it('sets source from config', async () => {
      await mod.initialize(makeContext(infra, {
        source: 'my-checks',
        endpoints: [makeEndpoint()],
      }));

      mod.probe = async () => ({ success: false, responseMs: 100, error: 'fail' });

      const events: OpsPilotEvent<LogIngestedPayload>[] = [];
      infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => {
        events.push(e);
      });

      await mod.runCycle();

      assert.equal(events[0].payload.source, 'my-checks');
    });
  });
});
