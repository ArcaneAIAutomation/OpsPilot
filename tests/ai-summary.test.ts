// ---------------------------------------------------------------------------
// OpsPilot — enricher.aiSummary Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AISummaryEnricher } from '../src/modules/enricher.aiSummary/index';
import { ModuleContext } from '../src/core/types/module';
import { OpsPilotEvent } from '../src/core/types/events';
import {
  IncidentCreatedPayload,
  EnrichmentCompletedPayload,
} from '../src/shared/events';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { createTestInfra, sleep } from './helpers';

// ── Helper: build context ──────────────────────────────────────────────────

function buildContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'enricher.aiSummary',
    config: {
      provider: 'template',
      model: 'template',
      maxTokens: 500,
      includeRunbook: true,
      runbooks: [
        {
          id: 'rb-001',
          title: 'Handle High Memory Usage',
          keywords: ['memory', 'oom', 'heap'],
          steps: ['Check memory usage', 'Restart service if needed'],
        },
        {
          id: 'rb-002',
          title: 'Handle Disk Full',
          keywords: ['disk', 'storage', 'full'],
          steps: ['Clear temp files', 'Archive old logs'],
        },
      ],
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'enricher.aiSummary'),
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
    title: opts?.title ?? 'Test Incident',
    description: opts?.description ?? 'A test incident description',
    severity: opts?.severity ?? 'warning',
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

