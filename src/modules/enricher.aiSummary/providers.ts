// ---------------------------------------------------------------------------
// OpsPilot — AI Provider Implementations
// ---------------------------------------------------------------------------
// Real OpenAI and Anthropic providers for the AI Summary Enricher.
//
// Each provider:
//   - Accepts API key via config or environment variable
//   - Makes HTTP requests using Node.js built-in fetch()
//   - Parses structured JSON from the AI response
//   - Falls back to template summarization on failure
//   - Handles rate limits, timeouts, and API errors gracefully
//   - Supports retry with exponential backoff (429/5xx)
//   - Circuit breaker prevents cascading failures
//   - LRU response cache avoids duplicate API calls
//
// AI is used ONLY for: summarisation, reasoning, classification, explanation.
// AI is NEVER used for: execution, action, mutation, or approval decisions.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { IncidentCreatedPayload } from '../../shared/events';
import { CircuitBreaker, CircuitState } from '../../shared/circuit-breaker';
import { retryWithBackoff, isRetryableHttpError } from '../../shared/retry';

// ── Shared Types ───────────────────────────────────────────────────────────

export interface Runbook {
  id: string;
  title: string;
  keywords: string[];
  steps: string[];
}

export interface SummaryResult {
  summary: string;
  rootCauseHypothesis: string;
  severityReasoning: string;
  suggestedRunbooks: Runbook[];
  confidence: number; // 0-1
}

export interface ISummarizer {
  summarize(
    incident: IncidentCreatedPayload,
    runbooks: Runbook[],
  ): Promise<SummaryResult>;
}

export interface AIProviderConfig {
  provider: 'template' | 'openai' | 'anthropic';
  model: string;
  maxTokens: number;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

// ── Prompt Builder ─────────────────────────────────────────────────────────

function buildPrompt(
  incident: IncidentCreatedPayload,
  runbooks: Runbook[],
): string {
  const runbookSection =
    runbooks.length > 0
      ? `\n\nAvailable Runbooks:\n${runbooks.map((rb) => `- ${rb.title} (keywords: ${rb.keywords.join(', ')})`).join('\n')}`
      : '';

  return `You are an expert Site Reliability Engineer analyzing an operations incident.

Incident Details:
- Title: ${incident.title}
- Description: ${incident.description}
- Severity: ${incident.severity}
- Detected by: ${incident.detectedBy}
- Detected at: ${incident.detectedAt instanceof Date ? incident.detectedAt.toISOString() : incident.detectedAt}
${incident.context ? `- Context: ${JSON.stringify(incident.context)}` : ''}${runbookSection}

Respond with a JSON object containing exactly these fields:
{
  "summary": "A clear, concise summary of the incident for an operator",
  "rootCauseHypothesis": "Most likely root cause based on available evidence",
  "severityReasoning": "Why this severity level is appropriate",
  "matchedRunbookIds": ["array of runbook IDs that are relevant, or empty array"],
  "confidence": 0.85
}

The confidence should be a number between 0 and 1 reflecting how confident you are in your analysis.
Respond ONLY with the JSON object, no additional text.`;
}

// ── JSON Response Parser ───────────────────────────────────────────────────

interface AIJsonResponse {
  summary: string;
  rootCauseHypothesis: string;
  severityReasoning: string;
  matchedRunbookIds: string[];
  confidence: number;
}

function parseAIResponse(
  text: string,
  runbooks: Runbook[],
): SummaryResult {
  // Try to extract JSON from the response (handle markdown code blocks)
  let jsonStr = text.trim();

  // Strip markdown code fences if present
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  const parsed: AIJsonResponse = JSON.parse(jsonStr);

  // Map matched runbook IDs back to full runbook objects
  const matchedRunbooks = runbooks.filter((rb) =>
    parsed.matchedRunbookIds?.includes(rb.id),
  );

  return {
    summary: parsed.summary ?? 'No summary generated',
    rootCauseHypothesis: parsed.rootCauseHypothesis ?? 'Unable to determine root cause',
    severityReasoning: parsed.severityReasoning ?? 'No severity reasoning provided',
    suggestedRunbooks: matchedRunbooks,
    confidence: typeof parsed.confidence === 'number'
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.5,
  };
}

// ── OpenAI Provider ────────────────────────────────────────────────────────

export class OpenAISummarizer implements ISummarizer {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: AIProviderConfig) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = config.model || 'gpt-4o-mini';
    this.maxTokens = config.maxTokens || 500;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
    this.timeoutMs = config.timeoutMs ?? 30000;

