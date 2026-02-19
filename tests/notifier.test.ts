// ---------------------------------------------------------------------------
// OpsPilot — notifier.channels Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NotifierChannelsModule } from '../src/modules/notifier.channels/index';
import { ModuleContext } from '../src/core/types/module';
import { OpsPilotEvent } from '../src/core/types/events';
import {
  IncidentCreatedPayload,
  ActionProposedPayload,
  ActionExecutedPayload,
  EnrichmentCompletedPayload,
} from '../src/shared/events';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function buildContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'notifier.channels',
    config: {
      channels: [
        {
          id: 'console-all',
          type: 'console',
          events: ['incident.created', 'action.proposed', 'action.approved', 'action.executed', 'enrichment.completed'],
          enabled: true,
        },
      ],
      rateLimitPerMinute: 60,
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'notifier.channels'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

/** Capture stdout writes during async work. */
function captureStdout(fn: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    lines.push(chunk);
    return true;
  }) as typeof process.stdout.write;

  return Promise.resolve(fn()).then(() => {
    process.stdout.write = original;
    return lines;
  }).catch((err) => {
    process.stdout.write = original;
    throw err;
  });
}

function emitIncident(
  infra: ReturnType<typeof createTestInfra>,
  severity: 'info' | 'warning' | 'critical' = 'critical',
) {
  const payload: IncidentCreatedPayload = {
    incidentId: 'INC-001',
    title: 'High CPU Alert',
    description: 'CPU usage exceeded 95%',
    severity,
    detectedBy: 'detector.regex',
    detectedAt: new Date(),
  };
  return infra.bus.publish<IncidentCreatedPayload>({
    type: 'incident.created',
    source: 'detector.regex',
    timestamp: new Date(),
    payload,
  });
}

function emitActionProposed(infra: ReturnType<typeof createTestInfra>) {
  const payload: ActionProposedPayload = {
    requestId: 'req-001',
    actionType: 'restart_service',
    description: 'Restart nginx to recover',
    reasoning: 'CPU overload detected',
    requestedBy: 'ai-agent',
  };
  return infra.bus.publish<ActionProposedPayload>({
    type: 'action.proposed',
    source: 'action.safe',
    timestamp: new Date(),
    payload,
  });
}

