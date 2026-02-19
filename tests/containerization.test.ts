// ---------------------------------------------------------------------------
// OpsPilot — Containerization & CI Tests (Phase 30)
// ---------------------------------------------------------------------------
// Validates:
//   1. Dockerfile structure and best practices
//   2. docker-compose.yml service configuration
//   3. .dockerignore completeness
//   4. GitHub Actions CI workflow structure
//   5. Liveness (/api/livez) and readiness (/api/readyz) probe endpoints
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { RestApiModule, ApiDependencies } from '../src/modules/ui.api/index';
import { ModuleContext, ModuleHealth } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { ToolRegistry } from '../src/core/openclaw/ToolRegistry';
import { createTestInfra, sleep } from './helpers';

// ── Project Root ───────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');

// ── HTTP Helper ────────────────────────────────────────────────────────────

let portCounter = 21000;
function getPort(): number {
  return portCounter++;
}

async function httpGet(
  port: number,
  urlPath: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
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
  overrides?: Partial<ApiDependencies>,
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
    getModuleHealths: () => ({
      'test.module': {
        status: 'healthy' as const,
        message: undefined,
        details: {},
        lastCheck: new Date(),
      },
    }),
    ...overrides,
  };
}

// ── Dockerfile Tests ───────────────────────────────────────────────────────

describe('Dockerfile', () => {
  const dockerfilePath = path.join(ROOT, 'Dockerfile');
  let content: string;

  beforeEach(() => {
    content = fs.readFileSync(dockerfilePath, 'utf-8');
  });

  it('should exist in project root', () => {
    assert.ok(fs.existsSync(dockerfilePath));
  });

  it('should use multi-stage build', () => {
    const fromCount = (content.match(/^FROM /gm) || []).length;
    assert.ok(fromCount >= 2, `Expected ≥2 FROM stages, got ${fromCount}`);
  });

  it('should use node:20-alpine as base', () => {
    assert.ok(content.includes('node:20-alpine'));
  });

  it('should run as non-root user', () => {
    assert.ok(content.includes('USER opspilot') || content.includes('USER node'));
  });

  it('should expose ports 3000, 3001, 3002', () => {
    assert.ok(content.includes('EXPOSE 3000'));
    assert.ok(content.includes('3001'));
    assert.ok(content.includes('3002'));
  });

  it('should include a HEALTHCHECK instruction', () => {
    assert.ok(content.includes('HEALTHCHECK'));
  });

  it('should set NODE_ENV=production', () => {
    assert.ok(content.includes('NODE_ENV=production'));
  });

  it('should copy package.json before source for layer caching', () => {
    const pkgIdx = content.indexOf('COPY package.json');
    const srcIdx = content.indexOf('COPY src/');
    assert.ok(pkgIdx < srcIdx, 'package.json should be copied before src/');
  });

  it('should prune dev dependencies', () => {
    assert.ok(content.includes('npm prune --production'));
  });
});

// ── docker-compose.yml Tests ───────────────────────────────────────────────

describe('docker-compose.yml', () => {
  const composePath = path.join(ROOT, 'docker-compose.yml');
  let content: string;

  beforeEach(() => {
    content = fs.readFileSync(composePath, 'utf-8');
  });

  it('should exist in project root', () => {
    assert.ok(fs.existsSync(composePath));
  });

  it('should define the opspilot service', () => {
    assert.ok(content.includes('opspilot'));
  });

  it('should map all three ports', () => {
    assert.ok(content.includes('3000:3000'));
    assert.ok(content.includes('3001:3001'));
    assert.ok(content.includes('3002:3002'));
  });

  it('should define a persistent volume for data', () => {
    assert.ok(content.includes('opspilot-data'));
  });

  it('should include a healthcheck', () => {
    assert.ok(content.includes('healthcheck'));
  });

  it('should set restart policy', () => {
    assert.ok(content.includes('restart'));
  });
});

// ── .dockerignore Tests ────────────────────────────────────────────────────

