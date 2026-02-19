// ---------------------------------------------------------------------------
// OpsPilot — ApprovalCLI Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalCLI, CLIOptions } from '../src/cli/ApprovalCLI';
import { ApprovalGate } from '../src/core/security/ApprovalGate';
import { ApprovalStatus } from '../src/core/types/security';
import { createTestInfra, createCapturingLogger } from './helpers';
import { EventBus } from '../src/core/bus/EventBus';
import { MemoryStorage } from '../src/core/storage/MemoryStorage';
import { AuditLogger } from '../src/core/security/AuditLogger';

// We test the CLI logic by exercising its internal methods indirectly
// through the approval gate and storage, since the CLI drives stdout.
// For command parsing we create a thin test harness that captures output.

// ── Helpers ────────────────────────────────────────────────────────────────

/** Capture stdout writes during a callback. */
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

/** Create a request directly in storage (simulating what ApprovalGate does). */
async function seedPendingRequest(
  storage: MemoryStorage,
  id: string,
  actionType = 'restart_service',
  description = 'Restart nginx',
) {
  await storage.set('system::approval_requests', id, {
    id,
    actionType,
    description,
    reasoning: 'High CPU detected',
    requestedBy: 'detector.regex',
    requestedAt: new Date().toISOString(),
    status: 'pending',
    metadata: { incidentId: 'INC-001', command: 'systemctl restart nginx' },
  });
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe('ApprovalCLI', () => {
  let storage: MemoryStorage;
  let bus: EventBus;
  let audit: AuditLogger;
  let gate: ApprovalGate;
  let logger: ReturnType<typeof createCapturingLogger>;
  let cli: ApprovalCLI;

  beforeEach(() => {
    const infra = createTestInfra();
    storage = infra.storage as MemoryStorage;
    bus = infra.bus as EventBus;
    audit = infra.audit as AuditLogger;
    gate = infra.approvalGate as ApprovalGate;
    logger = createCapturingLogger();

    cli = new ApprovalCLI({
      storage,
      approvalGate: gate,
      auditLogger: audit,
      bus,
      logger,
      operatorId: 'test-operator',
    });
  });

  afterEach(() => {
    cli.stop();
  });

  // ── handleInput (via the private method, we test through the gate) ─────

  describe('pending command', () => {
    it('should report no pending requests when empty', async () => {
      const output = await captureStdout(async () => {
        await (cli as any).handleInput('pending');
      });
      const text = output.join('');
      assert.ok(text.includes('No pending'));
    });

    it('should list pending requests', async () => {
      await seedPendingRequest(storage, 'req-001');
      await seedPendingRequest(storage, 'req-002', 'scale_up', 'Scale up workers');

      const output = await captureStdout(async () => {
        await (cli as any).handleInput('pending');
      });
      const text = output.join('');
      assert.ok(text.includes('2 pending'));
      assert.ok(text.includes('req-001'));
      assert.ok(text.includes('req-002'));
      assert.ok(text.includes('restart_service'));
      assert.ok(text.includes('scale_up'));
    });

    it('should not list approved or denied requests', async () => {
      await seedPendingRequest(storage, 'req-active');
      // Mark one as approved directly in storage
      await storage.set('system::approval_requests', 'req-done', {
        id: 'req-done',
        actionType: 'test',
        description: 'done',
        reasoning: 'done',
        requestedBy: 'test',
        requestedAt: new Date().toISOString(),
        status: 'approved',
      });

      const output = await captureStdout(async () => {
        await (cli as any).handleInput('pending');
      });
      const text = output.join('');
      assert.ok(text.includes('1 pending'));
      assert.ok(text.includes('req-active'));
      assert.ok(!text.includes('req-done'));
    });
  });

  describe('approve command', () => {
    it('should approve a pending request', async () => {
      // Use the gate to create a real request
      const req = await gate.requestApproval({
        actionType: 'restart_service',
        description: 'Restart nginx',
        reasoning: 'High CPU',
        requestedBy: 'ai-agent',
      });

      const output = await captureStdout(async () => {
        await (cli as any).handleInput(`approve ${req.id}`);
      });
      const text = output.join('');
      assert.ok(text.includes('Approved'));

      // Verify status changed
      const status = await gate.getStatus(req.id);
      assert.strictEqual(status, ApprovalStatus.Approved);
    });

    it('should show error for missing request ID', async () => {
      const output = await captureStdout(async () => {
        await (cli as any).handleInput('approve');
      });
      const text = output.join('');
      assert.ok(text.includes('Usage'));
    });

    it('should show error for non-existent request', async () => {
      const output = await captureStdout(async () => {
        await (cli as any).handleInput('approve non-existent-id');
      });
      const text = output.join('');
      assert.ok(text.includes('No request found'));
    });
  });

  describe('deny command', () => {
    it('should deny a pending request with reason', async () => {
      const req = await gate.requestApproval({
        actionType: 'restart_service',
        description: 'Restart nginx',
        reasoning: 'High CPU',
        requestedBy: 'ai-agent',
      });

      const output = await captureStdout(async () => {
        await (cli as any).handleInput(`deny ${req.id} Not safe right now`);
      });
      const text = output.join('');
      assert.ok(text.includes('Denied'));
      assert.ok(text.includes('Not safe right now'));

      const status = await gate.getStatus(req.id);
      assert.strictEqual(status, ApprovalStatus.Denied);
    });

    it('should deny a request without reason', async () => {
      const req = await gate.requestApproval({
        actionType: 'restart_service',
        description: 'Restart nginx',
        reasoning: 'High CPU',
        requestedBy: 'ai-agent',
      });

      const output = await captureStdout(async () => {
        await (cli as any).handleInput(`deny ${req.id}`);
      });
      const text = output.join('');
      assert.ok(text.includes('Denied'));

      const status = await gate.getStatus(req.id);
      assert.strictEqual(status, ApprovalStatus.Denied);
    });
  });

  describe('status command', () => {
    it('should show status of a request', async () => {
      const req = await gate.requestApproval({
        actionType: 'test_action',
        description: 'Test desc',
        reasoning: 'Testing',
        requestedBy: 'unit-test',
      });

      const output = await captureStdout(async () => {
        await (cli as any).handleInput(`status ${req.id}`);
      });
      const text = output.join('');
      assert.ok(text.includes('pending'));
      assert.ok(text.includes('test_action'));
    });
  });

  describe('audit command', () => {
    it('should show recent audit entries', async () => {
      await audit.log({ action: 'test.create', actor: 'admin', target: 'service-1' });
      await audit.log({ action: 'test.delete', actor: 'admin', target: 'service-2' });

      const output = await captureStdout(async () => {
        await (cli as any).handleInput('audit');
      });
      const text = output.join('');
      assert.ok(text.includes('test.create'));
      assert.ok(text.includes('test.delete'));
      assert.ok(text.includes('admin'));
    });

    it('should respect limit argument', async () => {
      for (let i = 0; i < 10; i++) {
        await audit.log({ action: `action.${i}`, actor: 'test' });
      }

      const output = await captureStdout(async () => {
        await (cli as any).handleInput('audit 3');
      });
      const text = output.join('');
      assert.ok(text.includes('3)'));
    });

    it('should handle empty audit log', async () => {
      const output = await captureStdout(async () => {
        await (cli as any).handleInput('audit');
      });
      const text = output.join('');
      assert.ok(text.includes('No audit entries'));
    });
  });

  describe('command aliases', () => {
    it('should support p alias for pending', async () => {
      const output = await captureStdout(async () => {
        await (cli as any).handleInput('p');
      });
      const text = output.join('');
      assert.ok(text.includes('No pending'));
    });

    it('should support unknown command message', async () => {
      const output = await captureStdout(async () => {
        await (cli as any).handleInput('foobar');
      });
      const text = output.join('');
      assert.ok(text.includes('Unknown command'));
    });
  });

  describe('prefix matching', () => {
    it('should match request by ID prefix', async () => {
      const req = await gate.requestApproval({
        actionType: 'test_action',
        description: 'Test',
        reasoning: 'Test',
        requestedBy: 'test',
      });

      // Use first 8 chars as prefix
      const prefix = req.id.substring(0, 8);

      const output = await captureStdout(async () => {
        await (cli as any).handleInput(`status ${prefix}`);
      });
      const text = output.join('');
      assert.ok(text.includes('test_action'));
    });
  });

  describe('help and quit', () => {
    it('should show help text', async () => {
      const output = await captureStdout(async () => {
        await (cli as any).handleInput('help');
      });
      const text = output.join('');
      assert.ok(text.includes('Commands'));
      assert.ok(text.includes('pending'));
      assert.ok(text.includes('approve'));
      assert.ok(text.includes('deny'));
    });

    it('should support ? alias for help', async () => {
      const output = await captureStdout(async () => {
        await (cli as any).handleInput('?');
      });
      const text = output.join('');
      assert.ok(text.includes('Commands'));
    });
  });
});
