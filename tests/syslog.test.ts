// ---------------------------------------------------------------------------
// OpsPilot — connector.syslog Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SyslogConnector, ParsedSyslog } from '../src/modules/connector.syslog/index';
import { ModuleContext, ModuleType } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { OpsPilotEvent } from '../src/core/types/events';
import { LogIngestedPayload } from '../src/shared/events';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'connector.syslog',
    config: {
      protocol: 'udp',
      host: '127.0.0.1',
      port: 0,
      source: 'syslog-test',
      maxMessageSize: 8192,
      parseRfc: 'auto',
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'connector.syslog'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

// ── Lifecycle Tests ────────────────────────────────────────────────────────

describe('connector.syslog — Lifecycle', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: SyslogConnector;

  beforeEach(() => {
    infra = createTestInfra();
    mod = new SyslogConnector();
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  it('has correct manifest', () => {
    assert.equal(mod.manifest.id, 'connector.syslog');
    assert.equal(mod.manifest.type, ModuleType.Connector);
  });

  it('initializes with config', async () => {
    await mod.initialize(makeContext(infra));
    const config = mod.getConfig();
    assert.equal(config.protocol, 'udp');
    assert.equal(config.source, 'syslog-test');
    assert.equal(config.parseRfc, 'auto');
  });

  it('reports healthy status', async () => {
    await mod.initialize(makeContext(infra));
    const h = mod.health();
    assert.equal(h.status, 'healthy');
    assert.ok(h.details);
    assert.equal(h.details!.messagesReceived, 0);
  });
});

// ── RFC 3164 Parsing ───────────────────────────────────────────────────────

describe('connector.syslog — RFC 3164 Parsing', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: SyslogConnector;

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new SyslogConnector();
    await mod.initialize(makeContext(infra));
  });

  afterEach(async () => {
    await mod.destroy().catch(() => {});
  });

  it('parses BSD syslog with priority, hostname, and app', () => {
    const msg = '<34>Jan  5 14:30:00 web-01 nginx[1234]: GET /api/health 200';
    const parsed = mod.parse(msg);

    assert.equal(parsed.rfc, '3164');
    assert.equal(parsed.priority, 34);
    assert.equal(parsed.facility, 4);   // auth
    assert.equal(parsed.severity, 2);   // crit
    assert.equal(parsed.facilityName, 'auth');
    assert.equal(parsed.severityName, 'crit');
    assert.equal(parsed.hostname, 'web-01');
    assert.equal(parsed.appName, 'nginx');
    assert.equal(parsed.pid, '1234');
    assert.equal(parsed.message, 'GET /api/health 200');
  });

  it('parses simple BSD syslog without PID', () => {
    const msg = '<13>Jan  1 00:00:00 router syslog: System started';
    const parsed = mod.parse(msg);

    assert.equal(parsed.priority, 13);
    assert.equal(parsed.facilityName, 'user');
    assert.equal(parsed.severityName, 'notice');
    assert.equal(parsed.hostname, 'router');
    assert.equal(parsed.appName, 'syslog');
    assert.equal(parsed.pid, undefined);
    assert.equal(parsed.message, 'System started');
  });

  it('maps syslog severity correctly', () => {
    // severity 0 = emerg = critical
    const emerg = mod.parse('<0>Jan  1 00:00:00 h kernel: panic');
    assert.equal(emerg.severity, 0);
    assert.equal(emerg.severityName, 'emerg');

    // severity 4 = warning
    const warn = mod.parse('<12>Jan  1 00:00:00 h app: warning');
    assert.equal(warn.severity, 4);
    assert.equal(warn.severityName, 'warning');
  });

  it('throws on invalid format', () => {
    assert.throws(() => mod.parse('no priority here'), /missing priority/i);
  });
});

// ── RFC 5424 Parsing ───────────────────────────────────────────────────────

describe('connector.syslog — RFC 5424 Parsing', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: SyslogConnector;

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new SyslogConnector();
    await mod.initialize(makeContext(infra));
  });

  afterEach(async () => {
    await mod.destroy().catch(() => {});
  });

  it('parses IETF syslog format', () => {
    const msg = '<165>1 2024-01-15T10:30:00.000Z web-01 myapp 1234 ID42 - Application started';
    const parsed = mod.parse(msg);

    assert.equal(parsed.rfc, '5424');
    assert.equal(parsed.priority, 165);
    assert.equal(parsed.facility, 20);     // local4
    assert.equal(parsed.severity, 5);      // notice
    assert.equal(parsed.hostname, 'web-01');
    assert.equal(parsed.appName, 'myapp');
    assert.equal(parsed.pid, '1234');
    assert.equal(parsed.msgId, 'ID42');
    assert.equal(parsed.message, 'Application started');
  });

  it('handles nil values', () => {
    const msg = '<134>1 2024-01-15T10:30:00.000Z - - - - Hello';
    const parsed = mod.parse(msg);

    assert.equal(parsed.rfc, '5424');
    assert.equal(parsed.hostname, undefined);
    assert.equal(parsed.appName, undefined);
    assert.equal(parsed.pid, undefined);
    assert.equal(parsed.msgId, undefined);
    assert.equal(parsed.message, 'Hello');
  });

  it('strips structured data prefix', () => {
    const msg = '<165>1 2024-01-15T10:30:00.000Z host app 1 - [exampleSDID@32473 iut="3"] Test message';
    const parsed = mod.parse(msg);

    assert.equal(parsed.message, 'Test message');
  });
});

// ── Event Emission ─────────────────────────────────────────────────────────

describe('connector.syslog — Event Emission', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: SyslogConnector;

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new SyslogConnector();
    await mod.initialize(makeContext(infra));
    await mod.start().catch(() => {});
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  it('injects a message and emits log.ingested', async () => {
    const events: OpsPilotEvent<LogIngestedPayload>[] = [];
    infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => { events.push(e); });

    mod.injectMessage('<34>Jan  5 14:30:00 web-01 nginx[1234]: GET /api/health 200', '10.0.0.1');
    await sleep(10);

    assert.equal(events.length, 1);
    assert.equal(events[0].payload.source, 'syslog-test');
    assert.equal(events[0].payload.line, 'GET /api/health 200');
    const meta = events[0].payload.metadata as Record<string, unknown>;
    assert.equal(meta.facility, 'auth');
    assert.equal(meta.severity, 'crit');
    assert.equal(meta.hostname, 'web-01');
    assert.equal(meta.remoteAddress, '10.0.0.1');
    assert.equal(meta.opsSeverity, 'critical');
  });

  it('tracks metrics after injection', async () => {
    mod.injectMessage('<13>Jan  1 00:00:00 h app: test line', '127.0.0.1');
    mod.injectMessage('<13>Jan  1 00:00:00 h app: test line 2', '127.0.0.1');

    const metrics = mod.getMetrics();
    assert.equal(metrics.messagesReceived, 2);
    assert.equal(metrics.messagesEmitted, 2);
    assert.equal(metrics.parseErrors, 0);
  });

  it('tracks parse errors for invalid messages', async () => {
    mod.injectMessage('not a syslog message', '127.0.0.1');

    const metrics = mod.getMetrics();
    assert.equal(metrics.messagesReceived, 1);
    assert.equal(metrics.messagesEmitted, 0);
    assert.equal(metrics.parseErrors, 1);
  });
});
