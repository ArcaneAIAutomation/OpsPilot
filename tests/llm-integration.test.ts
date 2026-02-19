// ---------------------------------------------------------------------------
// OpsPilot — LLM Integration Tests (Phase 29)
// ---------------------------------------------------------------------------
// Tests for the resilience layer: ResponseCache, ResilientSummarizer,
// createResilientSummarizer factory — covering cache, retry, circuit breaker,
// and fallback behaviour.
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ResponseCache,
  ResilientSummarizer,
  createResilientSummarizer,
  TemplateSummarizer,
  ISummarizer,
  SummaryResult,
  createSummarizer,
} from '../src/modules/enricher.aiSummary/providers';
import { IncidentCreatedPayload } from '../src/shared/events';
import { CircuitState } from '../src/shared/circuit-breaker';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeIncident(
  overrides?: Partial<IncidentCreatedPayload>,
): IncidentCreatedPayload {
  return {
    incidentId: overrides?.incidentId ?? 'inc-test-1',
    title: overrides?.title ?? 'Test Incident',
    description: overrides?.description ?? 'A test incident',
    severity: overrides?.severity ?? 'warning',
    detectedBy: overrides?.detectedBy ?? 'detector.regex',
    detectedAt:
      overrides?.detectedAt ?? new Date('2025-01-01T00:00:00Z'),
    context: overrides?.context,
  };
}

const testRunbooks = [
  {
    id: 'rb-001',
    title: 'Memory Runbook',
    keywords: ['memory', 'oom'],
    steps: ['Check memory'],
  },
];

function makeResult(summary: string = 'test summary'): SummaryResult {
  return {
    summary,
    rootCauseHypothesis: 'hypothesis',
    severityReasoning: 'reasoning',
    suggestedRunbooks: [],
    confidence: 0.8,
  };
}

/**
 * A fake summarizer for testing — invokes a user-supplied callback each call.
 */
class FakeSummarizer implements ISummarizer {
  calls = 0;
  private fn: () => Promise<SummaryResult>;

  constructor(fn: () => Promise<SummaryResult>) {
    this.fn = fn;
  }

  async summarize(
    _incident: IncidentCreatedPayload,
    _runbooks: { id: string; title: string; keywords: string[]; steps: string[] }[],
  ): Promise<SummaryResult> {
    this.calls++;
    return this.fn();
  }
}

// ── ResponseCache Tests ────────────────────────────────────────────────────

describe('ResponseCache', () => {
  let cache: ResponseCache;

  beforeEach(() => {
    cache = new ResponseCache(3, 60_000);
  });

  it('should return undefined for cache miss', () => {
    const result = cache.get('nonexistent');
    assert.strictEqual(result, undefined);
  });

  it('should store and retrieve entries', () => {
    const result = makeResult('cached');
    cache.set('key1', result);
    const retrieved = cache.get('key1');
    assert.deepStrictEqual(retrieved, result);
    assert.strictEqual(cache.size, 1);
  });

  it('should generate deterministic keys from incident data', () => {
    const incident = makeIncident();
    const key1 = cache.key(incident);
    const key2 = cache.key(incident);
    assert.strictEqual(key1, key2);
    assert.strictEqual(key1.length, 16); // sha256 truncated
  });

  it('should generate different keys for different incidents', () => {
    const key1 = cache.key(makeIncident({ title: 'Incident A' }));
    const key2 = cache.key(makeIncident({ title: 'Incident B' }));
    assert.notStrictEqual(key1, key2);
  });

  it('should evict oldest entry when at capacity', () => {
    cache.set('a', makeResult('a'));
    cache.set('b', makeResult('b'));
    cache.set('c', makeResult('c'));
    assert.strictEqual(cache.size, 3);

    // Adding 4th should evict 'a'
    cache.set('d', makeResult('d'));
    assert.strictEqual(cache.size, 3);
    assert.strictEqual(cache.get('a'), undefined);
    assert.deepStrictEqual(cache.get('d')?.summary, 'd');
  });

  it('should refresh LRU position on get', () => {
    cache.set('a', makeResult('a'));
    cache.set('b', makeResult('b'));
    cache.set('c', makeResult('c'));

    // Access 'a' to refresh it
    cache.get('a');

    // Now adding 'd' should evict 'b' (oldest un-refreshed)
    cache.set('d', makeResult('d'));
    assert.strictEqual(cache.get('b'), undefined);
    assert.ok(cache.get('a'));
  });

  it('should expire entries after TTL', () => {
    // Create a cache with 1ms TTL
    const shortCache = new ResponseCache(10, 1);
    shortCache.set('key', makeResult());

    // Use a small busy-wait to exceed TTL
    const start = Date.now();
    while (Date.now() - start < 5) {
      // spin
    }

    assert.strictEqual(shortCache.get('key'), undefined);
    assert.strictEqual(shortCache.size, 0);
  });

  it('should clear all entries', () => {
    cache.set('a', makeResult());
    cache.set('b', makeResult());
    assert.strictEqual(cache.size, 2);

    cache.clear();
    assert.strictEqual(cache.size, 0);
  });
});

