// ---------------------------------------------------------------------------
// OpsPilot — enricher.aiSummary
// ---------------------------------------------------------------------------
// AI-powered incident enrichment module. Subscribes to `incident.created`
// events and generates:
//   - Human-readable incident summaries
//   - Root cause hypotheses
//   - Severity classification reasoning
//   - Runbook suggestions (RAG-style keyword matching)
//
// AI is used ONLY for: summarisation, reasoning, classification, explanation.
// AI is NEVER used for: execution, action, mutation, or approval decisions.
//
// Provider abstraction supports:
//   - "template" — deterministic template-based (no external API, default)
//   - "openai"   — OpenAI API (requires OPENAI_API_KEY env var or config apiKey)
//   - "anthropic" — Anthropic API (requires ANTHROPIC_API_KEY env var or config apiKey)
//
// The template provider is always available and requires no configuration.
// External providers fall back to template on API failure.
// ---------------------------------------------------------------------------

import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { OpsPilotEvent, EventSubscription } from '../../core/types/events';
import {
  IncidentCreatedPayload,
  EnrichmentCompletedPayload,
} from '../../shared/events';
import configSchema from './schema.json';
import {
  ISummarizer,
  Runbook,
  createSummarizer,
  TemplateSummarizer,
} from './providers';

// ── Config Types ───────────────────────────────────────────────────────────

interface AISummaryConfig {
  provider: 'template' | 'openai' | 'anthropic';
  model: string;
  maxTokens: number;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  includeRunbook: boolean;
  runbooks: Runbook[];
}

// ── Module Implementation ──────────────────────────────────────────────────

export class AISummaryEnricher implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'enricher.aiSummary',
    name: 'AI Incident Summarizer',
    version: '0.1.0',
    type: ModuleType.Enricher,
    description: 'Generates AI-powered incident summaries, root cause analysis, and runbook suggestions.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: AISummaryConfig;
  private summarizer!: ISummarizer;
  private subscriptions: EventSubscription[] = [];

  // Metrics
  private summariesGenerated = 0;
  private runbookMatches = 0;
  private healthy = true;
  private lastError: string | undefined;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    const DEFAULTS: AISummaryConfig = {
      provider: 'template',
      model: 'template',
      maxTokens: 500,
      includeRunbook: true,
      runbooks: [],
    };

    this.config = {
      ...DEFAULTS,
      ...context.config,
    } as AISummaryConfig;

    // Initialize the appropriate summarizer using the provider factory.
    // If an external provider fails to construct (e.g. missing API key),
    // we fall back to the template provider and log a warning.
    try {
      this.summarizer = createSummarizer({
        provider: this.config.provider,
        model: this.config.model,
        maxTokens: this.config.maxTokens,
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
        timeoutMs: this.config.timeoutMs,
      });
    } catch (err) {
      this.ctx.logger.warn('AI provider initialization failed, falling back to template', {
        provider: this.config.provider,
        error: err instanceof Error ? err.message : String(err),
      });
      this.summarizer = new TemplateSummarizer();
    }

    this.ctx.logger.info('Initialized', {
      provider: this.config.provider,
      model: this.config.model,
      runbookCount: this.config.runbooks.length,
      includeRunbook: this.config.includeRunbook,
    });
  }

  async start(): Promise<void> {
    this.subscriptions.push(
      this.ctx.bus.subscribe<IncidentCreatedPayload>(
        'incident.created',
        (event) => this.onIncidentCreated(event),
      ),
    );

    this.ctx.logger.info('Started — listening for incident.created events');
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    this.ctx.logger.info('Stopped', {
      summariesGenerated: this.summariesGenerated,
      runbookMatches: this.runbookMatches,
    });
  }

  async destroy(): Promise<void> {
    this.subscriptions = [];
    this.ctx = undefined!;
    this.config = undefined!;
    this.summarizer = undefined!;
  }

  health(): ModuleHealth {
    return {
      status: this.healthy ? 'healthy' : 'degraded',
      message: this.lastError,
      details: {
        provider: this.config?.provider,
        summariesGenerated: this.summariesGenerated,
        runbookMatches: this.runbookMatches,
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Handler ────────────────────────────────────────────────────────

  private async onIncidentCreated(
    event: OpsPilotEvent<IncidentCreatedPayload>,
  ): Promise<void> {
    const incident = event.payload;

    try {
      const result = await this.summarizer.summarize(
        incident,
        this.config.includeRunbook ? this.config.runbooks : [],
      );

      this.summariesGenerated++;

      if (result.suggestedRunbooks.length > 0) {
        this.runbookMatches += result.suggestedRunbooks.length;
      }

      // Emit enrichment.completed with the summary data
      const enrichmentPayload: EnrichmentCompletedPayload = {
        incidentId: incident.incidentId,
        enricherModule: this.manifest.id,
        enrichmentType: 'ai-summary',
        data: {
          summary: result.summary,
          rootCauseHypothesis: result.rootCauseHypothesis,
          severityReasoning: result.severityReasoning,
          suggestedRunbooks: result.suggestedRunbooks.map((rb) => ({
            id: rb.id,
            title: rb.title,
            steps: rb.steps,
          })),
          confidence: result.confidence,
          provider: this.config.provider,
          model: this.config.model,
        },
        completedAt: new Date(),
      };

      await this.ctx.bus.publish<EnrichmentCompletedPayload>({
        type: 'enrichment.completed',
        source: this.manifest.id,
        timestamp: new Date(),
        correlationId: event.correlationId,
        payload: enrichmentPayload,
      });

      this.ctx.logger.info('Summary generated for incident', {
        incidentId: incident.incidentId,
        confidence: result.confidence,
        runbooksMatched: result.suggestedRunbooks.length,
        provider: this.config.provider,
      });
    } catch (err) {
      this.healthy = false;
      this.lastError = err instanceof Error ? err.message : String(err);

      this.ctx.logger.error(
        'Failed to generate summary',
        err instanceof Error ? err : new Error(String(err)),
        { incidentId: incident.incidentId },
      );
    }
  }
}
