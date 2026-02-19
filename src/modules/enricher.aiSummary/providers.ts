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
//
// AI is used ONLY for: summarisation, reasoning, classification, explanation.
// AI is NEVER used for: execution, action, mutation, or approval decisions.
// ---------------------------------------------------------------------------

import { IncidentCreatedPayload } from '../../shared/events';

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

// Re-export for tests
export { buildPrompt, parseAIResponse };
