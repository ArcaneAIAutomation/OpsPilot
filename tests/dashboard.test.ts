// ---------------------------------------------------------------------------
// OpsPilot — ui.dashboard Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DashboardModule, DashboardEvent } from '../src/modules/ui.dashboard/index';
import { ModuleContext, ModuleType, ModuleHealth } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { OpsPilotEvent } from '../src/core/types/events';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function dashboardContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'ui.dashboard',
    config: {
      host: '127.0.0.1',
      port: 0,           // random OS port
      title: 'Test Dashboard',
      refreshIntervalMs: 5000,
      maxRecentEvents: 50,
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'ui.dashboard'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function makeEvent(type: string = 'incident.created', source: string = 'test'): OpsPilotEvent {
  return {
    type,
    source,
    timestamp: new Date(),
    payload: { msg: `Event of type ${type}` },
  };
}

/** Fetch helper for the dashboard HTTP server. */
async function fetchDashboard(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function getPort(dashboard: DashboardModule): number {
  const srv = dashboard.getServer();
  const addr = srv?.address();
  if (typeof addr === 'object' && addr !== null) return addr.port;
  throw new Error('Server not running or port unknown');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ui.dashboard', () => {
  let dashboard: DashboardModule;
  let infra: ReturnType<typeof createTestInfra>;

  beforeEach(() => {
    infra = createTestInfra();
    dashboard = new DashboardModule();
  });

  afterEach(async () => {
    try { await dashboard.stop(); } catch {}
    try { await dashboard.destroy(); } catch {}
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  describe('Lifecycle', () => {
    it('exposes correct manifest', () => {
      assert.equal(dashboard.manifest.id, 'ui.dashboard');
      assert.equal(dashboard.manifest.type, ModuleType.UIExtension);
      assert.equal(dashboard.manifest.version, '1.0.0');
      assert.ok(dashboard.manifest.configSchema);
    });

    it('initializes with config', async () => {
      await dashboard.initialize(dashboardContext(infra));
      const cfg = dashboard.getConfig();
      assert.equal(cfg.host, '127.0.0.1');
      assert.equal(cfg.title, 'Test Dashboard');
      assert.equal(cfg.maxRecentEvents, 50);
    });

    it('applies defaults for optional fields', async () => {
      await dashboard.initialize(dashboardContext(infra, {
        title: undefined,
        refreshIntervalMs: undefined,
        maxRecentEvents: undefined,
      }));
      const cfg = dashboard.getConfig();
      assert.equal(cfg.title, 'OpsPilot Dashboard');
      assert.equal(cfg.refreshIntervalMs, 10000);
      assert.equal(cfg.maxRecentEvents, 100);
    });

    it('reports unhealthy before start', async () => {
      await dashboard.initialize(dashboardContext(infra));
      const h = dashboard.health();
      assert.equal(h.status, 'unhealthy');
    });
  });

  // ── HTTP Endpoints ───────────────────────────────────────────────────

  describe('HTTP Endpoints', () => {
    beforeEach(async () => {
      await dashboard.initialize(dashboardContext(infra));
      await dashboard.start();
    });

    it('serves HTML dashboard at /', async () => {
      const port = getPort(dashboard);
      const res = await fetchDashboard(port, '/');
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('<!DOCTYPE html>'));
      assert.ok(res.body.includes('Test Dashboard'));
    });

    it('serves JSON status at /api/status', async () => {
      const port = getPort(dashboard);
      const res = await fetchDashboard(port, '/api/status');
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(typeof data.uptime, 'number');
      assert.ok(data.modules);
      assert.equal(typeof data.eventsReceived, 'number');
    });

    it('serves JSON events at /api/events', async () => {
      // Inject an event first
      dashboard.injectEvent(makeEvent('incident.created'));
      const port = getPort(dashboard);
      const res = await fetchDashboard(port, '/api/events');
      assert.equal(res.status, 200);
      const events = JSON.parse(res.body);
      assert.ok(Array.isArray(events));
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'incident.created');
    });

    it('serves JSON modules at /api/modules', async () => {
      dashboard.setDependencies({
        getModuleHealths: () => ({
          'connector.fileTail': { status: 'healthy', lastCheck: new Date() },
          'detector.threshold': { status: 'degraded', message: 'High load', lastCheck: new Date() },
        }),
      });

      const port = getPort(dashboard);
      const res = await fetchDashboard(port, '/api/modules');
      assert.equal(res.status, 200);
      const mods = JSON.parse(res.body);
      assert.equal(mods['connector.fileTail'].status, 'healthy');
      assert.equal(mods['detector.threshold'].status, 'degraded');
    });

    it('returns 404 for unknown paths', async () => {
      const port = getPort(dashboard);
      const res = await fetchDashboard(port, '/nonexistent');
      assert.equal(res.status, 404);
    });

    it('reports healthy when server is running', async () => {
      const h = dashboard.health();
      assert.equal(h.status, 'healthy');
      assert.ok(h.details);
      assert.equal(typeof h.details!.requestCount, 'number');
    });
  });

  // ── Event Buffer ─────────────────────────────────────────────────────

  describe('Event Buffer', () => {
    beforeEach(async () => {
      await dashboard.initialize(dashboardContext(infra, { maxRecentEvents: 5 }));
    });

    it('stores injected events in newest-first order', () => {
      dashboard.injectEvent(makeEvent('first'));
      dashboard.injectEvent(makeEvent('second'));
      const events = dashboard.getRecentEvents();
      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'second');
      assert.equal(events[1].type, 'first');
    });

    it('caps buffer at maxRecentEvents', () => {
      for (let i = 0; i < 10; i++) {
        dashboard.injectEvent(makeEvent(`event.${i}`));
      }
      const events = dashboard.getRecentEvents();
      assert.equal(events.length, 5); // max is 5
      assert.equal(events[0].type, 'event.9');
    });

    it('receives events from the bus after start', async () => {
      await dashboard.start();
      infra.bus.publish(makeEvent('incident.created'));
      await sleep(30);
      const events = dashboard.getRecentEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'incident.created');

      const m = dashboard.getMetrics();
      assert.equal(m.eventsReceived, 1);
    });

    it('clears buffer on destroy', async () => {
      dashboard.injectEvent(makeEvent('test'));
      assert.equal(dashboard.getRecentEvents().length, 1);
      await dashboard.destroy();
      assert.equal(dashboard.getRecentEvents().length, 0);
    });
  });

  // ── HTML Rendering ───────────────────────────────────────────────────

  describe('HTML Rendering', () => {
    beforeEach(async () => {
      await dashboard.initialize(dashboardContext(infra));
    });

    it('renders valid HTML with configured title', () => {
      const html = dashboard.renderDashboardHtml();
      assert.ok(html.includes('<!DOCTYPE html>'));
      assert.ok(html.includes('<title>Test Dashboard</title>'));
      assert.ok(html.includes('auto-refreshes every'));
    });

    it('escapes title to prevent XSS', async () => {
      await dashboard.initialize(dashboardContext(infra, {
        title: '<script>alert("xss")</script>',
      }));
      const html = dashboard.renderDashboardHtml();
      assert.ok(!html.includes('<script>alert'));
      assert.ok(html.includes('&lt;script&gt;'));
    });

    it('includes refresh interval in script', () => {
      const html = dashboard.renderDashboardHtml();
      assert.ok(html.includes('5000')); // refreshIntervalMs from config
    });
  });

  // ── New API Endpoints ────────────────────────────────────────────────

  describe('New API Endpoints', () => {
    beforeEach(async () => {
      dashboard.setDependencies({
        getModuleHealths: () => ({
          'connector.fileTail': { status: 'healthy', lastCheck: new Date() },
          'detector.regex': { status: 'healthy', lastCheck: new Date() },
          'enricher.aiSummary': { status: 'healthy', lastCheck: new Date() },
        }),
      });
      await dashboard.initialize(dashboardContext(infra));
      await dashboard.start();
    });

    it('serves config summary at /api/config/current', async () => {
      const port = getPort(dashboard);
      const res = await fetchDashboard(port, '/api/config/current');
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.ok(data.system);
      assert.equal(typeof data.system.platform, 'string');
      assert.equal(typeof data.system.nodeVersion, 'string');
      assert.equal(typeof data.system.cpus, 'number');
      assert.ok(data.system.memory);
      assert.equal(typeof data.system.memory.usedPct, 'number');
      assert.ok(data.storage);
      assert.ok(data.auth);
      assert.equal(typeof data.auth.enabled, 'boolean');
      assert.ok(data.modules);
      assert.equal(typeof data.modules.total, 'number');
    });

    it('serves environment detection at /api/config/env', async () => {
      const port = getPort(dashboard);
      const res = await fetchDashboard(port, '/api/config/env');
      assert.equal(res.status, 200);
      const envVars = JSON.parse(res.body);
      assert.ok(Array.isArray(envVars));
      assert.ok(envVars.length > 0);
      // Each entry has name, set, purpose, category
      const first = envVars[0];
      assert.equal(typeof first.name, 'string');
      assert.equal(typeof first.set, 'boolean');
      assert.equal(typeof first.purpose, 'string');
      assert.equal(typeof first.category, 'string');
    });

    it('serves topology at /api/topology', async () => {
      const port = getPort(dashboard);
      const res = await fetchDashboard(port, '/api/topology');
      assert.equal(res.status, 200);
      const topo = JSON.parse(res.body);
      assert.ok(Array.isArray(topo));
      // Should have entries for the modules we set in deps
      assert.ok(topo.length >= 1);
      const node = topo[0];
      assert.ok(node.id);
      assert.ok(node.type);
      assert.ok(node.status);
      assert.ok(node.events);
      assert.ok(Array.isArray(node.events.publishes));
      assert.ok(Array.isArray(node.events.subscribes));
    });

    it('serves setup checklist at /api/setup', async () => {
      const port = getPort(dashboard);
      const res = await fetchDashboard(port, '/api/setup');
      assert.equal(res.status, 200);
      const items = JSON.parse(res.body);
      assert.ok(Array.isArray(items));
      assert.ok(items.length > 0);
      // Verify enhanced checklist format
      const item = items[0];
      assert.ok(item.id);
      assert.ok(item.label);
      assert.ok(item.category);
      assert.ok(item.impact);
      assert.ok(['done', 'stub', 'missing'].includes(item.status));
    });

    it('serves setup HTML at /setup', async () => {
      const port = getPort(dashboard);
      const res = await fetchDashboard(port, '/setup');
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('<!DOCTYPE html>'));
      assert.ok(res.body.includes('Configuration'));
      assert.ok(res.body.includes('Auto-Detection'));
    });
  });

  // ── Setup Checklist ──────────────────────────────────────────────────

  describe('Setup Checklist', () => {
    it('includes core items always marked done', async () => {
      dashboard.setDependencies({ getModuleHealths: () => ({}) });
      await dashboard.initialize(dashboardContext(infra));

      const items = dashboard.buildSetupChecklist();
      const core = items.find((i) => i.id === 'core');
      assert.ok(core);
      assert.equal(core!.status, 'done');
      assert.equal(core!.category, 'core');
      assert.equal(core!.impact, 'critical');

      const safety = items.find((i) => i.id === 'safety');
      assert.ok(safety);
      assert.equal(safety!.status, 'done');
    });

    it('marks auth as missing when not enabled', async () => {
      dashboard.setDependencies({ getModuleHealths: () => ({}) });
      await dashboard.initialize(dashboardContext(infra));

      const items = dashboard.buildSetupChecklist();
      const auth = items.find((i) => i.id === 'auth');
      assert.ok(auth);
      assert.equal(auth!.status, 'missing');
      assert.equal(auth!.category, 'infra');
      assert.ok(auth!.envVars);
      assert.ok(auth!.envVars!.includes('OPSPILOT_JWT_SECRET'));
    });

    it('populates config paths and env vars', async () => {
      dashboard.setDependencies({
        getModuleHealths: () => ({
          'enricher.aiSummary': { status: 'healthy', lastCheck: new Date() },
        }),
      });
      await dashboard.initialize(dashboardContext(infra));

      const items = dashboard.buildSetupChecklist();
      const llm = items.find((i) => i.id === 'llm');
      assert.ok(llm);
      assert.ok(llm!.configPath);
      assert.ok(llm!.envVars);
      assert.ok(llm!.envVars!.includes('OPENAI_API_KEY'));
    });
  });
});