// ── ResilientSummarizer Tests ──────────────────────────────────────────────

describe('ResilientSummarizer', () => {
  const fallback = new TemplateSummarizer();

  it('should delegate to inner summarizer on success', async () => {
    const expected = makeResult('from provider');
    const inner = new FakeSummarizer(() => Promise.resolve(expected));

    const resilient = new ResilientSummarizer(inner, fallback, {
      maxRetries: 0,
    });

    const result = await resilient.summarize(makeIncident(), testRunbooks);
    assert.strictEqual(result.summary, 'from provider');
    assert.strictEqual(inner.calls, 1);
    assert.strictEqual(resilient.cacheMisses, 1);
  });

  it('should cache and return cached results on repeat calls', async () => {
    let callCount = 0;
    const inner = new FakeSummarizer(() => {
      callCount++;
      return Promise.resolve(makeResult(`call-${callCount}`));
    });

    const resilient = new ResilientSummarizer(inner, fallback, {
      maxRetries: 0,
      cacheTtlMs: 60_000,
    });

    const incident = makeIncident();
    const first = await resilient.summarize(incident, testRunbooks);
    const second = await resilient.summarize(incident, testRunbooks);

    assert.strictEqual(first.summary, 'call-1');
    assert.strictEqual(second.summary, 'call-1'); // cached
    assert.strictEqual(callCount, 1);
    assert.strictEqual(resilient.cacheHits, 1);
    assert.strictEqual(resilient.cacheMisses, 1);
  });

  it('should use different cache entries for different incidents', async () => {
    let callCount = 0;
    const inner = new FakeSummarizer(() => {
      callCount++;
      return Promise.resolve(makeResult(`call-${callCount}`));
    });

    const resilient = new ResilientSummarizer(inner, fallback, {
      maxRetries: 0,
    });

    await resilient.summarize(makeIncident({ incidentId: 'a' }), testRunbooks);
    await resilient.summarize(makeIncident({ incidentId: 'b' }), testRunbooks);
    assert.strictEqual(callCount, 2);
    assert.strictEqual(resilient.cacheMisses, 2);
    assert.strictEqual(resilient.cacheHits, 0);
  });

  it('should fall back on provider failure (non-retryable)', async () => {
    const inner = new FakeSummarizer(() =>
      Promise.reject(new Error('bad request')),
    );

    const resilient = new ResilientSummarizer(inner, fallback, {
      maxRetries: 0,
    });

    const result = await resilient.summarize(makeIncident(), testRunbooks);
    // Template summarizer generates a result
    assert.ok(result.summary.length > 0);
    assert.strictEqual(resilient.fallbackUsed, 1);
  });

  it('should retry on retryable errors before falling back', async () => {
    let attempts = 0;
    const inner = new FakeSummarizer(() => {
      attempts++;
      const err = new Error('Server error');
      (err as Error & { status?: number }).status = 500;
      return Promise.reject(err);
    });

    const resilient = new ResilientSummarizer(inner, fallback, {
      maxRetries: 2,
      retryBaseDelayMs: 1, // minimal delay for tests
    });

    const result = await resilient.summarize(makeIncident(), testRunbooks);
    // inner called: 1 initial + 2 retries = 3
    assert.strictEqual(attempts, 3);
    assert.strictEqual(resilient.retryAttempts, 2);
    assert.strictEqual(resilient.fallbackUsed, 1);
    assert.ok(result.summary.length > 0);
  });

  it('should succeed after transient failures', async () => {
    let attempts = 0;
    const inner = new FakeSummarizer(() => {
      attempts++;
      if (attempts < 3) {
        const err = new Error('Server error');
        (err as Error & { status?: number }).status = 503;
        return Promise.reject(err);
      }
      return Promise.resolve(makeResult('recovered'));
    });

    const resilient = new ResilientSummarizer(inner, fallback, {
      maxRetries: 3,
      retryBaseDelayMs: 1,
    });

    const result = await resilient.summarize(makeIncident(), testRunbooks);
    assert.strictEqual(result.summary, 'recovered');
    assert.strictEqual(resilient.fallbackUsed, 0);
    assert.strictEqual(resilient.retryAttempts, 2);
  });

  it('should track circuit breaker state on repeated failures', async () => {
    const inner = new FakeSummarizer(() => {
      const err = new Error('timeout');
      (err as Error & { status?: number }).status = 500;
      return Promise.reject(err);
    });

    const resilient = new ResilientSummarizer(inner, fallback, {
      maxRetries: 0,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 60_000,
    });

    // Trip the circuit breaker with repeated failures
    for (let i = 0; i < 4; i++) {
      await resilient.summarize(
        makeIncident({ incidentId: `inc-${i}` }),
        testRunbooks,
      );
    }

    assert.strictEqual(
      resilient.circuitBreaker.getState(),
      CircuitState.Open,
    );
    assert.ok(resilient.circuitBreaks > 0);
    assert.strictEqual(resilient.fallbackUsed, 4);
  });

  it('should invoke onEvent callbacks', async () => {
    const events: string[] = [];
    const inner = new FakeSummarizer(() =>
      Promise.resolve(makeResult('ok')),
    );

    const resilient = new ResilientSummarizer(inner, fallback, {
      maxRetries: 0,
      onEvent: (event) => events.push(event),
    });

    const incident = makeIncident();
    await resilient.summarize(incident, testRunbooks);
    await resilient.summarize(incident, testRunbooks); // cache hit

    assert.ok(events.includes('cache.hit'));
  });

  it('should invoke fallback event on provider error', async () => {
    const events: string[] = [];
    const inner = new FakeSummarizer(() =>
      Promise.reject(new Error('fail')),
    );

    const resilient = new ResilientSummarizer(inner, fallback, {
      maxRetries: 0,
      onEvent: (event) => events.push(event),
    });

    await resilient.summarize(makeIncident(), testRunbooks);
    assert.ok(events.includes('fallback'));
  });

  it('should track combined metrics correctly', async () => {
    let callCount = 0;
    const inner = new FakeSummarizer(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(makeResult('first'));
      }
      return Promise.reject(new Error('fail'));
    });

    const resilient = new ResilientSummarizer(inner, fallback, {
      maxRetries: 0,
    });

    const incident1 = makeIncident({ incidentId: 'a' });
    const incident2 = makeIncident({ incidentId: 'b' });

    await resilient.summarize(incident1, testRunbooks); // success
    await resilient.summarize(incident1, testRunbooks); // cache hit
    await resilient.summarize(incident2, testRunbooks); // fail → fallback

    assert.strictEqual(resilient.cacheHits, 1);
    assert.strictEqual(resilient.cacheMisses, 2);
    assert.strictEqual(resilient.fallbackUsed, 1);
  });
});