describe('.dockerignore', () => {
  const ignorePath = path.join(ROOT, '.dockerignore');
  let content: string;

  beforeEach(() => {
    content = fs.readFileSync(ignorePath, 'utf-8');
  });

  it('should exist in project root', () => {
    assert.ok(fs.existsSync(ignorePath));
  });

  it('should exclude node_modules', () => {
    assert.ok(content.includes('node_modules'));
  });

  it('should exclude dist', () => {
    assert.ok(content.includes('dist'));
  });

  it('should exclude tests', () => {
    assert.ok(content.includes('tests'));
  });

  it('should exclude .git', () => {
    assert.ok(content.includes('.git'));
  });
});

// ── GitHub Actions CI Workflow Tests ───────────────────────────────────────

describe('CI Workflow', () => {
  const ciPath = path.join(ROOT, '.github', 'workflows', 'ci.yml');
  let content: string;

  beforeEach(() => {
    content = fs.readFileSync(ciPath, 'utf-8');
  });

  it('should exist at .github/workflows/ci.yml', () => {
    assert.ok(fs.existsSync(ciPath));
  });

  it('should trigger on push and pull_request to main', () => {
    assert.ok(content.includes('push:'));
    assert.ok(content.includes('pull_request:'));
    assert.ok(content.includes('main'));
  });

  it('should run on ubuntu-latest', () => {
    assert.ok(content.includes('ubuntu-latest'));
  });

  it('should test Node.js 20 and 22', () => {
    assert.ok(content.includes('20'));
    assert.ok(content.includes('22'));
  });

  it('should include install, build, and test steps', () => {
    assert.ok(content.includes('npm ci'));
    assert.ok(content.includes('npm run build'));
    assert.ok(content.includes('npm test'));
  });

  it('should include a Docker build job', () => {
    assert.ok(content.includes('docker'));
    assert.ok(content.includes('docker/build-push-action'));
  });

  it('should use actions/checkout@v4', () => {
    assert.ok(content.includes('actions/checkout@v4'));
  });
});

// ── Liveness Probe Endpoint Tests ──────────────────────────────────────────

describe('Liveness Probe (/api/livez)', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let api: RestApiModule;
  let port: number;

  beforeEach(async () => {
    infra = createTestInfra();
    api = new RestApiModule();
    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();
  });

  afterEach(async () => {
    try { await api.stop(); } catch { /* ok */ }
    try { await api.destroy(); } catch { /* ok */ }
  });

  it('should return 200 with status alive', async () => {
    const { status, body } = await httpGet(port, '/api/livez');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'alive');
    assert.ok(body.timestamp);
  });
});

// ── Readiness Probe Endpoint Tests ─────────────────────────────────────────

describe('Readiness Probe (/api/readyz)', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let api: RestApiModule;
  let port: number;

  beforeEach(() => {
    infra = createTestInfra();
    api = new RestApiModule();
  });

  afterEach(async () => {
    try { await api.stop(); } catch { /* ok */ }
    try { await api.destroy(); } catch { /* ok */ }
  });

  it('should return 200 when all modules healthy', async () => {
    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/readyz');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'ready');
  });

  it('should return 503 when any module is unhealthy', async () => {
    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra, {
      getModuleHealths: () => ({
        'test.module': {
          status: 'unhealthy' as const,
          message: 'Database connection lost',
          details: {},
          lastCheck: new Date(),
        },
      }),
    }));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/readyz');
    assert.strictEqual(status, 503);
    assert.strictEqual(body.status, 'not-ready');
  });

  it('should return 200 when modules are degraded but not unhealthy', async () => {
    const ctx = buildContext(infra);
    port = ctx.config.port as number;
    api.setDependencies(buildDeps(infra, {
      getModuleHealths: () => ({
        'test.module': {
          status: 'degraded' as const,
          message: 'Elevated latency',
          details: {},
          lastCheck: new Date(),
        },
      }),
    }));
    await api.initialize(ctx);
    await api.start();

    const { status, body } = await httpGet(port, '/api/readyz');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'ready');
  });
});