describe('enricher.aiSummary', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let enricher: AISummaryEnricher;

  beforeEach(() => {
    infra = createTestInfra();
    enricher = new AISummaryEnricher();
  });

  // ── Initialization ───────────────────────────────────────────────────

  it('should initialize with template provider', async () => {
    const ctx = buildContext(infra);
    await enricher.initialize(ctx);

    const health = enricher.health();
    assert.strictEqual(health.status, 'healthy');
    assert.strictEqual((health.details as any).provider, 'template');
    assert.strictEqual((health.details as any).summariesGenerated, 0);
  });

  it('should initialize with external provider (fallback mode)', async () => {
    const ctx = buildContext(infra, { provider: 'openai', model: 'gpt-4' });
    await enricher.initialize(ctx);

    const health = enricher.health();
    assert.strictEqual(health.status, 'healthy');
  });

  // ── Summary Generation ───────────────────────────────────────────────

  it('should generate summary and emit enrichment.completed', async () => {
    const ctx = buildContext(infra);
    await enricher.initialize(ctx);
    await enricher.start();

    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      enrichments.push(e);
    });

    await emitIncident(infra, 'inc-1', {
      severity: 'critical',
      title: 'Error Detected',
      description: 'Application error in production',
    });
    await sleep(50);

    assert.strictEqual(enrichments.length, 1);
    assert.strictEqual(enrichments[0].payload.incidentId, 'inc-1');
    assert.strictEqual(enrichments[0].payload.enricherModule, 'enricher.aiSummary');
    assert.strictEqual(enrichments[0].payload.enrichmentType, 'ai-summary');

    const data = enrichments[0].payload.data;
    assert.ok(data.summary);
    assert.ok(data.rootCauseHypothesis);
    assert.ok(data.severityReasoning);
    assert.ok(typeof data.confidence === 'number');

    await enricher.stop();
    await enricher.destroy();
  });

  // ── Root Cause Inference ─────────────────────────────────────────────

  it('should infer error-related root cause', async () => {
    const ctx = buildContext(infra);
    await enricher.initialize(ctx);
    await enricher.start();

    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      enrichments.push(e);
    });

    await emitIncident(infra, 'inc-1', {
      title: 'Application Error',
      description: 'NullPointerException in handler',
    });
    await sleep(50);

    const rootCause = enrichments[0].payload.data.rootCauseHypothesis as string;
    assert.ok(rootCause.toLowerCase().includes('error'));

    await enricher.stop();
    await enricher.destroy();
  });

  it('should infer memory-related root cause', async () => {
    const ctx = buildContext(infra);
    await enricher.initialize(ctx);
    await enricher.start();

    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      enrichments.push(e);
    });

    await emitIncident(infra, 'inc-1', {
      title: 'High Memory Usage',
      description: 'Memory consumption exceeds 95%',
    });
    await sleep(50);

    const rootCause = enrichments[0].payload.data.rootCauseHypothesis as string;
    assert.ok(rootCause.toLowerCase().includes('memory'));

    await enricher.stop();
    await enricher.destroy();
  });

  // ── Severity Reasoning ───────────────────────────────────────────────

  it('should provide severity reasoning for critical', async () => {
    const ctx = buildContext(infra);
    await enricher.initialize(ctx);
    await enricher.start();

    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      enrichments.push(e);
    });

    await emitIncident(infra, 'inc-1', { severity: 'critical' });
    await sleep(50);

    const reasoning = enrichments[0].payload.data.severityReasoning as string;
    assert.ok(reasoning.includes('CRITICAL'));

    await enricher.stop();
    await enricher.destroy();
  });

  it('should provide severity reasoning for warning', async () => {
    const ctx = buildContext(infra);
    await enricher.initialize(ctx);
    await enricher.start();

    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      enrichments.push(e);
    });

    await emitIncident(infra, 'inc-1', { severity: 'warning' });
    await sleep(50);

    const reasoning = enrichments[0].payload.data.severityReasoning as string;
    assert.ok(reasoning.includes('WARNING'));

    await enricher.stop();
    await enricher.destroy();
  });

  // ── Runbook Matching ─────────────────────────────────────────────────

  it('should match runbooks by keyword overlap', async () => {
    const ctx = buildContext(infra);
    await enricher.initialize(ctx);
    await enricher.start();

    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      enrichments.push(e);
    });

    await emitIncident(infra, 'inc-1', {
      title: 'High Memory Usage',
      description: 'OOM killer invoked',
    });
    await sleep(50);

    const data = enrichments[0].payload.data;
    const runbooks = data.suggestedRunbooks as Array<{ id: string; title: string }>;
    assert.ok(runbooks.length >= 1);
    assert.ok(runbooks.some((rb) => rb.id === 'rb-001'));

    // Higher confidence since runbook matched
    assert.ok((data.confidence as number) >= 0.7);

    await enricher.stop();
    await enricher.destroy();
  });

  it('should not match runbooks when keywords do not overlap', async () => {
    const ctx = buildContext(infra);
    await enricher.initialize(ctx);
    await enricher.start();

    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      enrichments.push(e);
    });

    await emitIncident(infra, 'inc-1', {
      title: 'Network Latency Spike',
      description: 'API response times over 5 seconds',
    });
    await sleep(50);

    const data = enrichments[0].payload.data;
    const runbooks = data.suggestedRunbooks as Array<{ id: string }>;
    assert.strictEqual(runbooks.length, 0);

    // Lower confidence when no runbook matched
    assert.ok((data.confidence as number) < 0.7);

    await enricher.stop();
    await enricher.destroy();
  });

  it('should skip runbooks when includeRunbook is false', async () => {
    const ctx = buildContext(infra, { includeRunbook: false });
    await enricher.initialize(ctx);
    await enricher.start();

    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      enrichments.push(e);
    });

    await emitIncident(infra, 'inc-1', {
      title: 'High Memory Usage',
      description: 'OOM detected',
    });
    await sleep(50);

    const data = enrichments[0].payload.data;
    const runbooks = data.suggestedRunbooks as Array<{ id: string }>;
    assert.strictEqual(runbooks.length, 0);

    await enricher.stop();
    await enricher.destroy();
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  it('should not process events after stop', async () => {
    const ctx = buildContext(infra);
    await enricher.initialize(ctx);
    await enricher.start();

    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      enrichments.push(e);
    });

    await enricher.stop();

    await emitIncident(infra, 'inc-1');
    await sleep(50);

    assert.strictEqual(enrichments.length, 0);

    await enricher.destroy();
  });

  // ── Metrics ──────────────────────────────────────────────────────────

  it('should track metrics correctly', async () => {
    const ctx = buildContext(infra);
    await enricher.initialize(ctx);
    await enricher.start();

    await emitIncident(infra, 'inc-1', { title: 'Error', description: 'error occurred' });
    await emitIncident(infra, 'inc-2', { title: 'Memory issue', description: 'heap overflow' });
    await sleep(50);

    const health = enricher.health();
    assert.strictEqual((health.details as any).summariesGenerated, 2);

    await enricher.stop();
    await enricher.destroy();
  });
});