function emitActionExecuted(infra: ReturnType<typeof createTestInfra>) {
  const payload: ActionExecutedPayload = {
    requestId: 'req-001',
    tokenId: 'tok-001',
    actionType: 'restart_service',
    result: 'success',
    output: 'Service restarted successfully',
    executedBy: 'action.safe',
    executedAt: new Date(),
  };
  return infra.bus.publish<ActionExecutedPayload>({
    type: 'action.executed',
    source: 'action.safe',
    timestamp: new Date(),
    payload,
  });
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe('NotifierChannelsModule', () => {
  let notifier: NotifierChannelsModule;
  let infra: ReturnType<typeof createTestInfra>;

  beforeEach(() => {
    notifier = new NotifierChannelsModule();
    infra = createTestInfra();
  });

  afterEach(async () => {
    try { await notifier.stop(); } catch { /* may not be started */ }
    try { await notifier.destroy(); } catch { /* ok */ }
  });

  describe('manifest', () => {
    it('should have correct manifest', () => {
      assert.strictEqual(notifier.manifest.id, 'notifier.channels');
      assert.strictEqual(notifier.manifest.type, 'notifier');
      assert.ok(notifier.manifest.configSchema);
    });
  });

  describe('lifecycle', () => {
    it('should initialize and start without errors', async () => {
      const ctx = buildContext(infra);
      await notifier.initialize(ctx);
      await notifier.start();

      const h = notifier.health();
      assert.strictEqual(h.status, 'healthy');
    });

    it('should stop and report stats', async () => {
      const ctx = buildContext(infra);
      await notifier.initialize(ctx);
      await notifier.start();
      await notifier.stop();

      const h = notifier.health();
      assert.strictEqual(h.status, 'healthy');
    });

    it('should reject webhook channel without URL', async () => {
      const ctx = buildContext(infra, {
        channels: [
          { id: 'bad-webhook', type: 'webhook', events: ['incident.created'] },
        ],
      });
      await assert.rejects(
        () => notifier.initialize(ctx),
        /webhookUrl/,
      );
    });

    it('should skip disabled channels', async () => {
      const ctx = buildContext(infra, {
        channels: [
          { id: 'disabled', type: 'console', events: ['incident.created'], enabled: false },
          { id: 'enabled', type: 'console', events: ['incident.created'], enabled: true },
        ],
      });
      await notifier.initialize(ctx);
      await notifier.start();

      // Module should only subscribe for enabled channels
      const h = notifier.health();
      assert.strictEqual(h.status, 'healthy');
    });
  });

  describe('console notifications', () => {
    it('should print incident notification', async () => {
      const ctx = buildContext(infra);
      await notifier.initialize(ctx);
      await notifier.start();

      const output = await captureStdout(async () => {
        await emitIncident(infra, 'critical');
      });
      const text = output.join('');
      assert.ok(text.includes('INCIDENT'));
      assert.ok(text.includes('CRITICAL'));
      assert.ok(text.includes('High CPU Alert'));

      const h = notifier.health();
      assert.strictEqual(h.details!.totalSent, 1);
    });

    it('should print action proposed notification', async () => {
      const ctx = buildContext(infra);
      await notifier.initialize(ctx);
      await notifier.start();

      const output = await captureStdout(async () => {
        await emitActionProposed(infra);
      });
      const text = output.join('');
      assert.ok(text.includes('ACTION PROPOSED'));
      assert.ok(text.includes('restart_service'));
      assert.ok(text.includes('Awaiting approval'));
    });

    it('should print action executed notification', async () => {
      const ctx = buildContext(infra);
      await notifier.initialize(ctx);
      await notifier.start();

      const output = await captureStdout(async () => {
        await emitActionExecuted(infra);
      });
      const text = output.join('');
      assert.ok(text.includes('ACTION EXECUTED'));
      assert.ok(text.includes('SUCCESS'));
    });

    it('should handle generic events with fallback format', async () => {
      const ctx = buildContext(infra, {
        channels: [
          { id: 'generic', type: 'console', events: ['custom.event'] },
        ],
      });
      await notifier.initialize(ctx);
      await notifier.start();

      const output = await captureStdout(async () => {
        await infra.bus.publish({
          type: 'custom.event',
          source: 'test',
          timestamp: new Date(),
          payload: { foo: 'bar' },
        });
      });
      const text = output.join('');
      assert.ok(text.includes('custom.event'));
      assert.ok(text.includes('foo'));
    });
  });

  describe('severity filtering', () => {
    it('should filter out low-severity incidents', async () => {
      const ctx = buildContext(infra, {
        channels: [
          {
            id: 'critical-only',
            type: 'console',
            events: ['incident.created'],
            minSeverity: 'critical',
          },
        ],
      });
      await notifier.initialize(ctx);
      await notifier.start();

      const output = await captureStdout(async () => {
        await emitIncident(infra, 'info');
      });
      const text = output.join('');
      assert.ok(!text.includes('INCIDENT'));

      const h = notifier.health();
      assert.strictEqual(h.details!.totalSent, 0);
    });

    it('should pass through incidents at or above minSeverity', async () => {
      const ctx = buildContext(infra, {
        channels: [
          {
            id: 'warning-up',
            type: 'console',
            events: ['incident.created'],
            minSeverity: 'warning',
          },
        ],
      });
      await notifier.initialize(ctx);
      await notifier.start();

      const output = await captureStdout(async () => {
        await emitIncident(infra, 'critical');
      });
      const text = output.join('');
      assert.ok(text.includes('INCIDENT'));
    });
  });

  describe('rate limiting', () => {
    it('should drop notifications when rate limit exceeded', async () => {
      const ctx = buildContext(infra, {
        channels: [
          { id: 'rate-test', type: 'console', events: ['incident.created'] },
        ],
        rateLimitPerMinute: 3,
      });
      await notifier.initialize(ctx);
      await notifier.start();

      await captureStdout(async () => {
        for (let i = 0; i < 5; i++) {
          await emitIncident(infra, 'critical');
        }
      });

      const h = notifier.health();
      assert.strictEqual(h.details!.totalSent, 3);
      assert.strictEqual(h.details!.totalDropped, 2);
    });
  });

  describe('health', () => {
    it('should report healthy when no errors', async () => {
      const ctx = buildContext(infra);
      await notifier.initialize(ctx);
      await notifier.start();
      const h = notifier.health();
      assert.strictEqual(h.status, 'healthy');
    });

    it('should include message with stats', () => {
      const h = notifier.health();
      assert.ok(h.message!.includes('Sent'));
      assert.ok(h.message!.includes('Dropped'));
      assert.ok(h.message!.includes('Errors'));
    });
  });
});
