// ---------------------------------------------------------------------------
// OpsPilot — connector.journald Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JournaldConnector, JournalEntry } from '../src/modules/connector.journald/index';
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
    moduleId: 'connector.journald',
    config: {
      pollIntervalMs: 60000, // long interval — we'll poll manually
      source: 'journald-test',
      units: [],
      priorities: [0, 1, 2, 3, 4, 5, 6],
      maxEntriesPerPoll: 500,
      sinceBoot: true,
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'connector.journald'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    cursor: 's=abc123;i=1',
    timestamp: new Date('2024-01-15T10:30:00Z'),
    hostname: 'server-01',
    unit: 'nginx.service',
    message: 'GET /api/health 200',
    priority: 6,
    pid: '1234',
    uid: '0',
    syslogIdentifier: 'nginx',
    ...overrides,
  };
}

// ── Lifecycle Tests ────────────────────────────────────────────────────────

describe('connector.journald — Lifecycle', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: JournaldConnector;

  beforeEach(() => {
    infra = createTestInfra();
    mod = new JournaldConnector();
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  it('has correct manifest', () => {
    assert.equal(mod.manifest.id, 'connector.journald');
    assert.equal(mod.manifest.type, ModuleType.Connector);
  });

  it('initializes with config', async () => {
    // Override availability check to avoid needing real journalctl
    mod.setAvailable(true);
    await mod.initialize(makeContext(infra));
    const config = mod.getConfig();
    assert.equal(config.source, 'journald-test');
    assert.deepEqual(config.priorities, [0, 1, 2, 3, 4, 5, 6]);
  });

  it('reports unhealthy when journalctl unavailable', async () => {
    mod.setAvailable(false);
    await mod.initialize(makeContext(infra));
    const h = mod.health();
    assert.equal(h.status, 'unhealthy');
    assert.ok(h.message?.includes('journalctl'));
  });
});

// ── Entry Parsing ──────────────────────────────────────────────────────────

describe('connector.journald — Entry Parsing', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: JournaldConnector;

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new JournaldConnector();
    mod.setAvailable(true);
    await mod.initialize(makeContext(infra));
  });

  afterEach(async () => {
    await mod.destroy().catch(() => {});
  });

  it('parses journalctl JSON entry', () => {
    const raw = {
      __CURSOR: 's=abc;i=42',
      __REALTIME_TIMESTAMP: String(1705312200000000), // µs
      _HOSTNAME: 'server-01',
      _SYSTEMD_UNIT: 'sshd.service',
      MESSAGE: 'Accepted publickey for user',
      PRIORITY: '6',
      _PID: '5678',
      _UID: '0',
      SYSLOG_IDENTIFIER: 'sshd',
    };

    const entry = mod.parseEntry(raw);
    assert.equal(entry.cursor, 's=abc;i=42');
    assert.equal(entry.hostname, 'server-01');
    assert.equal(entry.unit, 'sshd.service');
    assert.equal(entry.message, 'Accepted publickey for user');
    assert.equal(entry.priority, 6);
    assert.equal(entry.pid, '5678');
    assert.equal(entry.syslogIdentifier, 'sshd');
  });

  it('handles missing fields gracefully', () => {
    const raw = {
      __CURSOR: 's=x;i=1',
      MESSAGE: 'Some log line',
    };

    const entry = mod.parseEntry(raw);
    assert.equal(entry.cursor, 's=x;i=1');
    assert.equal(entry.hostname, 'unknown');
    assert.equal(entry.unit, 'unknown');
    assert.equal(entry.message, 'Some log line');
    assert.equal(entry.priority, 6); // default
  });
});

// ── Event Emission ─────────────────────────────────────────────────────────

describe('connector.journald — Event Emission', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: JournaldConnector;

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new JournaldConnector();
    mod.setAvailable(true);
    await mod.initialize(makeContext(infra));
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  it('emits log.ingested events via injectEntries', async () => {
    const events: OpsPilotEvent<LogIngestedPayload>[] = [];
    infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => { events.push(e); });

    await mod.injectEntries([
      makeEntry({ message: 'Service started', priority: 6 }),
      makeEntry({ message: 'Connection refused', priority: 3, cursor: 's=abc;i=2' }),
    ]);
    await sleep(10);

    assert.equal(events.length, 2);
    assert.equal(events[0].payload.line, 'Service started');
    const meta0 = events[0].payload.metadata as Record<string, unknown>;
    assert.equal(meta0.opsSeverity, 'info');

    assert.equal(events[1].payload.line, 'Connection refused');
    const meta1 = events[1].payload.metadata as Record<string, unknown>;
    assert.equal(meta1.opsSeverity, 'warning');
  });

  it('tracks cursor after injection', async () => {
    assert.equal(mod.getCursor(), null);

    await mod.injectEntries([
      makeEntry({ cursor: 's=abc;i=10' }),
    ]);

    assert.equal(mod.getCursor(), 's=abc;i=10');
  });

  it('tracks metrics', async () => {
    await mod.injectEntries([makeEntry(), makeEntry({ cursor: 's=abc;i=2' })]);

    const metrics = mod.getMetrics();
    assert.equal(metrics.entriesRead, 2);
    assert.equal(metrics.entriesEmitted, 2);
  });

  it('maps priority 0 (emerg) to critical', async () => {
    const events: OpsPilotEvent<LogIngestedPayload>[] = [];
    infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => { events.push(e); });

    await mod.injectEntries([makeEntry({ priority: 0, message: 'Kernel panic' })]);
    await sleep(10);

    const meta = events[0].payload.metadata as Record<string, unknown>;
    assert.equal(meta.opsSeverity, 'critical');
  });
});