    if (!this.apiKey) {
      throw new Error(
        'OpenAI API key not configured. Set apiKey in config or OPENAI_API_KEY environment variable.',
      );
    }
  }

  async summarize(
    incident: IncidentCreatedPayload,
    runbooks: Runbook[],
  ): Promise<SummaryResult> {
    const prompt = buildPrompt(incident, runbooks);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        `${this.baseUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              {
                role: 'system',
                content:
                  'You are an expert SRE assistant. Respond only with valid JSON.',
              },
              { role: 'user', content: prompt },
            ],
            max_tokens: this.maxTokens,
            temperature: 0.3,
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');
        throw new Error(
          `OpenAI API error ${response.status}: ${errorBody}`,
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(`OpenAI error: ${data.error.message}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('OpenAI returned empty response');
      }

      return parseAIResponse(content, runbooks);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Anthropic Provider ─────────────────────────────────────────────────────

export class AnthropicSummarizer implements ISummarizer {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: AIProviderConfig) {
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.maxTokens = config.maxTokens || 500;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    this.timeoutMs = config.timeoutMs ?? 30000;

    if (!this.apiKey) {
      throw new Error(
        'Anthropic API key not configured. Set apiKey in config or ANTHROPIC_API_KEY environment variable.',
      );
    }
  }

  async summarize(
    incident: IncidentCreatedPayload,
    runbooks: Runbook[],
  ): Promise<SummaryResult> {
    const prompt = buildPrompt(incident, runbooks);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        `${this.baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: this.maxTokens,
            messages: [
              {
                role: 'user',
                content: `${prompt}\n\nIMPORTANT: Respond ONLY with valid JSON, nothing else.`,
              },
            ],
            temperature: 0.3,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');
        throw new Error(
          `Anthropic API error ${response.status}: ${errorBody}`,
        );
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(`Anthropic error: ${data.error.message}`);
      }

      const textBlock = data.content?.find((b) => b.type === 'text');
      if (!textBlock?.text) {
        throw new Error('Anthropic returned empty response');
      }

      return parseAIResponse(textBlock.text, runbooks);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Template Summarizer (no external API) ──────────────────────────────────

export class TemplateSummarizer implements ISummarizer {
  async summarize(
    incident: IncidentCreatedPayload,
    runbooks: Runbook[],
  ): Promise<SummaryResult> {
    // Find matching runbooks via keyword overlap
    const incidentText =
      `${incident.title} ${incident.description}`.toLowerCase();
    const matchedRunbooks = runbooks.filter((rb) =>
      rb.keywords.some((kw) => incidentText.includes(kw.toLowerCase())),
    );

    const summary = this.buildSummary(incident);
    const rootCause = this.inferRootCause(incident);
    const severityReasoning = this.explainSeverity(incident);

    return {
      summary,
      rootCauseHypothesis: rootCause,
      severityReasoning,
      suggestedRunbooks: matchedRunbooks,
      confidence: matchedRunbooks.length > 0 ? 0.7 : 0.4,
    };
  }

  private buildSummary(incident: IncidentCreatedPayload): string {
    const ctx = incident.context ?? {};
    const parts: string[] = [];

    parts.push(`**Incident:** ${incident.title}`);
    parts.push(`**Severity:** ${incident.severity.toUpperCase()}`);
    parts.push(`**Detected by:** ${incident.detectedBy}`);
    parts.push(`**Description:** ${incident.description}`);

    if (ctx.logSource) {
      parts.push(`**Source:** ${ctx.logSource}`);
    }
    if (ctx.matchedLine) {
      parts.push(`**Matched line:** \`${ctx.matchedLine}\``);
    }

    return parts.join('\n');
  }

  private inferRootCause(incident: IncidentCreatedPayload): string {
    const title = incident.title.toLowerCase();
    const desc = incident.description.toLowerCase();

    if (title.includes('error') || desc.includes('error')) {
      return 'Application error detected in logs. May indicate a software bug, misconfiguration, or external dependency failure.';
    }
    if (title.includes('memory') || desc.includes('memory')) {
      return 'High memory usage detected. Possible memory leak, insufficient resources, or traffic spike.';
    }
    if (title.includes('cpu') || desc.includes('cpu')) {
      return 'High CPU usage detected. Possible runaway process, resource contention, or compute-intensive workload.';
    }
    if (title.includes('disk') || desc.includes('disk')) {
      return 'High disk usage detected. Possible log accumulation, data growth, or missing cleanup jobs.';
    }
    if (title.includes('timeout') || desc.includes('timeout')) {
      return 'Timeout detected. Network latency, overloaded service, or firewall/DNS issue.';
    }
    if (title.includes('connection') || desc.includes('connection')) {
      return 'Connection issue detected. Service may be down, network partition, or connection pool exhausted.';
    }

    return 'Anomalous pattern detected. Further investigation recommended to determine root cause.';
  }

  private explainSeverity(incident: IncidentCreatedPayload): string {
    switch (incident.severity) {
      case 'critical':
        return 'Classified as CRITICAL: This pattern typically indicates service-impacting issues that require immediate attention.';
      case 'warning':
        return 'Classified as WARNING: This pattern indicates a potential issue that may escalate if not addressed.';
      case 'info':
        return 'Classified as INFO: This pattern is noteworthy but does not indicate an immediate problem.';
      default:
        return `Classified as ${incident.severity}: Severity based on detection rule configuration.`;
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create the appropriate summarizer based on configuration.
 * Throws if an external provider is selected but not properly configured.
 */
export function createSummarizer(config: AIProviderConfig): ISummarizer {
  switch (config.provider) {
    case 'openai':
      return new OpenAISummarizer(config);
    case 'anthropic':
      return new AnthropicSummarizer(config);
    case 'template':
    default:
      return new TemplateSummarizer();
  }
}

// ── Response Cache ─────────────────────────────────────────────────────────

/**
 * LRU cache entry for AI responses.
 */
interface CacheEntry {
  result: SummaryResult;
  cachedAt: number;
}

/**
 * Simple LRU cache for AI responses to avoid duplicate API calls.
 */
export class ResponseCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number = 100, ttlMs: number = 300_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * Generate a cache key from incident data.
   */
  key(incident: IncidentCreatedPayload): string {
    const hash = createHash('sha256');
    hash.update(incident.incidentId);
    hash.update(incident.title);
    hash.update(incident.description);
    hash.update(incident.severity);
    return hash.digest('hex').slice(0, 16);
  }

  /**
   * Get a cached result if available and not expired.
   */
  get(cacheKey: string): SummaryResult | undefined {
    const entry = this.cache.get(cacheKey);
    if (!entry) return undefined;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(cacheKey);
      return undefined;
    }

    // Move to end (LRU refresh)
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    return entry.result;
  }

  /**
   * Store a result in the cache.
   */
  set(cacheKey: string, result: SummaryResult): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, { result, cachedAt: Date.now() });
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Number of cached entries.
   */
  get size(): number {
    return this.cache.size;
  }
}

