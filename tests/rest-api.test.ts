// ---------------------------------------------------------------------------
// OpsPilot — ui.api REST API Module Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RestApiModule, ApiDependencies } from '../src/modules/ui.api/index';
import { ModuleContext, ModuleHealth } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { ToolRegistry } from '../src/core/openclaw/ToolRegistry';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

let portCounter = 19000;

function getPort(): number {
  return portCounter++;
}

function buildContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'ui.api',
    config: {
      host: '127.0.0.1',
      port: getPort(),
      basePath: '/api',
      corsOrigin: '*',
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'ui.api'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function buildDeps(infra: ReturnType<typeof createTestInfra>): ApiDependencies {
  const toolRegistry = new ToolRegistry(
    infra.approvalGate,
    infra.audit,
    infra.logger,
  );

  return {
    storage: infra.storage,
    approvalGate: infra.approvalGate,
    auditLogger: infra.audit,
    toolRegistry,
    getModuleHealths: () => ({
      'test.module': {
        status: 'healthy' as const,
        message: undefined,
        details: {},
        lastCheck: new Date(),
      },
    }),
  };
}

async function httpGet(
  port: number,
  path: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        resolve({ status: res.statusCode!, body });
      });
    });
    req.on('error', reject);
  });
}

async function httpPost(
  port: number,
  path: string,
  data: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const jsonData = JSON.stringify(data);
    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(jsonData),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          resolve({ status: res.statusCode!, body });
        });
      },
    );
    req.on('error', reject);
    req.write(jsonData);
    req.end();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ui.api REST API Module', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let api: RestApiModule;
  let port: number;

  beforeEach(() => {
    infra = createTestInfra();
    api = new RestApiModule();
  });

  afterEach(async () => {
    try {
      await api.stop();
    } catch { /* may not have started */ }
    try {
      await api.destroy();
    } catch { /* may not have initialized */ }
  });

  // ── Initialization ───────────────────────────────────────────────────

  it('should initialize with default config', async () => {
    const ctx = buildContext(infra);
    await api.initialize(ctx);

    const health = api.health();
    assert.strictEqual(health.status, 'healthy');
    assert.strictEqual(health.details?.requestCount, 0);
  });

  it('should start and stop the HTTP server', async () => {
    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    assert.ok(api.getServer()?.listening);

    await api.stop();
    assert.strictEqual(api.getServer(), null);
  });

  // ── Health Endpoint ──────────────────────────────────────────────────

  it('GET /api/health should return system health', async () => {
    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/health');

    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'healthy');
    assert.ok(body.timestamp);
    assert.ok(typeof body.uptime === 'number');
    assert.ok(body.modules['test.module']);
    assert.strictEqual(body.modules['test.module'].status, 'healthy');
  });

  // ── Incidents ────────────────────────────────────────────────────────

  it('GET /api/incidents should return empty list initially', async () => {
    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/incidents');

    assert.strictEqual(status, 200);
    assert.strictEqual(body.count, 0);
    assert.deepStrictEqual(body.incidents, []);
  });

  it('GET /api/incidents should list stored incidents', async () => {
    // Seed an incident into storage
    await infra.storage.set('incidents', 'inc-1', {
      id: 'inc-1',
      title: 'Test Incident',
      description: 'A test',
      severity: 'critical',
      status: 'open',
      detectedBy: 'test',
      createdAt: new Date().toISOString(),
      enrichments: {},
      timeline: [],
    });

    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/incidents');

    assert.strictEqual(status, 200);
    assert.strictEqual(body.count, 1);
    assert.strictEqual(body.incidents[0].id, 'inc-1');
    assert.strictEqual(body.incidents[0].severity, 'critical');
  });

  it('GET /api/incidents should filter by severity', async () => {
    await infra.storage.set('incidents', 'inc-1', {
      id: 'inc-1', severity: 'critical', status: 'open',
      title: 'A', description: '', detectedBy: 'test',
      createdAt: new Date().toISOString(), enrichments: {}, timeline: [],
    });
    await infra.storage.set('incidents', 'inc-2', {
      id: 'inc-2', severity: 'warning', status: 'open',
      title: 'B', description: '', detectedBy: 'test',
      createdAt: new Date().toISOString(), enrichments: {}, timeline: [],
    });

    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { body } = await httpGet(port, '/api/incidents?severity=critical');
    assert.strictEqual(body.count, 1);
    assert.strictEqual(body.incidents[0].id, 'inc-1');
  });

  it('GET /api/incidents should filter by status', async () => {
    await infra.storage.set('incidents', 'inc-1', {
      id: 'inc-1', severity: 'critical', status: 'open',
      title: 'A', description: '', detectedBy: 'test',
      createdAt: new Date().toISOString(), enrichments: {}, timeline: [],
    });
    await infra.storage.set('incidents', 'inc-2', {
      id: 'inc-2', severity: 'warning', status: 'resolved',
      title: 'B', description: '', detectedBy: 'test',
      createdAt: new Date().toISOString(), enrichments: {}, timeline: [],
    });

    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { body } = await httpGet(port, '/api/incidents?status=resolved');
    assert.strictEqual(body.count, 1);
    assert.strictEqual(body.incidents[0].id, 'inc-2');
  });

  it('GET /api/incidents should respect limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await infra.storage.set('incidents', `inc-${i}`, {
        id: `inc-${i}`, severity: 'info', status: 'open',
        title: `Incident ${i}`, description: '', detectedBy: 'test',
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
        enrichments: {}, timeline: [],
      });
    }

    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { body } = await httpGet(port, '/api/incidents?limit=2');
    assert.strictEqual(body.count, 2);
  });

  it('GET /api/incidents/:id should return single incident', async () => {
    await infra.storage.set('incidents', 'inc-42', {
      id: 'inc-42', title: 'Specific', description: 'Details',
      severity: 'warning', status: 'open', detectedBy: 'test',
      createdAt: new Date().toISOString(), enrichments: {}, timeline: [],
    });

    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/incidents/inc-42');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.id, 'inc-42');
    assert.strictEqual(body.title, 'Specific');
  });

  it('GET /api/incidents/:id should return 404 for missing', async () => {
    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/incidents/nonexistent');
    assert.strictEqual(status, 404);
    assert.ok(body.error.includes('not found'));
  });

  // ── Approvals ────────────────────────────────────────────────────────

  it('GET /api/approvals/pending should return pending requests', async () => {
    // Seed a pending approval request
    await infra.storage.set('system::approval_requests', 'req-1', {
      id: 'req-1',
      actionType: 'restart.service',
      description: 'Restart app',
      reasoning: 'Service is down',
      requestedBy: 'action.safe',
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });

    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/approvals/pending');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.count, 1);
    assert.strictEqual(body.requests[0].id, 'req-1');
  });

  it('POST /api/approvals/:id/approve should approve request', async () => {
    // Create a real approval request through the gate
    const request = await infra.approvalGate.requestApproval({
      actionType: 'restart.service',
      description: 'Restart app',
      reasoning: 'Service is down',
      requestedBy: 'action.safe',
    });

    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpPost(
      port,
      `/api/approvals/${request.id}/approve`,
      { approvedBy: 'admin' },
    );

    assert.strictEqual(status, 200);
    assert.strictEqual(body.message, 'Approved');
    assert.ok(body.token.id);
  });

  it('POST /api/approvals/:id/deny should deny request', async () => {
    const request = await infra.approvalGate.requestApproval({
      actionType: 'restart.service',
      description: 'Restart app',
      reasoning: 'Service is down',
      requestedBy: 'action.safe',
    });

    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpPost(
      port,
      `/api/approvals/${request.id}/deny`,
      { deniedBy: 'admin', reason: 'Not needed' },
    );

    assert.strictEqual(status, 200);
    assert.strictEqual(body.message, 'Denied');
  });

  // ── Audit ────────────────────────────────────────────────────────────

  it('GET /api/audit should return audit entries', async () => {
    await infra.audit.log({
      action: 'test.action',
      actor: 'test-user',
      details: { key: 'value' },
    });

    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/audit');
    assert.strictEqual(status, 200);
    assert.ok(body.count >= 1);
    assert.ok(body.entries.some((e: any) => e.action === 'test.action'));
  });

  it('GET /api/audit should filter by action', async () => {
    await infra.audit.log({ action: 'alpha', actor: 'a' });
    await infra.audit.log({ action: 'beta', actor: 'b' });

    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { body } = await httpGet(port, '/api/audit?action=alpha');
    assert.ok(body.entries.every((e: any) => e.action === 'alpha'));
  });

  // ── Tools ────────────────────────────────────────────────────────────

  it('GET /api/tools should return registered tools', async () => {
    const deps = buildDeps(infra);

    deps.toolRegistry.register(
      {
        name: 'test.tool',
        description: 'A test tool',
        registeredBy: 'test',
        inputSchema: { type: 'object' },
        requiresApproval: false,
        tags: ['test'],
      },
      async () => ({ success: true }),
    );

    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(deps);
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/tools');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.count, 1);
    assert.strictEqual(body.tools[0].name, 'test.tool');
    assert.strictEqual(body.tools[0].requiresApproval, false);
  });

  // ── 404 ──────────────────────────────────────────────────────────────

  it('should return 404 for unknown routes', async () => {
    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/unknown');
    assert.strictEqual(status, 404);
    assert.ok(body.error === 'Not found');
  });

  // ── CORS ─────────────────────────────────────────────────────────────

  it('should include CORS headers in responses', async () => {
    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const result = await new Promise<{ headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        resolve({ headers: res.headers });
      }).on('error', reject);
    });

    assert.strictEqual(result.headers['access-control-allow-origin'], '*');
  });

  // ── Metrics ──────────────────────────────────────────────────────────

  it('should track request count', async () => {
    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    await httpGet(port, '/api/health');
    await httpGet(port, '/api/health');

    const health = api.health();
    assert.strictEqual(health.details?.requestCount, 2);
    assert.strictEqual(health.details?.errorCount, 0);
  });

  // ── Module lifecycle ─────────────────────────────────────────────────

  it('manifest should have correct properties', () => {
    assert.strictEqual(api.manifest.id, 'ui.api');
    assert.strictEqual(api.manifest.type, 'ui');
    assert.strictEqual(api.manifest.version, '0.1.0');
  });
});
