// ---------------------------------------------------------------------------
// OpsPilot — action.runbook Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RunbookEngine,
  RunbookExecution,
  RunbookStartedPayload,
  RunbookStepCompletedPayload,
  RunbookCompletedPayload,
} from '../src/modules/action.runbook/index';
import { ModuleContext, ModuleType } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { OpsPilotEvent } from '../src/core/types/events';
import {
  EnrichmentCompletedPayload,
  ActionExecutedPayload,
} from '../src/shared/events';
import { ApprovalRequest, ApprovalToken } from '../src/core/types/security';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'action.runbook',
    config: {
      autoExecute: false,
      requireApprovalPerStep: false,
      stepTimeoutMs: 30000,
      maxConcurrentRunbooks: 10,
      maxRunbookHistory: 100,
      cooldownMs: 0,
      severityFilter: ['warning', 'critical'],
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'action.runbook'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

/** Emit an enrichment.completed event with suggestedRunbooks. */
function emitRunbookEnrichment(
  infra: ReturnType<typeof createTestInfra>,
  incidentId: string = 'INC-RB-001',
  runbooks?: Array<{ id: string; title: string; steps: string[] }>,
): Promise<void> {
  const payload: EnrichmentCompletedPayload = {
    incidentId,
    enricherModule: 'enricher.aiSummary',
    enrichmentType: 'ai-summary',
    data: {
      summary: 'High CPU due to runaway process',
      rootCauseHypothesis: 'Infinite loop in worker thread',
      severityReasoning: 'Critical impact on service',
      suggestedRunbooks: runbooks ?? [
        {
          id: 'rb-high-cpu',
          title: 'High CPU Usage Runbook',
          steps: [
            'Check process CPU usage: top -o %CPU',
            'Identify runaway processes',
            'Restart the affected service',
          ],
        },
      ],
      confidence: 0.85,
      provider: 'template',
      model: 'template',
    },
    completedAt: new Date(),
  };

  return infra.bus.publish<EnrichmentCompletedPayload>({
    type: 'enrichment.completed',
    source: 'enricher.aiSummary',
    timestamp: new Date(),
    payload,
  });
}

/** Emit an enrichment.completed without runbooks. */
function emitNonRunbookEnrichment(
  infra: ReturnType<typeof createTestInfra>,
): Promise<void> {
  return infra.bus.publish<EnrichmentCompletedPayload>({
    type: 'enrichment.completed',
    source: 'enricher.dedup',
    timestamp: new Date(),
    payload: {
      incidentId: 'INC-X',
      enricherModule: 'enricher.dedup',
      enrichmentType: 'dedup_occurrence',
      data: { occurrences: 3 },
      completedAt: new Date(),
    },
  });
}

// ── Lifecycle Tests ────────────────────────────────────────────────────────

describe('action.runbook — Lifecycle', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: RunbookEngine;

  beforeEach(async () => {
    infra = createTestInfra();
    engine = new RunbookEngine();
    await engine.initialize(makeContext(infra));
  });

  afterEach(async () => {
    await engine.stop().catch(() => {});
    await engine.destroy();
  });

  it('reports manifest correctly', () => {
    assert.equal(engine.manifest.id, 'action.runbook');
    assert.equal(engine.manifest.type, ModuleType.Action);
  });

  it('initializes with provided config', () => {
    const cfg = engine.getConfig();
    assert.equal(cfg.autoExecute, false);
    assert.equal(cfg.requireApprovalPerStep, false);
    assert.equal(cfg.maxConcurrentRunbooks, 10);
  });

  it('reports healthy status', () => {
    const h = engine.health();
    assert.equal(h.status, 'healthy');
    assert.ok(h.details);
    assert.equal(h.details!.activeRunbooks, 0);
  });

  it('starts and stops cleanly', async () => {
    await engine.start();
    await engine.stop();
  });
});

// ── Enrichment Filtering Tests ─────────────────────────────────────────────