// ── Resilient Summarizer ───────────────────────────────────────────────────

/**
 * Configuration for the resilient summarizer wrapper.
 */
export interface ResilientSummarizerConfig {
  /** Maximum retries for transient errors. Default: 2. */
  maxRetries?: number;
  /** Base delay for retry backoff in ms. Default: 1000. */
  retryBaseDelayMs?: number;
  /** Circuit breaker failure threshold. Default: 5. */
  circuitBreakerThreshold?: number;
  /** Circuit breaker reset timeout in ms. Default: 60000. */
  circuitBreakerResetMs?: number;
  /** Cache max entries. Default: 100. */
  cacheMaxSize?: number;
  /** Cache TTL in ms. Default: 300000 (5 min). */
  cacheTtlMs?: number;
  /** Optional callback for retry/circuit events. */
  onEvent?: (event: string, details?: Record<string, unknown>) => void;
}

/**
 * Wraps any ISummarizer with retry, circuit breaker, and caching.
 *
 * Composition order: Cache → Circuit Breaker → Retry → Provider
 */
export class ResilientSummarizer implements ISummarizer {
  private readonly inner: ISummarizer;
  private readonly fallback: ISummarizer;
  readonly cache: ResponseCache;
  readonly circuitBreaker: CircuitBreaker;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly onEvent: ((event: string, details?: Record<string, unknown>) => void) | undefined;

