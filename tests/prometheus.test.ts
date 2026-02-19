// ---------------------------------------------------------------------------
// OpsPilot — Prometheus Metrics Collector Tests
// ---------------------------------------------------------------------------

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from '../src/shared/metrics';
import { ModuleHealth } from '../src/core/types/module';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeHealth(
  status: 'healthy' | 'degraded' | 'unhealthy',
  details?: Record<string, unknown>,
): ModuleHealth {
  return { status, details, lastCheck: new Date() };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MetricsCollector', () => {

  it('should produce valid Prometheus text exposition format', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const output = collector.collect({
      'detector.regex': makeHealth('healthy', { matchCount: 42, errorCount: 0 }),
    });
    assert.ok(output.endsWith('\n'));
    // Every line should be either a comment, blank, or metric
    for (const line of output.trim().split('\n')) {
      assert.ok(
        line.startsWith('#') || line.startsWith('opspilot_') || line === '',
        `Unexpected line: ${line}`,
      );
    }
  });

  it('should include module status gauge', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const output = collector.collect({
      'ui.api': makeHealth('healthy'),
      'notifier.slack': makeHealth('degraded'),
    });
    assert.ok(output.includes('opspilot_module_status{module="ui.api"} 1'));
    assert.ok(output.includes('opspilot_module_status{module="notifier.slack"} 0.5'));
  });

  it('should map unhealthy status to 0', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const output = collector.collect({
      'connector.broken': makeHealth('unhealthy'),
    });
    assert.ok(output.includes('opspilot_module_status{module="connector.broken"} 0'));
  });

  it('should extract numeric details as gauges', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const output = collector.collect({
      'detector.regex': makeHealth('healthy', {
        matchCount: 100,
        errorCount: 3,
        configuredRules: 5,
      }),
    });
    assert.ok(output.includes('opspilot_detector_regex_matchCount 100'));
    assert.ok(output.includes('opspilot_detector_regex_errorCount 3'));
    assert.ok(output.includes('opspilot_detector_regex_configuredRules 5'));
  });

  it('should skip non-numeric detail values', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const output = collector.collect({
      'notifier.slack': makeHealth('healthy', {
        totalSent: 10,
        webhookUrl: '***configured***',
        isRunning: true,
      }),
    });
    assert.ok(output.includes('opspilot_notifier_slack_totalSent 10'));
    assert.ok(!output.includes('webhookUrl'));
    assert.ok(!output.includes('isRunning'));
  });

  it('should skip NaN and Infinity values', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const output = collector.collect({
      'test.mod': makeHealth('healthy', {
        good: 42,
        bad1: NaN,
        bad2: Infinity,
        bad3: -Infinity,
      }),
    });
    assert.ok(output.includes('opspilot_test_mod_good 42'));
    assert.ok(!output.includes('bad1'));
    assert.ok(!output.includes('bad2'));
    assert.ok(!output.includes('bad3'));
  });

  it('should include HELP and TYPE annotations', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const output = collector.collect({
      'detector.regex': makeHealth('healthy', { matchCount: 5 }),
    });
    assert.ok(output.includes('# HELP opspilot_module_status'));
    assert.ok(output.includes('# TYPE opspilot_module_status gauge'));
    assert.ok(output.includes('# HELP opspilot_detector_regex_matchCount'));
    assert.ok(output.includes('# TYPE opspilot_detector_regex_matchCount gauge'));
  });

  it('should include process metrics by default', () => {
    const collector = new MetricsCollector();
    const output = collector.collect({});
    assert.ok(output.includes('opspilot_process_uptime_seconds'));
    assert.ok(output.includes('opspilot_process_heap_used_bytes'));
    assert.ok(output.includes('opspilot_process_heap_total_bytes'));
    assert.ok(output.includes('opspilot_process_rss_bytes'));
    assert.ok(output.includes('opspilot_process_external_bytes'));
  });

  it('should exclude process metrics when disabled', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const output = collector.collect({});
    assert.ok(!output.includes('process_uptime'));
    assert.ok(!output.includes('heap_used'));
  });

  it('should support custom prefix', () => {
    const collector = new MetricsCollector({ prefix: 'myapp', includeProcess: false });
    const output = collector.collect({
      'ui.api': makeHealth('healthy', { requests: 10 }),
    });
    assert.ok(output.includes('myapp_module_status'));
    assert.ok(output.includes('myapp_ui_api_requests'));
    assert.ok(!output.includes('opspilot_'));
  });

  it('should handle empty module healths', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const output = collector.collect({});
    // Should still have HELP/TYPE for module_status but no data points
    assert.ok(output.includes('# HELP'));
    assert.ok(output.includes('# TYPE'));
  });

  it('should sanitize metric names with dots and dashes', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const output = collector.collect({
      'connector.health-check': makeHealth('healthy', { total_checks: 50 }),
    });
    assert.ok(output.includes('opspilot_connector_health_check_total_checks 50'));
  });

  it('should handle modules with no details', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const output = collector.collect({
      'ui.api': makeHealth('healthy'),
    });
    assert.ok(output.includes('opspilot_module_status{module="ui.api"} 1'));
    // No detail metrics should be emitted
    assert.ok(!output.includes('opspilot_ui_api_'));
  });

  it('should register and include custom metrics', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    collector.registerMetric({
      name: 'http_requests_total',
      type: 'counter',
      help: 'Total HTTP requests',
      value: 42,
    });
    const output = collector.collect({});
    assert.ok(output.includes('# HELP opspilot_http_requests_total Total HTTP requests'));
    assert.ok(output.includes('# TYPE opspilot_http_requests_total counter'));
    assert.ok(output.includes('opspilot_http_requests_total 42'));
  });

  it('should include custom metric labels', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    collector.registerMetric({
      name: 'http_requests',
      type: 'counter',
      help: 'Requests by method',
      value: 100,
      labels: { method: 'GET', path: '/api/health' },
    });
    const output = collector.collect({});
    assert.ok(output.includes('opspilot_http_requests{method="GET",path="/api/health"} 100'));
  });

  it('should clear custom metrics', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    collector.registerMetric({
      name: 'temp',
      type: 'gauge',
      help: 'Temporary',
      value: 99,
    });
    collector.clearCustomMetrics();
    const output = collector.collect({});
    assert.ok(!output.includes('temp'));
  });

  it('should produce consistent output across multiple collects', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const healths = {
      'ui.api': makeHealth('healthy', { requests: 5 }),
    };
    const out1 = collector.collect(healths);
    const out2 = collector.collect(healths);
    assert.equal(out1, out2);
  });

  it('should handle many modules', () => {
    const collector = new MetricsCollector({ includeProcess: false });
    const healths: Record<string, ModuleHealth> = {};
    for (let i = 0; i < 20; i++) {
      healths[`module.test${i}`] = makeHealth('healthy', { count: i * 10 });
    }
    const output = collector.collect(healths);
    const lines = output.trim().split('\n');
    // At least module_status lines + detail metrics
    assert.ok(lines.length > 40);
  });
});
