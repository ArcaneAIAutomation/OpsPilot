// ---------------------------------------------------------------------------
// OpsPilot — action.safe Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SafeActionModule } from '../src/modules/action.safe/index';
import { ModuleContext } from '../src/core/types/module';
import { OpsPilotEvent } from '../src/core/types/events';
import {
  IncidentCreatedPayload,
  ActionExecutedPayload,
} from '../src/shared/events';
import { ApprovalRequest, ApprovalToken } from '../src/core/types/security';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { createTestInfra, sleep } from './helpers';

// ── Helper: build context ──────────────────────────────────────────────────

function buildContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'action.safe',
    config: {
      autoPropose: true,
      proposalDelaySec: 0,   // no delay for tests
      actions: [
        {
          id: 'restart-service',
          actionType: 'service.restart',
          description: 'Restart the failing service',
          triggerSeverity: ['critical'],
          triggerPattern: 'Error',
          command: 'systemctl restart app',
          enabled: true,
        },
        {
          id: 'clear-logs',
          actionType: 'logs.clear',
          description: 'Clear old log files',
          triggerSeverity: ['warning', 'critical'],
          enabled: true,
        },
      ],
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'action.safe'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

// ── Helper: emit incident.created ──────────────────────────────────────────

function emitIncident(
  infra: ReturnType<typeof createTestInfra>,
  id: string,
  opts?: Partial<IncidentCreatedPayload>,
) {
  const payload: IncidentCreatedPayload = {
    incidentId: id,
    title: opts?.title ?? 'Error Detected',
    description: opts?.description ?? 'An error occurred',
    severity: opts?.severity ?? 'critical',
    detectedBy: opts?.detectedBy ?? 'detector.regex',
    detectedAt: opts?.detectedAt ?? new Date(),
    context: opts?.context,
  };

  return infra.bus.publish<IncidentCreatedPayload>({
    type: 'incident.created',
    source: 'detector.regex',
    timestamp: new Date(),
    correlationId: id,
    payload,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('action.safe', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let action: SafeActionModule;

  beforeEach(() => {
    infra = createTestInfra();
    action = new SafeActionModule();
  });

  // ── Initialization ───────────────────────────────────────────────────

  it('should compile action rules on init', async () => {
    const ctx = buildContext(infra);
    await action.initialize(ctx);

    const health = action.health();
    assert.strictEqual(health.status, 'healthy');
    assert.strictEqual((health.details as any).activeRules, 2);
  });

  it('should fail on invalid trigger pattern', async () => {
    const ctx = buildContext(infra, {
      actions: [
        {
          id: 'bad',
          actionType: 'test',
          description: 'test',
          triggerSeverity: ['critical'],
          triggerPattern: '[invalid(',
          enabled: true,
        },
      ],
    });

    await assert.rejects(
      () => action.initialize(ctx),
      /invalid trigger pattern/i,
    );
  });

  it('should skip disabled rules', async () => {
    const ctx = buildContext(infra, {
      actions: [
        { id: 'disabled', actionType: 'test', description: 'd', triggerSeverity: ['info'], enabled: false },
        { id: 'enabled', actionType: 'test', description: 'e', triggerSeverity: ['info'], enabled: true },
      ],
    });

    await action.initialize(ctx);
    assert.strictEqual((action.health().details as any).activeRules, 1);
  });

  // ── Rule Matching ────────────────────────────────────────────────────

  it('should propose action when incident matches rule', async () => {
    const ctx = buildContext(infra);
    await action.initialize(ctx);
    await action.start();

    // Track approval requests
    const proposals: ApprovalRequest[] = [];
    const originalRequest = infra.approvalGate.requestApproval.bind(infra.approvalGate);

    // Wrap approvalGate.requestApproval to capture proposals
    let capturedRequest: ApprovalRequest | null = null;
    const origMethod = infra.approvalGate.requestApproval;
    infra.approvalGate.requestApproval = async (params: any) => {
      const req = await origMethod.call(infra.approvalGate, params);
      capturedRequest = req;
      proposals.push(req);
      return req;
    };

    await emitIncident(infra, 'inc-1', { severity: 'critical', title: 'Error Detected' });
    await sleep(50);

    // Should have proposed actions for matching rules
    assert.ok(proposals.length >= 1, `Expected at least 1 proposal, got ${proposals.length}`);

    await action.stop();
    await action.destroy();
  });

  it('should not propose when severity does not match', async () => {
    const ctx = buildContext(infra, {
      actions: [
        {
          id: 'critical-only',
          actionType: 'test',
          description: 'test',
          triggerSeverity: ['critical'],
          enabled: true,
        },
      ],
    });

    await action.initialize(ctx);
    await action.start();

    const proposals: ApprovalRequest[] = [];
    const origMethod = infra.approvalGate.requestApproval;
    infra.approvalGate.requestApproval = async (params: any) => {
      const req = await origMethod.call(infra.approvalGate, params);
      proposals.push(req);
      return req;
    };

    await emitIncident(infra, 'inc-1', { severity: 'info', title: 'Info Event' });
    await sleep(50);

    assert.strictEqual(proposals.length, 0);

    await action.stop();
    await action.destroy();
  });

  it('should not propose when pattern does not match title', async () => {
    const ctx = buildContext(infra, {
      actions: [
        {
          id: 'pattern-match',
          actionType: 'test',
          description: 'test',
          triggerSeverity: ['critical'],
          triggerPattern: 'OutOfMemory',
          enabled: true,
        },
      ],
    });

    await action.initialize(ctx);
    await action.start();

    const proposals: ApprovalRequest[] = [];
    const origMethod = infra.approvalGate.requestApproval;
    infra.approvalGate.requestApproval = async (params: any) => {
      const req = await origMethod.call(infra.approvalGate, params);
      proposals.push(req);
      return req;
    };

    await emitIncident(infra, 'inc-1', { severity: 'critical', title: 'Disk Full' });
    await sleep(50);

    assert.strictEqual(proposals.length, 0);

    await action.stop();
    await action.destroy();
  });

  it('should not propose when autoPropose is false', async () => {
    const ctx = buildContext(infra, { autoPropose: false });
    await action.initialize(ctx);
    await action.start();

    const proposals: ApprovalRequest[] = [];
    const origMethod = infra.approvalGate.requestApproval;
    infra.approvalGate.requestApproval = async (params: any) => {
      const req = await origMethod.call(infra.approvalGate, params);
      proposals.push(req);
      return req;
    };

    await emitIncident(infra, 'inc-1', { severity: 'critical', title: 'Error Detected' });
    await sleep(50);

    assert.strictEqual(proposals.length, 0);

    await action.stop();
    await action.destroy();
  });

  // ── Approval & Execution Flow ────────────────────────────────────────

  it('should execute action after approval with valid token', async () => {
    const ctx = buildContext(infra, {
      actions: [
        {
          id: 'test-action',
          actionType: 'test.action',
          description: 'Test execution',
          triggerSeverity: ['critical'],
          command: 'echo hello',
          enabled: true,
        },
      ],
    });

    await action.initialize(ctx);
    await action.start();

    // Capture executed actions
    const executions: OpsPilotEvent<ActionExecutedPayload>[] = [];
    infra.bus.subscribe<ActionExecutedPayload>('action.executed', (e) => {
      executions.push(e);
    });

    // Capture the approval request
    let capturedRequest: ApprovalRequest | null = null;
    const origMethod = infra.approvalGate.requestApproval;
    infra.approvalGate.requestApproval = async (params: any) => {
      const req = await origMethod.call(infra.approvalGate, params);
      capturedRequest = req;
      return req;
    };

    // Emit incident to trigger proposal
    await emitIncident(infra, 'inc-1', { severity: 'critical', title: 'Test Error' });
    await sleep(50);

    assert.ok(capturedRequest, 'Expected an approval request to be created');
    const request = capturedRequest as ApprovalRequest;

    // Approve the request
    const token = await infra.approvalGate.approve(request.id, 'admin');

    // Emit action.approved event (as the ApprovalGate would)
    await infra.bus.publish({
      type: 'action.approved',
      source: 'core.approvalGate',
      timestamp: new Date(),
      payload: {
        request: capturedRequest,
        token,
      },
    });
    await sleep(50);

    // Should have executed
    assert.strictEqual(executions.length, 1);
    assert.strictEqual(executions[0].payload.result, 'success');
    assert.ok(executions[0].payload.output?.includes('SIMULATED'));

    await action.stop();
    await action.destroy();
  });

  it('should refuse execution with invalid token', async () => {
    const ctx = buildContext(infra, {
      actions: [
        {
          id: 'test-action',
          actionType: 'test.action',
          description: 'Test',
          triggerSeverity: ['critical'],
          enabled: true,
        },
      ],
    });

    await action.initialize(ctx);
    await action.start();

    const executions: OpsPilotEvent<ActionExecutedPayload>[] = [];
    infra.bus.subscribe<ActionExecutedPayload>('action.executed', (e) => {
      executions.push(e);
    });

    // Capture approval request
    let capturedRequest: ApprovalRequest | null = null;
    const origMethod = infra.approvalGate.requestApproval;
    infra.approvalGate.requestApproval = async (params: any) => {
      const req = await origMethod.call(infra.approvalGate, params);
      capturedRequest = req;
      return req;
    };

    await emitIncident(infra, 'inc-1', { severity: 'critical', title: 'Test Error' });
    await sleep(50);

    assert.ok(capturedRequest);
    const request = capturedRequest as ApprovalRequest;

    // Send a forged token
    const forgedToken: ApprovalToken = {
      id: 'forged-token',
      requestId: request.id,
      approvedBy: 'hacker',
      approvedAt: new Date(),
    };

    await infra.bus.publish({
      type: 'action.approved',
      source: 'unknown',
      timestamp: new Date(),
      payload: {
        request: capturedRequest,
        token: forgedToken,
      },
    });
    await sleep(50);

    // Should NOT have executed
    assert.strictEqual(executions.length, 0);

    await action.stop();
    await action.destroy();
  });

  // ── Health ───────────────────────────────────────────────────────────

  it('should report health metrics', async () => {
    const ctx = buildContext(infra);
    await action.initialize(ctx);

    const health = action.health();
    assert.strictEqual(health.status, 'healthy');
    assert.strictEqual((health.details as any).actionsProposed, 0);
    assert.strictEqual((health.details as any).actionsExecuted, 0);
    assert.strictEqual((health.details as any).actionsFailed, 0);
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  it('should not receive events after stop', async () => {
    const ctx = buildContext(infra);
    await action.initialize(ctx);
    await action.start();

    const proposals: ApprovalRequest[] = [];
    const origMethod = infra.approvalGate.requestApproval;
    infra.approvalGate.requestApproval = async (params: any) => {
      const req = await origMethod.call(infra.approvalGate, params);
      proposals.push(req);
      return req;
    };

    await action.stop();

    await emitIncident(infra, 'inc-1', { severity: 'critical', title: 'Error' });
    await sleep(50);

    assert.strictEqual(proposals.length, 0);

    await action.destroy();
  });
});