describe('action.runbook — Enrichment Filtering', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: RunbookEngine;

  beforeEach(async () => {
    infra = createTestInfra();
    engine = new RunbookEngine();
    await engine.initialize(makeContext(infra, { autoExecute: true }));
    await engine.start();
  });

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('ignores non-ai-summary enrichments', async () => {
    await emitNonRunbookEnrichment(infra);
    await sleep(30);

    assert.equal(engine.getExecutions().size, 0);
    assert.equal(engine.getMetrics().totalStarted, 0);
  });

  it('ignores ai-summary enrichments without runbooks', async () => {
    await infra.bus.publish<EnrichmentCompletedPayload>({
      type: 'enrichment.completed',
      source: 'enricher.aiSummary',
      timestamp: new Date(),
      payload: {
        incidentId: 'INC-EMPTY',
        enricherModule: 'enricher.aiSummary',
        enrichmentType: 'ai-summary',
        data: {
          summary: 'No runbooks match',
          suggestedRunbooks: [],
        },
        completedAt: new Date(),
      },
    });
    await sleep(30);

    assert.equal(engine.getExecutions().size, 0);
  });

  it('processes ai-summary enrichments with runbooks', async () => {
    await emitRunbookEnrichment(infra);
    await sleep(30);

    // autoExecute=true, so it should have started
    assert.equal(engine.getMetrics().totalStarted, 1);
  });
});

// ── Auto-Execute Mode Tests ────────────────────────────────────────────────

describe('action.runbook — Auto-Execute', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: RunbookEngine;

  beforeEach(async () => {
    infra = createTestInfra();
    engine = new RunbookEngine();
    await engine.initialize(makeContext(infra, {
      autoExecute: true,
      requireApprovalPerStep: false,
    }));
    await engine.start();
  });

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('executes all steps automatically', async () => {
    const stepEvents: OpsPilotEvent<RunbookStepCompletedPayload>[] = [];
    infra.bus.subscribe<RunbookStepCompletedPayload>('runbook.stepCompleted', (e) => {
      stepEvents.push(e);
    });

    const completedEvents: OpsPilotEvent<RunbookCompletedPayload>[] = [];
    infra.bus.subscribe<RunbookCompletedPayload>('runbook.completed', (e) => {
      completedEvents.push(e);
    });

    await emitRunbookEnrichment(infra);
    await sleep(50);

    assert.equal(stepEvents.length, 3);
    assert.equal(completedEvents.length, 1);
    assert.equal(completedEvents[0].payload.status, 'completed');
    assert.equal(completedEvents[0].payload.totalSteps, 3);
    assert.equal(completedEvents[0].payload.completedSteps, 3);
    assert.equal(completedEvents[0].payload.failedSteps, 0);
  });

  it('emits runbook.started event', async () => {
    const startedEvents: OpsPilotEvent<RunbookStartedPayload>[] = [];
    infra.bus.subscribe<RunbookStartedPayload>('runbook.started', (e) => {
      startedEvents.push(e);
    });

    await emitRunbookEnrichment(infra);
    await sleep(50);

    assert.equal(startedEvents.length, 1);
    assert.equal(startedEvents[0].payload.runbookId, 'rb-high-cpu');
    assert.equal(startedEvents[0].payload.totalSteps, 3);
    assert.equal(startedEvents[0].payload.incidentId, 'INC-RB-001');
  });

  it('emits action.executed for each step', async () => {
    const actionEvents: OpsPilotEvent<ActionExecutedPayload>[] = [];
    infra.bus.subscribe<ActionExecutedPayload>('action.executed', (e) => {
      if (e.payload.actionType === 'runbook.step') {
        actionEvents.push(e);
      }
    });

    await emitRunbookEnrichment(infra);
    await sleep(50);

    assert.equal(actionEvents.length, 3);
    for (const ae of actionEvents) {
      assert.equal(ae.payload.result, 'success');
      assert.ok(ae.payload.output!.includes('[SIMULATED]'));
    }
  });

  it('moves completed runbooks to history', async () => {
    await emitRunbookEnrichment(infra);
    await sleep(50);

    assert.equal(engine.getExecutions().size, 0);
    assert.equal(engine.getHistory().length, 1);
    assert.equal(engine.getHistory()[0].status, 'completed');
  });

  it('tracks metrics correctly', async () => {
    await emitRunbookEnrichment(infra);
    await sleep(50);

    const metrics = engine.getMetrics();
    assert.equal(metrics.totalStarted, 1);
    assert.equal(metrics.totalCompleted, 1);
    assert.equal(metrics.totalFailed, 0);
    assert.equal(metrics.totalStepsExecuted, 3);
    assert.equal(metrics.activeRunbooks, 0);
    assert.equal(metrics.historySize, 1);
  });
});

