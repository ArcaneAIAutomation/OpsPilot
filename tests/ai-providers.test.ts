// ---------------------------------------------------------------------------
// OpsPilot — AI Provider Unit Tests
// ---------------------------------------------------------------------------

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TemplateSummarizer,
  OpenAISummarizer,
  AnthropicSummarizer,
  createSummarizer,
  buildPrompt,
  parseAIResponse,
} from '../src/modules/enricher.aiSummary/providers';
import {
  IncidentCreatedPayload,
} from '../src/shared/events';

// ── Helper ─────────────────────────────────────────────────────────────────

function makeIncident(overrides?: Partial<IncidentCreatedPayload>): IncidentCreatedPayload {
  return {
    incidentId: 'inc-test-1',
    title: overrides?.title ?? 'Test Incident',
    description: overrides?.description ?? 'A test incident',
    severity: overrides?.severity ?? 'warning',
    detectedBy: overrides?.detectedBy ?? 'detector.regex',
    detectedAt: overrides?.detectedAt ?? new Date('2025-01-01T00:00:00Z'),
    context: overrides?.context,
  };
}

const testRunbooks = [
  {
    id: 'rb-001',
    title: 'High Memory Runbook',
    keywords: ['memory', 'oom', 'heap'],
    steps: ['Check memory', 'Restart service'],
  },
  {
    id: 'rb-002',
    title: 'Disk Full Runbook',
    keywords: ['disk', 'storage', 'full'],
    steps: ['Clear temp', 'Archive logs'],
  },
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AI Providers', () => {
  // ── TemplateSummarizer ─────────────────────────────────────────────────

  describe('TemplateSummarizer', () => {
    it('should generate a summary with incident details', async () => {
      const summarizer = new TemplateSummarizer();
      const result = await summarizer.summarize(
        makeIncident({ title: 'Error Detected', description: 'App error in prod' }),
        [],
      );

      assert.ok(result.summary.includes('Error Detected'));
      assert.ok(result.summary.includes('App error in prod'));
      assert.ok(result.rootCauseHypothesis.length > 0);
      assert.ok(result.severityReasoning.length > 0);
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
    });

    it('should match runbooks by keyword overlap', async () => {
      const summarizer = new TemplateSummarizer();
      const result = await summarizer.summarize(
        makeIncident({ title: 'High memory usage', description: 'OOM detected' }),
        testRunbooks,
      );

      assert.ok(result.suggestedRunbooks.length >= 1);
      assert.ok(result.suggestedRunbooks.some((rb) => rb.id === 'rb-001'));
      assert.strictEqual(result.confidence, 0.7);
    });

    it('should return low confidence when no runbooks match', async () => {
      const summarizer = new TemplateSummarizer();
      const result = await summarizer.summarize(
        makeIncident({ title: 'Network timeout', description: 'API latency' }),
        testRunbooks,
      );

      assert.strictEqual(result.suggestedRunbooks.length, 0);
      assert.strictEqual(result.confidence, 0.4);
    });

    it('should infer root cause for different incident types', async () => {
      const summarizer = new TemplateSummarizer();

      const errorResult = await summarizer.summarize(
        makeIncident({ title: 'Error', description: 'Application error' }),
        [],
      );
      assert.ok(errorResult.rootCauseHypothesis.toLowerCase().includes('error'));

      const memoryResult = await summarizer.summarize(
        makeIncident({ title: 'Memory', description: 'High memory' }),
        [],
      );
      assert.ok(memoryResult.rootCauseHypothesis.toLowerCase().includes('memory'));

      const cpuResult = await summarizer.summarize(
        makeIncident({ title: 'CPU spike', description: 'High CPU' }),
        [],
      );
      assert.ok(cpuResult.rootCauseHypothesis.toLowerCase().includes('cpu'));

      const diskResult = await summarizer.summarize(
        makeIncident({ title: 'Disk full', description: 'No space' }),
        [],
      );
      assert.ok(diskResult.rootCauseHypothesis.toLowerCase().includes('disk'));

      const timeoutResult = await summarizer.summarize(
        makeIncident({ title: 'Timeout', description: 'Request timeout' }),
        [],
      );
      assert.ok(timeoutResult.rootCauseHypothesis.toLowerCase().includes('timeout'));

      const connectionResult = await summarizer.summarize(
        makeIncident({ title: 'Connection refused', description: 'Cannot connect' }),
        [],
      );
      assert.ok(connectionResult.rootCauseHypothesis.toLowerCase().includes('connection'));
    });

    it('should explain severity levels correctly', async () => {
      const summarizer = new TemplateSummarizer();

      const critical = await summarizer.summarize(
        makeIncident({ severity: 'critical' }),
        [],
      );
      assert.ok(critical.severityReasoning.includes('CRITICAL'));

      const warning = await summarizer.summarize(
        makeIncident({ severity: 'warning' }),
        [],
      );
      assert.ok(warning.severityReasoning.includes('WARNING'));

      const info = await summarizer.summarize(
        makeIncident({ severity: 'info' }),
        [],
      );
      assert.ok(info.severityReasoning.includes('INFO'));
    });

    it('should include context fields in summary', async () => {
      const summarizer = new TemplateSummarizer();
      const result = await summarizer.summarize(
        makeIncident({
          context: {
            logSource: '/var/log/app.log',
            matchedLine: 'ERROR: something failed',
          },
        }),
        [],
      );

      assert.ok(result.summary.includes('/var/log/app.log'));
      assert.ok(result.summary.includes('ERROR: something failed'));
    });
  });

  // ── buildPrompt ────────────────────────────────────────────────────────

  describe('buildPrompt', () => {
    it('should include incident details in prompt', () => {
      const incident = makeIncident({
        title: 'Test Alert',
        description: 'Something happened',
        severity: 'critical',
      });

      const prompt = buildPrompt(incident, []);

      assert.ok(prompt.includes('Test Alert'));
      assert.ok(prompt.includes('Something happened'));
      assert.ok(prompt.includes('critical'));
      assert.ok(prompt.includes('detector.regex'));
    });

    it('should include runbook information when provided', () => {
      const prompt = buildPrompt(makeIncident(), testRunbooks);

      assert.ok(prompt.includes('High Memory Runbook'));
      assert.ok(prompt.includes('Disk Full Runbook'));
      assert.ok(prompt.includes('memory'));
    });

    it('should include context when present', () => {
      const prompt = buildPrompt(
        makeIncident({ context: { host: 'server-01', region: 'us-east' } }),
        [],
      );

      assert.ok(prompt.includes('server-01'));
      assert.ok(prompt.includes('us-east'));
    });

    it('should request JSON response format', () => {
      const prompt = buildPrompt(makeIncident(), []);

      assert.ok(prompt.includes('JSON'));
      assert.ok(prompt.includes('summary'));
      assert.ok(prompt.includes('rootCauseHypothesis'));
      assert.ok(prompt.includes('confidence'));
    });
  });

  // ── parseAIResponse ────────────────────────────────────────────────────

  describe('parseAIResponse', () => {
    it('should parse valid JSON response', () => {
      const json = JSON.stringify({
        summary: 'Test summary',
        rootCauseHypothesis: 'Root cause',
        severityReasoning: 'Severity reasoning',
        matchedRunbookIds: ['rb-001'],
        confidence: 0.85,
      });

      const result = parseAIResponse(json, testRunbooks);

      assert.strictEqual(result.summary, 'Test summary');
      assert.strictEqual(result.rootCauseHypothesis, 'Root cause');
      assert.strictEqual(result.severityReasoning, 'Severity reasoning');
      assert.strictEqual(result.suggestedRunbooks.length, 1);
      assert.strictEqual(result.suggestedRunbooks[0].id, 'rb-001');
      assert.strictEqual(result.confidence, 0.85);
    });

    it('should handle markdown code fences', () => {
      const json = '```json\n{"summary":"Test","rootCauseHypothesis":"RC","severityReasoning":"SR","matchedRunbookIds":[],"confidence":0.5}\n```';

      const result = parseAIResponse(json, []);

      assert.strictEqual(result.summary, 'Test');
      assert.strictEqual(result.confidence, 0.5);
    });

    it('should clamp confidence to 0-1 range', () => {
      const highJson = JSON.stringify({
        summary: 'S', rootCauseHypothesis: 'R',
        severityReasoning: 'SR', matchedRunbookIds: [],
        confidence: 1.5,
      });
      assert.strictEqual(parseAIResponse(highJson, []).confidence, 1);

      const lowJson = JSON.stringify({
        summary: 'S', rootCauseHypothesis: 'R',
        severityReasoning: 'SR', matchedRunbookIds: [],
        confidence: -0.5,
      });
      assert.strictEqual(parseAIResponse(lowJson, []).confidence, 0);
    });

    it('should provide defaults for missing fields', () => {
      const json = JSON.stringify({ matchedRunbookIds: [] });

      const result = parseAIResponse(json, []);

      assert.strictEqual(result.summary, 'No summary generated');
      assert.strictEqual(result.rootCauseHypothesis, 'Unable to determine root cause');
      assert.strictEqual(result.confidence, 0.5); // default when not a number
    });

    it('should throw on invalid JSON', () => {
      assert.throws(
        () => parseAIResponse('not valid json', []),
        (err: Error) => err instanceof SyntaxError,
      );
    });

    it('should map runbook IDs to full runbook objects', () => {
      const json = JSON.stringify({
        summary: 'S', rootCauseHypothesis: 'R',
        severityReasoning: 'SR',
        matchedRunbookIds: ['rb-001', 'rb-002'],
        confidence: 0.9,
      });

      const result = parseAIResponse(json, testRunbooks);

      assert.strictEqual(result.suggestedRunbooks.length, 2);
      assert.deepStrictEqual(
        result.suggestedRunbooks.map((r) => r.id).sort(),
        ['rb-001', 'rb-002'],
      );
    });
  });

  // ── createSummarizer factory ───────────────────────────────────────────

  describe('createSummarizer', () => {
    it('should create TemplateSummarizer for template provider', () => {
      const summarizer = createSummarizer({
        provider: 'template',
        model: 'template',
        maxTokens: 500,
      });
      assert.ok(summarizer instanceof TemplateSummarizer);
    });

    it('should create OpenAISummarizer when API key is provided', () => {
      const summarizer = createSummarizer({
        provider: 'openai',
        model: 'gpt-4o-mini',
        maxTokens: 500,
        apiKey: 'sk-test-key',
      });
      assert.ok(summarizer instanceof OpenAISummarizer);
    });

    it('should create AnthropicSummarizer when API key is provided', () => {
      const summarizer = createSummarizer({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        maxTokens: 500,
        apiKey: 'sk-ant-test-key',
      });
      assert.ok(summarizer instanceof AnthropicSummarizer);
    });

    it('should throw when OpenAI key is missing', () => {
      // Clear env var for deterministic test
      const orig = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      assert.throws(
        () => createSummarizer({ provider: 'openai', model: 'gpt-4o-mini', maxTokens: 500 }),
        (err: Error) => err.message.includes('OpenAI API key'),
      );

      // Restore
      if (orig) process.env.OPENAI_API_KEY = orig;
    });

    it('should throw when Anthropic key is missing', () => {
      const orig = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      assert.throws(
        () => createSummarizer({ provider: 'anthropic', model: 'claude-sonnet-4-20250514', maxTokens: 500 }),
        (err: Error) => err.message.includes('Anthropic API key'),
      );

      if (orig) process.env.ANTHROPIC_API_KEY = orig;
    });

    it('should default to TemplateSummarizer for unknown provider', () => {
      const summarizer = createSummarizer({
        provider: 'template',
        model: 'anything',
        maxTokens: 100,
      });
      assert.ok(summarizer instanceof TemplateSummarizer);
    });
  });

  // ── OpenAI provider configuration ──────────────────────────────────────

  describe('OpenAISummarizer', () => {
    it('should accept custom base URL', () => {
      const summarizer = new OpenAISummarizer({
        provider: 'openai',
        model: 'gpt-4o-mini',
        maxTokens: 500,
        apiKey: 'sk-test',
        baseUrl: 'https://custom-proxy.example.com',
      });
      assert.ok(summarizer);
    });

    it('should use custom timeout', () => {
      const summarizer = new OpenAISummarizer({
        provider: 'openai',
        model: 'gpt-4o-mini',
        maxTokens: 500,
        apiKey: 'sk-test',
        timeoutMs: 5000,
      });
      assert.ok(summarizer);
    });
  });

  // ── Anthropic provider configuration ───────────────────────────────────

  describe('AnthropicSummarizer', () => {
    it('should accept custom base URL', () => {
      const summarizer = new AnthropicSummarizer({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        maxTokens: 500,
        apiKey: 'sk-ant-test',
        baseUrl: 'https://custom-proxy.example.com',
      });
      assert.ok(summarizer);
    });

    it('should use custom timeout', () => {
      const summarizer = new AnthropicSummarizer({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        maxTokens: 500,
        apiKey: 'sk-ant-test',
        timeoutMs: 10000,
      });
      assert.ok(summarizer);
    });
  });

  // ── Integration: AISummaryEnricher with provider fallback ──────────────

  describe('AISummaryEnricher provider fallback', () => {
    // Import the enricher to test fallback behavior
    const { AISummaryEnricher } = require('../src/modules/enricher.aiSummary/index');
    const { createTestInfra } = require('./helpers');
    const { NamespacedStorage } = require('../src/core/storage/NamespacedStorage');

    it('should fall back to template when external provider fails to initialize', async () => {
      const infra = createTestInfra();
      const enricher = new AISummaryEnricher();

      // Attempt openai without API key — should fall back gracefully
      const origKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const ctx = {
        moduleId: 'enricher.aiSummary',
        config: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          maxTokens: 500,
          includeRunbook: false,
          runbooks: [],
        },
        bus: infra.bus,
        storage: new NamespacedStorage(infra.storage, 'enricher.aiSummary'),
        logger: infra.logger,
        approvalGate: infra.approvalGate,
      };

      // Should not throw — falls back to template
      await enricher.initialize(ctx);
      const health = enricher.health();
      assert.strictEqual(health.status, 'healthy');

      if (origKey) process.env.OPENAI_API_KEY = origKey;
    });
  });
});