// ── createResilientSummarizer Factory Tests ────────────────────────────────

describe('createResilientSummarizer', () => {
  it('should return TemplateSummarizer for template provider', () => {
    const summarizer = createResilientSummarizer({
      provider: 'template',
      model: 'template',
      maxTokens: 500,
    });
    assert.ok(summarizer instanceof TemplateSummarizer);
  });

  it('should return ResilientSummarizer for openai provider', () => {
    const summarizer = createResilientSummarizer({
      provider: 'openai',
      model: 'gpt-4',
      maxTokens: 500,
      apiKey: 'test-key',
    });
    assert.ok(summarizer instanceof ResilientSummarizer);
  });

  it('should return ResilientSummarizer for anthropic provider', () => {
    const summarizer = createResilientSummarizer({
      provider: 'anthropic',
      model: 'claude-3',
      maxTokens: 500,
      apiKey: 'test-key',
    });
    assert.ok(summarizer instanceof ResilientSummarizer);
  });

  it('should pass resilient config through', () => {
    const summarizer = createResilientSummarizer(
      {
        provider: 'openai',
        model: 'gpt-4',
        maxTokens: 500,
        apiKey: 'test-key',
      },
      {
        maxRetries: 5,
        cacheMaxSize: 50,
        circuitBreakerThreshold: 10,
      },
    ) as ResilientSummarizer;

    assert.ok(summarizer.cache);
    assert.ok(summarizer.circuitBreaker);
  });

  it('should generate summaries via template fallback on API errors', async () => {
    // Without a real API key, the OpenAI provider will fail and the
    // ResilientSummarizer should fall back to TemplateSummarizer
    const summarizer = createResilientSummarizer(
      {
        provider: 'openai',
        model: 'gpt-4',
        maxTokens: 500,
        apiKey: 'invalid-key',
        baseUrl: 'http://127.0.0.1:1', // unreachable
        timeoutMs: 100,
      },
      {
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    );

    const result = await summarizer.summarize(makeIncident(), testRunbooks);
    // Should get a template result via fallback
    assert.ok(result.summary.length > 0);
    assert.ok(result.confidence >= 0);
  });
});

// ── createSummarizer Factory (existing) ────────────────────────────────────

describe('createSummarizer (base factory)', () => {
  it('should still work for direct use', () => {
    const t = createSummarizer({ provider: 'template', model: 't', maxTokens: 500 });
    assert.ok(t instanceof TemplateSummarizer);
  });
});
