// ---------------------------------------------------------------------------
// OpsPilot — Integration Pipeline Test
// ---------------------------------------------------------------------------
// End-to-end test: log.ingested → detector.regex → incident.created →
// enricher.aiSummary → enrichment.completed → enricher.incidentStore →
// action.safe → approval → action.executed
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RegexDetector } from '../src/modules/detector.regex/index';
import { IncidentStore } from '../src/modules/enricher.incidentStore/index';
import { AISummaryEnricher } from '../src/modules/enricher.aiSummary/index';
import { SafeActionModule } from '../src/modules/action.safe/index';
import { ModuleContext } from '../src/core/types/module';
import { OpsPilotEvent } from '../src/core/types/events';
import {
  LogIngestedPayload,
  IncidentCreatedPayload,
  EnrichmentCompletedPayload,
  ActionExecutedPayload,
} from '../src/shared/events';
import { ApprovalRequest, ApprovalToken } from '../src/core/types/security';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { createTestInfra, sleep } from './helpers';

// ── Build per-module contexts ──────────────────────────────────────────────

function buildDetectorContext(
  infra: ReturnType<typeof createTestInfra>,
): ModuleContext {
  return {
    moduleId: 'detector.regex',
    config: {
      maxIncidentsPerMinute: 30,
      rules: [
        {
          id: 'error-detect',
          pattern: 'ERROR',
          flags: 'i',
          severity: 'critical',
          title: 'Error Detected',
          description: 'Matched: $0',
          cooldownMs: 0,
          enabled: true,
        },
      ],
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'detector.regex'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function buildStoreContext(
  infra: ReturnType<typeof createTestInfra>,
): ModuleContext {
  return {
    moduleId: 'enricher.incidentStore',
    config: { maxIncidents: 100, retentionMs: 86400000 },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'enricher.incidentStore'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function buildAISummaryContext(
  infra: ReturnType<typeof createTestInfra>,
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
          title: 'Handle Application Errors',
          keywords: ['error', 'exception'],
          steps: ['Check logs', 'Restart service'],
        },
      ],
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'enricher.aiSummary'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function buildActionContext(
  infra: ReturnType<typeof createTestInfra>,
): ModuleContext {
  return {
    moduleId: 'action.safe',
    config: {
      autoPropose: true,
      proposalDelaySec: 0,
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
      ],
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'action.safe'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

// ── Integration Tests ──────────────────────────────────────────────────────

describe('Integration: Full Pipeline', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let detector: RegexDetector;
  let store: IncidentStore;
  let aiSummary: AISummaryEnricher;
  let actionSafe: SafeActionModule;

  beforeEach(async () => {
    infra = createTestInfra();
    detector = new RegexDetector();
    store = new IncidentStore();
    aiSummary = new AISummaryEnricher();
    actionSafe = new SafeActionModule();
  });

  it('should flow from log ingestion to incident storage with enrichment', async () => {
    // Initialize all modules
    await detector.initialize(buildDetectorContext(infra));
    await store.initialize(buildStoreContext(infra));
    await aiSummary.initialize(buildAISummaryContext(infra));

    // Start all modules
    await detector.start();
    await store.start();
    await aiSummary.start();

    // Track events
    const incidents: OpsPilotEvent<IncidentCreatedPayload>[] = [];
    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];

    infra.bus.subscribe<IncidentCreatedPayload>('incident.created', (e) => {
      incidents.push(e);
    });
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      enrichments.push(e);
    });

    // Emit a log line that triggers an incident
    await infra.bus.publish<LogIngestedPayload>({
      type: 'log.ingested',
      source: 'connector.test',
      timestamp: new Date(),
      payload: {
        source: '/var/log/app.log',
        line: '2024-01-01 12:00:00 ERROR: Connection refused to database',
        lineNumber: 42,
        ingestedAt: new Date(),
      },
    });

    // Wait for the async pipeline to process
    await sleep(100);

    // 1. Detector should have created an incident
    assert.strictEqual(incidents.length, 1);
    assert.strictEqual(incidents[0].payload.severity, 'critical');
    assert.strictEqual(incidents[0].payload.title, 'Error Detected');

    const incidentId = incidents[0].payload.incidentId;

    // 2. AI summarizer should have generated enrichment
    assert.strictEqual(enrichments.length, 1);
    assert.strictEqual(enrichments[0].payload.incidentId, incidentId);
    assert.strictEqual(enrichments[0].payload.enrichmentType, 'ai-summary');

    // 3. Wait for enrichment to be processed by the store
    await sleep(50);

    // 4. Incident store should have the incident with enrichment
    const storedIncident = await store.getIncident(incidentId);
    assert.ok(storedIncident, 'Incident should be stored');
    assert.strictEqual(storedIncident.status, 'open');
    assert.ok(storedIncident.enrichments['enricher.aiSummary'], 'AI summary should be attached');

    const summary = storedIncident.enrichments['enricher.aiSummary'] as any;
    assert.ok(summary.summary);
    assert.ok(summary.rootCauseHypothesis);
    assert.ok(summary.suggestedRunbooks?.length >= 1);

    // Cleanup
    await aiSummary.stop();
    await store.stop();
    await detector.stop();
    await aiSummary.destroy();
    await store.destroy();
    await detector.destroy();
  });

  it('should complete full pipeline: log → detect → enrich → propose → approve → execute', async () => {
    // Initialize all modules
    await detector.initialize(buildDetectorContext(infra));
    await store.initialize(buildStoreContext(infra));
    await aiSummary.initialize(buildAISummaryContext(infra));
    await actionSafe.initialize(buildActionContext(infra));

    // Start all modules
    await detector.start();
    await store.start();
    await aiSummary.start();
    await actionSafe.start();

    // Track approval requests and executions
    let capturedRequest: ApprovalRequest | null = null;
    const origMethod = infra.approvalGate.requestApproval;
    infra.approvalGate.requestApproval = async (params: any) => {
      const req = await origMethod.call(infra.approvalGate, params);
      capturedRequest = req;
      return req;
    };

    const executions: OpsPilotEvent<ActionExecutedPayload>[] = [];
    infra.bus.subscribe<ActionExecutedPayload>('action.executed', (e) => {
      executions.push(e);
    });

    // ── Step 1: Emit a log line ────────────────────────────────────────
    await infra.bus.publish<LogIngestedPayload>({
      type: 'log.ingested',
      source: 'connector.test',
      timestamp: new Date(),
      payload: {
        source: '/var/log/app.log',
        line: '2024-01-01 ERROR: Fatal crash in worker',
        lineNumber: 1,
        ingestedAt: new Date(),
      },
    });

    // Wait for: detect → enrich → propose
    await sleep(200);

    // ── Step 2: Verify proposal was created ────────────────────────────
    assert.ok(capturedRequest, 'Expected an approval request to be created');
    const request = capturedRequest as ApprovalRequest;

    // ── Step 3: Simulate human approval ────────────────────────────────
    const token = await infra.approvalGate.approve(request.id, 'oncall-admin');

    // Emit action.approved event
    await infra.bus.publish({
      type: 'action.approved',
      source: 'core.approvalGate',
      timestamp: new Date(),
      payload: {
        request: capturedRequest,
        token,
      },
    });

    await sleep(100);

    // ── Step 4: Verify action was executed ──────────────────────────────
    assert.strictEqual(executions.length, 1);
    assert.strictEqual(executions[0].payload.result, 'success');
    assert.ok(executions[0].payload.output?.includes('SIMULATED'));
    assert.ok(executions[0].payload.output?.includes('systemctl restart app'));

    // ── Step 5: Verify incident is fully enriched in store ─────────────
    const incidents = await store.listIncidents();
    assert.ok(incidents.length >= 1);

    const incident = incidents[0];
    assert.strictEqual(incident.status, 'open');
    assert.ok(incident.enrichments['enricher.aiSummary'], 'Should have AI summary enrichment');

    // Cleanup
    await actionSafe.stop();
    await aiSummary.stop();
    await store.stop();
    await detector.stop();
    await actionSafe.destroy();
    await aiSummary.destroy();
    await store.destroy();
    await detector.destroy();
  });

  it('should handle multiple concurrent log lines', async () => {
    // Use different cooldownMs and patterns to avoid cooldown masking
    const detectorCtx: ModuleContext = {
      moduleId: 'detector.regex',
      config: {
        maxIncidentsPerMinute: 100,
        rules: [
          {
            id: 'error-detect',
            pattern: 'ERROR',
            flags: 'i',
            severity: 'critical',
            title: 'Error Detected',
            description: 'Matched: $0',
            cooldownMs: 0,
            enabled: true,
          },
        ],
      },
      bus: infra.bus,
      storage: new NamespacedStorage(infra.storage, 'detector.regex'),
      logger: infra.logger,
      approvalGate: infra.approvalGate,
    };

    await detector.initialize(detectorCtx);
    await store.initialize(buildStoreContext(infra));
    await detector.start();
    await store.start();

    // Emit several log lines
    const lines = [
      'ERROR: OOM killed process',
      'INFO: Health check passed',
      'ERROR: Connection reset',
      'DEBUG: Cache miss',
      'ERROR: Timeout waiting for response',
    ];

    for (const line of lines) {
      await infra.bus.publish<LogIngestedPayload>({
        type: 'log.ingested',
        source: 'connector.test',
        timestamp: new Date(),
        payload: {
          source: '/var/log/app.log',
          line,
          lineNumber: 1,
          ingestedAt: new Date(),
        },
      });
    }

    await sleep(100);

    // Only 3 lines contain ERROR
    const incidents = await store.listIncidents();
    assert.strictEqual(incidents.length, 3);

    // Cleanup
    await store.stop();
    await detector.stop();
    await store.destroy();
    await detector.destroy();
  });

  it('should isolate module failures without crashing the pipeline', async () => {
    await detector.initialize(buildDetectorContext(infra));
    await store.initialize(buildStoreContext(infra));
    await detector.start();
    await store.start();

    // Add a subscriber that throws — should not kill the pipeline
    infra.bus.subscribe('incident.created', () => {
      throw new Error('Boom! Subscriber crash');
    });

    // This should still work despite the crashing subscriber
    await infra.bus.publish<LogIngestedPayload>({
      type: 'log.ingested',
      source: 'connector.test',
      timestamp: new Date(),
      payload: {
        source: '/var/log/app.log',
        line: 'ERROR: something bad',
        lineNumber: 1,
        ingestedAt: new Date(),
      },
    });

    await sleep(100);

    // Incident store should still have received the incident
    const incidents = await store.listIncidents();
    assert.ok(incidents.length >= 1, 'Pipeline should continue despite subscriber errors');

    // Cleanup
    await store.stop();
    await detector.stop();
    await store.destroy();
    await detector.destroy();
  });
});
