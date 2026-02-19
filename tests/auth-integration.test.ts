// ---------------------------------------------------------------------------
// OpsPilot — REST API Authentication Integration Tests
// ---------------------------------------------------------------------------
// Tests that the auth middleware correctly guards API endpoints when
// auth is enabled, and passes through when disabled.
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RestApiModule, ApiDependencies } from '../src/modules/ui.api/index';
import { ModuleContext, ModuleHealth } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { ToolRegistry } from '../src/core/openclaw/ToolRegistry';
import { AuthService } from '../src/core/security/AuthService';
import { AuthConfig } from '../src/core/types/auth';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

let portCounter = 21000;
function getPort(): number { return portCounter++; }

const TEST_SECRET = 'test-jwt-secret-for-auth-integration';

function makeAuthService(overrides: Partial<AuthConfig> = {}): AuthService {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  return new AuthService(
    {
      enabled: true,
      jwtSecret: TEST_SECRET,
      jwtExpiresIn: '1h',
      jwtIssuer: 'opspilot',
      apiKeys: [
        { label: 'test-key', key: 'sk-test-api-key', role: 'admin' },
      ],
      publicPaths: ['/api/health'],
      ...overrides,
    },
    logger as any,
  );
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

function buildDeps(
  infra: ReturnType<typeof createTestInfra>,
  authService?: AuthService,
): ApiDependencies {
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
    authService,
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

async function httpRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? 'GET';
    const jsonData = options.body ? JSON.stringify(options.body) : undefined;
    const reqHeaders: Record<string, string> = { ...options.headers };
    if (jsonData) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = String(Buffer.byteLength(jsonData));
    }

    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      { method, headers: reqHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body;
          try { body = JSON.parse(raw); } catch { body = raw; }
          resolve({ status: res.statusCode!, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (jsonData) req.write(jsonData);
    req.end();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('REST API Authentication', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let api: RestApiModule;
  let port: number;

  afterEach(async () => {
    if (api) {
      try { await api.stop(); } catch { /* ignore */ }
      try { await api.destroy(); } catch { /* ignore */ }
    }
  });

  // ── Auth Disabled (default) ──────────────────────────────────────────────

  describe('auth disabled (default)', () => {
    beforeEach(async () => {
      infra = createTestInfra();
      api = new RestApiModule();
      const ctx = buildContext(infra);
      port = ctx.config.port as number;
      api.setDependencies(buildDeps(infra)); // no authService
      await api.initialize(ctx);
      await api.start();
      await sleep(50);
    });

    it('should allow unauthenticated access to /api/health', async () => {
      const res = await httpRequest(port, '/api/health');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.status);
    });

    it('should allow unauthenticated access to /api/incidents', async () => {
      const res = await httpRequest(port, '/api/incidents');
      assert.strictEqual(res.status, 200);
    });

    it('should allow unauthenticated access to /api/audit', async () => {
      const res = await httpRequest(port, '/api/audit');
      assert.strictEqual(res.status, 200);
    });

    it('should allow unauthenticated access to /api/tools', async () => {
      const res = await httpRequest(port, '/api/tools');
      assert.strictEqual(res.status, 200);
    });
  });

  // ── Auth Enabled ─────────────────────────────────────────────────────────

  describe('auth enabled', () => {
    let authService: AuthService;

    beforeEach(async () => {
      infra = createTestInfra();
      authService = makeAuthService();
      api = new RestApiModule();
      const ctx = buildContext(infra);
      port = ctx.config.port as number;
      api.setDependencies(buildDeps(infra, authService));
      await api.initialize(ctx);
      await api.start();
      await sleep(50);
    });

    // ── Public paths pass through ──────────────────────────────────────────

    it('should allow unauthenticated access to public path /api/health', async () => {
      const res = await httpRequest(port, '/api/health');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.status);
    });

    // ── Protected paths reject without credentials ─────────────────────────

    it('should reject unauthenticated access to /api/incidents with 401', async () => {
      const res = await httpRequest(port, '/api/incidents');
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Unauthorized');
    });

    it('should reject unauthenticated access to /api/audit with 401', async () => {
      const res = await httpRequest(port, '/api/audit');
      assert.strictEqual(res.status, 401);
    });

    it('should reject unauthenticated access to /api/tools with 401', async () => {
      const res = await httpRequest(port, '/api/tools');
      assert.strictEqual(res.status, 401);
    });

    it('should reject unauthenticated access to /api/approvals/pending with 401', async () => {
      const res = await httpRequest(port, '/api/approvals/pending');
      assert.strictEqual(res.status, 401);
    });

    // ── JWT Bearer authentication ──────────────────────────────────────────

    it('should accept valid JWT Bearer token', async () => {
      const token = authService.issueJwt('test-user', 'admin');
      assert.ok(token);

      const res = await httpRequest(port, '/api/incidents', {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 200);
    });

    it('should accept valid JWT for POST endpoints', async () => {
      // Create an approval request first
      const approval = await infra.approvalGate.requestApproval({
        actionType: 'test.action',
        description: 'Test action',
        reasoning: 'Testing auth',
        requestedBy: 'test',
      });

      const token = authService.issueJwt('approver', 'operator');
      assert.ok(token);

      const res = await httpRequest(port, `/api/approvals/${approval.id}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { approvedBy: 'approver' },
      });
      assert.strictEqual(res.status, 200);
    });

    it('should reject invalid JWT', async () => {
      const res = await httpRequest(port, '/api/incidents', {
        headers: { Authorization: 'Bearer invalid.jwt.token' },
      });
      assert.strictEqual(res.status, 401);
    });

    it('should reject JWT with wrong secret', async () => {
      const jwt = await import('jsonwebtoken');
      const badToken = jwt.default.sign(
        { sub: 'user', role: 'admin' },
        'wrong-secret',
        { issuer: 'opspilot', algorithm: 'HS256' },
      );

      const res = await httpRequest(port, '/api/incidents', {
        headers: { Authorization: `Bearer ${badToken}` },
      });
      assert.strictEqual(res.status, 401);
    });

    // ── API Key authentication ─────────────────────────────────────────────

    it('should accept valid X-API-Key', async () => {
      const res = await httpRequest(port, '/api/incidents', {
        headers: { 'X-API-Key': 'sk-test-api-key' },
      });
      assert.strictEqual(res.status, 200);
    });

    it('should reject invalid X-API-Key', async () => {
      const res = await httpRequest(port, '/api/incidents', {
        headers: { 'X-API-Key': 'sk-wrong-key' },
      });
      assert.strictEqual(res.status, 401);
    });

    // ── CORS ───────────────────────────────────────────────────────────────

    it('should include X-API-Key in CORS allowed headers', async () => {
      const res = await httpRequest(port, '/api/incidents', {
        method: 'OPTIONS',
      });
      assert.strictEqual(res.status, 204);
      const allowHeaders = res.headers['access-control-allow-headers'];
      assert.ok(allowHeaders);
      assert.ok(String(allowHeaders).includes('X-API-Key'));
    });

    it('should allow OPTIONS preflight without auth', async () => {
      const res = await httpRequest(port, '/api/incidents', {
        method: 'OPTIONS',
      });
      assert.strictEqual(res.status, 204);
    });

    // ── Mixed auth methods ─────────────────────────────────────────────────

    it('should fall back to API key when JWT is invalid', async () => {
      const res = await httpRequest(port, '/api/incidents', {
        headers: {
          Authorization: 'Bearer invalid.jwt.here',
          'X-API-Key': 'sk-test-api-key',
        },
      });
      assert.strictEqual(res.status, 200);
    });
  });

  // ── Auth enabled with no valid credentials ───────────────────────────────

  describe('auth enabled with no credentials configured', () => {
    beforeEach(async () => {
      infra = createTestInfra();
      const authService = makeAuthService({
        jwtSecret: undefined,
        apiKeys: [],
      });
      api = new RestApiModule();
      const ctx = buildContext(infra);
      port = ctx.config.port as number;
      api.setDependencies(buildDeps(infra, authService));
      await api.initialize(ctx);
      await api.start();
      await sleep(50);
    });

    it('should reject all non-public requests when no auth methods configured', async () => {
      const res = await httpRequest(port, '/api/incidents');
      assert.strictEqual(res.status, 401);
    });

    it('should still allow public paths', async () => {
      const res = await httpRequest(port, '/api/health');
      assert.strictEqual(res.status, 200);
    });
  });
});