// ── Approval-Gated Mode Tests ──────────────────────────────────────────────

describe('action.runbook — Approval-Gated', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: RunbookEngine;

  beforeEach(async () => {
    infra = createTestInfra();
    engine = new RunbookEngine();
    await engine.initialize(makeContext(infra, {
      autoExecute: false,
      requireApprovalPerStep: false,
    }));
    await engine.start();
  });

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('proposes runbook for approval', async () => {
    const proposals: ApprovalRequest[] = [];
    const origMethod = infra.approvalGate.requestApproval;
    infra.approvalGate.requestApproval = async (params: any) => {
      const req = await origMethod.call(infra.approvalGate, params);
      proposals.push(req);
      return req;
    };

    await emitRunbookEnrichment(infra);
    await sleep(30);

    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].actionType, 'runbook.execute');
    assert.ok(proposals[0].description.includes('High CPU Usage Runbook'));

    // Execution should be awaiting approval
    assert.equal(engine.getExecutions().size, 1);
    const exec = [...engine.getExecutions().values()][0];
    assert.equal(exec.status, 'awaiting_approval');
  });

  it('executes all steps after approval', async () => {
    const completedEvents: OpsPilotEvent<RunbookCompletedPayload>[] = [];
    infra.bus.subscribe<RunbookCompletedPayload>('runbook.completed', (e) => {
      completedEvents.push(e);
    });

    // Capture the approval request
    let capturedRequest: ApprovalRequest | null = null;
    const origMethod = infra.approvalGate.requestApproval;
    infra.approvalGate.requestApproval = async (params: any) => {
      const req = await origMethod.call(infra.approvalGate, params);
      capturedRequest = req;
      return req;
    };

    await emitRunbookEnrichment(infra);
    await sleep(30);

    assert.ok(capturedRequest);

    // Approve it
    const req = capturedRequest as ApprovalRequest;
    const token = await infra.approvalGate.approve(req.id, 'test-operator');
    await sleep(50);

    // Should have completed the runbook
    assert.equal(completedEvents.length, 1);
    assert.equal(completedEvents[0].payload.status, 'completed');
    assert.equal(completedEvents[0].payload.completedSteps, 3);
  });

  it('does not execute without approval', async () => {
    await emitRunbookEnrichment(infra);
    await sleep(50);

    // Should still be waiting
    assert.equal(engine.getExecutions().size, 1);
    const exec = [...engine.getExecutions().values()][0];
    assert.equal(exec.status, 'awaiting_approval');
    assert.equal(engine.getMetrics().totalStepsExecuted, 0);
  });
});

// ── Per-Step Approval Tests ────────────────────────────────────────────────

describe('action.runbook — Per-Step Approval', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: RunbookEngine;

  beforeEach(async () => {
    infra = createTestInfra();
    engine = new RunbookEngine();
    await engine.initialize(makeContext(infra, {
      autoExecute: false,
      requireApprovalPerStep: true,
    }));
    await engine.start();
  });

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('proposes runbook first, then each step', async () => {
    const proposals: ApprovalRequest[] = [];
    const origMethod = infra.approvalGate.requestApproval;
    infra.approvalGate.requestApproval = async (params: any) => {
      const req = await origMethod.call(infra.approvalGate, params);
      proposals.push(req);
      return req;
    };

    await emitRunbookEnrichment(infra);
    await sleep(30);

    // First proposal: the whole runbook
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].actionType, 'runbook.execute');

    // Approve the runbook
    const runbookToken = await infra.approvalGate.approve(proposals[0].id, 'operator');
    await sleep(50);

    // Now step 1 should be proposed
    assert.equal(proposals.length, 2);
    assert.equal(proposals[1].actionType, 'runbook.step');
    assert.ok(proposals[1].description.includes('Step 1'));

    // Approve step 1
    await infra.approvalGate.approve(proposals[1].id, 'operator');
    await sleep(50);

    // Step 2 should be proposed
    assert.equal(proposals.length, 3);
    assert.ok(proposals[2].description.includes('Step 2'));

    // Approve step 2
    await infra.approvalGate.approve(proposals[2].id, 'operator');
    await sleep(50);

    // Step 3 should be proposed
    assert.equal(proposals.length, 4);
    assert.ok(proposals[3].description.includes('Step 3'));

    // Approve step 3
    await infra.approvalGate.approve(proposals[3].id, 'operator');
    await sleep(50);

    // Should be completed
    assert.equal(engine.getHistory().length, 1);
    assert.equal(engine.getHistory()[0].status, 'completed');
    assert.equal(engine.getMetrics().totalStepsExecuted, 3);
  });
});