  // Metrics
  cacheHits = 0;
  cacheMisses = 0;
  retryAttempts = 0;
  circuitBreaks = 0;
  fallbackUsed = 0;

  constructor(
    inner: ISummarizer,
    fallback: ISummarizer,
    config: ResilientSummarizerConfig = {},
  ) {
    this.inner = inner;
    this.fallback = fallback;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
    this.onEvent = config.onEvent;

    this.cache = new ResponseCache(
      config.cacheMaxSize ?? 100,
      config.cacheTtlMs ?? 300_000,
    );

    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: config.circuitBreakerThreshold ?? 5,
      resetTimeoutMs: config.circuitBreakerResetMs ?? 60_000,
      name: 'ai-provider',
    });
  }

  async summarize(
    incident: IncidentCreatedPayload,
    runbooks: Runbook[],
  ): Promise<SummaryResult> {
    // 1. Check cache
    const cacheKey = this.cache.key(incident);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cacheHits++;
      this.onEvent?.('cache.hit', { incidentId: incident.incidentId });
      return cached;
    }
    this.cacheMisses++;

    // 2. Circuit breaker → Retry → Provider
    try {
      const result = await this.circuitBreaker.execute(() =>
        retryWithBackoff(
          () => this.inner.summarize(incident, runbooks),
          {
            maxRetries: this.maxRetries,
            baseDelayMs: this.retryBaseDelayMs,
            isRetryable: isRetryableHttpError,
            onRetry: (attempt, error, delayMs) => {
              this.retryAttempts++;
              this.onEvent?.('retry', {
                attempt,
                error: error instanceof Error ? error.message : String(error),
                delayMs,
              });
            },
          },
        ),
      );

      // Cache successful result
      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      // Track circuit breaks
      if (this.circuitBreaker.getState() === CircuitState.Open) {
        this.circuitBreaks++;
        this.onEvent?.('circuit.open', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Fall back to template summarizer
      this.fallbackUsed++;
      this.onEvent?.('fallback', {
        incidentId: incident.incidentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.fallback.summarize(incident, runbooks);
    }
  }
}

/**
 * Create a summarizer with optional resilience wrapping.
 * For external providers (openai, anthropic), wraps with ResilientSummarizer.
 * For template provider, returns as-is (no retry/cache needed).
 */
export function createResilientSummarizer(
  config: AIProviderConfig,
  resilientConfig?: ResilientSummarizerConfig,
): ISummarizer {
  const base = createSummarizer(config);

  // Template provider doesn't need resilience wrapping
  if (config.provider === 'template') {
    return base;
  }

  return new ResilientSummarizer(
    base,
    new TemplateSummarizer(),
    resilientConfig,
  );
}

// Re-export for tests
export { buildPrompt, parseAIResponse };