// ── Cooldown Tests ─────────────────────────────────────────────────────────

describe('action.runbook — Cooldown', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: RunbookEngine;

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('prevents duplicate runbook execution within cooldown', async () => {
    infra = createTestInfra();
    engine = new RunbookEngine();
    await engine.initialize(makeContext(infra, {
      autoExecute: true,
      cooldownMs: 5000,
    }));
    await engine.start();

    await emitRunbookEnrichment(infra, 'INC-COOL');
    await sleep(50);

    // First runbook should complete
    assert.equal(engine.getMetrics().totalCompleted, 1);

    // Same incident again — should be skipped due to cooldown
    await emitRunbookEnrichment(infra, 'INC-COOL');
    await sleep(50);

    assert.equal(engine.getMetrics().totalCompleted, 1); // Still 1
    assert.equal(engine.getMetrics().totalStarted, 1);
  });

  it('allows runbook after cooldown expires', async () => {
    infra = createTestInfra();
    engine = new RunbookEngine();
    await engine.initialize(makeContext(infra, {
      autoExecute: true,
      cooldownMs: 100,
    }));
    await engine.start();

    await emitRunbookEnrichment(infra, 'INC-COOL2');
    await sleep(50);
    assert.equal(engine.getMetrics().totalCompleted, 1);

    // Wait for cooldown to expire
    await sleep(150);

    await emitRunbookEnrichment(infra, 'INC-COOL2');
    await sleep(50);
    assert.equal(engine.getMetrics().totalCompleted, 2);
  });
});

// ── Capacity Tests ─────────────────────────────────────────────────────────

describe('action.runbook — Capacity', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: RunbookEngine;

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('limits concurrent runbook executions', async () => {
    infra = createTestInfra();
    engine = new RunbookEngine();
    await engine.initialize(makeContext(infra, {
      autoExecute: false,
      maxConcurrentRunbooks: 2,
      cooldownMs: 0,
    }));
    await engine.start();

    // Start 3 runbooks — only 2 should be tracked
    await emitRunbookEnrichment(infra, 'INC-CAP-1');
    await sleep(20);
    await emitRunbookEnrichment(infra, 'INC-CAP-2');
    await sleep(20);
    await emitRunbookEnrichment(infra, 'INC-CAP-3');
    await sleep(20);

    assert.equal(engine.getExecutions().size, 2);
  });

  it('trims history to maxRunbookHistory', async () => {
    infra = createTestInfra();
    engine = new RunbookEngine();
    await engine.initialize(makeContext(infra, {
      autoExecute: true,
      maxRunbookHistory: 3,
      cooldownMs: 0,
    }));
    await engine.start();

    for (let i = 0; i < 5; i++) {
      await emitRunbookEnrichment(infra, `INC-HIST-${i}`);
      await sleep(30);
    }

    assert.ok(engine.getHistory().length <= 3);
  });
});

// ── Health Tests ───────────────────────────────────────────────────────────

describe('action.runbook — Health', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: RunbookEngine;

  beforeEach(async () => {
    infra = createTestInfra();
    engine = new RunbookEngine();
    await engine.initialize(makeContext(infra, { autoExecute: true, cooldownMs: 0 }));
    await engine.start();
  });

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('health reflects execution metrics', async () => {
    await emitRunbookEnrichment(infra);
    await sleep(50);

    const h = engine.health();
    assert.equal(h.status, 'healthy');
    assert.ok(h.details);
    assert.equal(h.details!.totalStarted, 1);
    assert.equal(h.details!.totalCompleted, 1);
    assert.equal(h.details!.totalStepsExecuted, 3);
  });
});
