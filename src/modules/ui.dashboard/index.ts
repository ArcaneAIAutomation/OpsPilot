// ---------------------------------------------------------------------------
// OpsPilot — ui.dashboard (HTML Dashboard Module)
// ---------------------------------------------------------------------------
// Serves a self-contained HTML dashboard on a configurable port.
// No external dependencies — all HTML, CSS, and JS are embedded as
// template literals. The dashboard shows:
//   - System overview (module health summary)
//   - Recent events feed (ring buffer, newest first)
//   - Module health cards
//   - JSON API endpoints for programmatic access
//
// The module subscribes to all '*' events via the bus and keeps
// a capped ring buffer of recent events for display.
//
// Endpoints:
//   GET /                     — HTML dashboard page
//   GET /api/status           — JSON system status
//   GET /api/events           — JSON recent events
//   GET /api/modules          — JSON module health map
// ---------------------------------------------------------------------------

import http from 'node:http';
import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { OpsPilotEvent, EventSubscription } from '../../core/types/events';
import configSchema from './schema.json';

// ── Config ─────────────────────────────────────────────────────────────────

interface DashboardConfig {
  host: string;
  port: number;
  title: string;
  refreshIntervalMs: number;
  maxRecentEvents: number;
}

const DEFAULTS: DashboardConfig = {
  host: '0.0.0.0',
  port: 3001,
  title: 'OpsPilot Dashboard',
  refreshIntervalMs: 10_000,
  maxRecentEvents: 100,
};

// ── Dependency contract ────────────────────────────────────────────────────

export interface DashboardDependencies {
  getModuleHealths: () => Record<string, ModuleHealth>;
}

// ── Setup checklist item ───────────────────────────────────────────────────

interface SetupItem {
  id: string;
  label: string;
  status: 'done' | 'stub' | 'missing';
  detail: string;
  guide: string;
}

// ── Stored event entry ─────────────────────────────────────────────────────

export interface DashboardEvent {
  type: string;
  source: string;
  timestamp: string;
  payloadSummary: string;
}

// ── Module Implementation ──────────────────────────────────────────────────

export class DashboardModule implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'ui.dashboard',
    name: 'HTML Dashboard',
    version: '1.0.0',
    type: ModuleType.UIExtension,
    description: 'Self-contained HTML dashboard for operational visibility.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: DashboardConfig;
  private server: http.Server | null = null;
  private deps?: DashboardDependencies;
  // Well-known event types to capture in the feed
  private static readonly FEED_EVENTS = [
    'log.ingested',
    'incident.created',
    'incident.updated',
    'action.proposed',
    'action.approved',
    'action.executed',
    'enrichment.completed',
    'metric.collected',
    'health.changed',
  ];

  // Ring buffer of recent events
  private recentEvents: DashboardEvent[] = [];

  // Subscriptions for each event type
  private subscriptions: EventSubscription[] = [];

  // Metrics
  private requestCount = 0;
  private errorCount = 0;
  private eventsReceived = 0;

  // ── Dependency Injection ─────────────────────────────────────────────────

  setDependencies(deps: DashboardDependencies): void {
    this.deps = deps;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    const raw = context.config as Partial<DashboardConfig>;

    this.config = {
      host: raw.host ?? DEFAULTS.host,
      port: raw.port ?? DEFAULTS.port,
      title: raw.title ?? DEFAULTS.title,
      refreshIntervalMs: raw.refreshIntervalMs ?? DEFAULTS.refreshIntervalMs,
      maxRecentEvents: raw.maxRecentEvents ?? DEFAULTS.maxRecentEvents,
    };

    this.ctx.logger.info('Dashboard initialized', {
      host: this.config.host,
      port: this.config.port,
    });
  }

  async start(): Promise<void> {
    // Subscribe to well-known event types for the feed
    for (const eventType of DashboardModule.FEED_EVENTS) {
      const sub = this.ctx.bus.subscribe(eventType, (event) => {
        this.pushEvent(event);
      });
      this.subscriptions.push(sub);
    }

    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.errorCount++;
          this.ctx.logger.error('Dashboard request error', err instanceof Error ? err : new Error(String(err)));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        });
      });

      this.server.on('error', (err) => {
        this.ctx.logger.error('Dashboard server error', err);
        reject(err);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        this.ctx.logger.info('Dashboard server started', {
          url: `http://${this.config.host}:${this.config.port}/`,
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions = [];

    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.server = null;
          this.ctx.logger.info('Dashboard server stopped', {
            requestsServed: this.requestCount,
          });
          resolve();
        });
      });
    }
  }

  async destroy(): Promise<void> {
    this.recentEvents = [];
  }

  health(): ModuleHealth {
    const isUp = this.server !== null && this.server.listening;
    return {
      status: isUp ? 'healthy' : 'unhealthy',
      message: isUp ? undefined : 'Server not running',
      details: {
        requestCount: this.requestCount,
        errorCount: this.errorCount,
        eventsReceived: this.eventsReceived,
        recentEventsBuffered: this.recentEvents.length,
        port: this.config?.port ?? 0,
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Buffer ─────────────────────────────────────────────────────────

  private pushEvent(event: OpsPilotEvent): void {
    this.eventsReceived++;
    const entry: DashboardEvent = {
      type: event.type,
      source: event.source,
      timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp),
      payloadSummary: JSON.stringify(event.payload).slice(0, 200),
    };

    this.recentEvents.unshift(entry);
    if (this.recentEvents.length > this.config.maxRecentEvents) {
      this.recentEvents.length = this.config.maxRecentEvents;
    }
  }

  /** Inject an event into the buffer for testing. */
  injectEvent(event: OpsPilotEvent): void {
    this.pushEvent(event);
  }

  // ── HTTP Routing ─────────────────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.requestCount++;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === '/' || path === '/index.html') {
      this.serveHtml(res);
    } else if (path === '/setup') {
      this.serveSetupHtml(res);
    } else if (path === '/api/status') {
      this.serveStatus(res);
    } else if (path === '/api/events') {
      this.serveEvents(res);
    } else if (path === '/api/modules') {
      this.serveModules(res);
    } else if (path === '/api/setup') {
      this.serveSetupJson(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  // ── JSON endpoints ───────────────────────────────────────────────────────

  private serveStatus(res: http.ServerResponse): void {
    const moduleHealths = this.deps?.getModuleHealths() ?? {};
    const counts = { healthy: 0, degraded: 0, unhealthy: 0 };
    for (const h of Object.values(moduleHealths)) {
      if (h.status === 'healthy') counts.healthy++;
      else if (h.status === 'degraded') counts.degraded++;
      else counts.unhealthy++;
    }

    const body = {
      uptime: process.uptime(),
      modules: counts,
      eventsReceived: this.eventsReceived,
      recentEventsBuffered: this.recentEvents.length,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  }

  private serveEvents(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.recentEvents, null, 2));
  }

  private serveModules(res: http.ServerResponse): void {
    const moduleHealths = this.deps?.getModuleHealths() ?? {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(moduleHealths, null, 2));
  }

  // ── HTML Dashboard ───────────────────────────────────────────────────────

  private serveHtml(res: http.ServerResponse): void {
    const html = this.renderDashboardHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /** Build the complete self-contained HTML page. Public for testing. */
  renderDashboardHtml(): string {
    const title = this.esc(this.config.title);
    const refreshMs = this.config.refreshIntervalMs;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 16px; }
  h2 { color: #8b949e; font-size: 14px; text-transform: uppercase; margin: 24px 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card-title { font-weight: 600; margin-bottom: 8px; }
  .healthy { border-left: 4px solid #3fb950; }
  .degraded { border-left: 4px solid #d29922; }
  .unhealthy { border-left: 4px solid #f85149; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .badge-healthy { background: #238636; color: #fff; }
  .badge-degraded { background: #9e6a03; color: #fff; }
  .badge-unhealthy { background: #da3633; color: #fff; }
  .stat { font-size: 28px; font-weight: 700; color: #58a6ff; }
  .stat-label { font-size: 12px; color: #8b949e; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 600; }
  .type-incident { color: #f85149; }
  .type-action { color: #d29922; }
  .type-enrichment { color: #3fb950; }
  .type-default { color: #8b949e; }
  #status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
                background: #3fb950; margin-right: 8px; }
  .footer { margin-top: 24px; font-size: 11px; color: #484f58; text-align: center; }
</style>
</head>
<body>
  <h1><span id="status-dot"></span>${title}</h1>
  <div style="margin-bottom:16px;"><a href="/setup" style="color:#58a6ff;text-decoration:none;font-size:13px;">\u2699\ufe0f Setup Status &amp; Production Readiness Checklist \u2192</a></div>

  <div class="grid" id="summary">
    <div class="card">
      <div class="stat" id="s-healthy">-</div>
      <div class="stat-label">Healthy Modules</div>
    </div>
    <div class="card">
      <div class="stat" id="s-degraded">-</div>
      <div class="stat-label">Degraded</div>
    </div>
    <div class="card">
      <div class="stat" id="s-unhealthy">-</div>
      <div class="stat-label">Unhealthy</div>
    </div>
    <div class="card">
      <div class="stat" id="s-events">-</div>
      <div class="stat-label">Events Received</div>
    </div>
  </div>

  <h2>Module Health</h2>
  <div class="grid" id="modules"></div>

  <h2>Recent Events</h2>
  <div class="card" style="overflow-x:auto;">
    <table>
      <thead><tr><th>Time</th><th>Type</th><th>Source</th><th>Summary</th></tr></thead>
      <tbody id="events"></tbody>
    </table>
  </div>

  <div class="footer">OpsPilot Dashboard — auto-refreshes every ${refreshMs / 1000}s</div>

<script>
(function() {
  const REFRESH = ${refreshMs};

  async function fetchJson(url) {
    const r = await fetch(url);
    return r.json();
  }

  function typeClass(type) {
    if (type.startsWith('incident')) return 'type-incident';
    if (type.startsWith('action')) return 'type-action';
    if (type.startsWith('enrichment')) return 'type-enrichment';
    return 'type-default';
  }

  async function refresh() {
    try {
      const [status, modules, events] = await Promise.all([
        fetchJson('/api/status'),
        fetchJson('/api/modules'),
        fetchJson('/api/events'),
      ]);

      document.getElementById('s-healthy').textContent = status.modules.healthy;
      document.getElementById('s-degraded').textContent = status.modules.degraded;
      document.getElementById('s-unhealthy').textContent = status.modules.unhealthy;
      document.getElementById('s-events').textContent = status.eventsReceived;

      // Module cards
      const mc = document.getElementById('modules');
      mc.innerHTML = '';
      for (const [id, h] of Object.entries(modules)) {
        const div = document.createElement('div');
        div.className = 'card ' + h.status;
        div.innerHTML =
          '<div class="card-title">' + id +
          ' <span class="badge badge-' + h.status + '">' + h.status + '</span></div>' +
          (h.message ? '<div style="font-size:12px;color:#f85149;">' + h.message + '</div>' : '');
        mc.appendChild(div);
      }

      // Events table
      const tbody = document.getElementById('events');
      tbody.innerHTML = '';
      for (const ev of events) {
        const tr = document.createElement('tr');
        const ts = new Date(ev.timestamp).toLocaleTimeString();
        tr.innerHTML =
          '<td>' + ts + '</td>' +
          '<td class="' + typeClass(ev.type) + '">' + ev.type + '</td>' +
          '<td>' + ev.source + '</td>' +
          '<td>' + ev.payloadSummary.slice(0, 80) + '</td>';
        tbody.appendChild(tr);
      }

      document.getElementById('status-dot').style.background =
        status.modules.unhealthy > 0 ? '#f85149' :
        status.modules.degraded > 0 ? '#d29922' : '#3fb950';
    } catch (e) {
      console.error('Dashboard refresh failed', e);
    }
  }

  refresh();
  setInterval(refresh, REFRESH);
})();
</script>
</body>
</html>`;
  }

  // ── Setup Status ──────────────────────────────────────────────────────────

  /** Evaluate what's configured, stubbed, and missing. Public for testing. */
  buildSetupChecklist(): SetupItem[] {
    const moduleHealths = this.deps?.getModuleHealths() ?? {};
    const moduleIds = Object.keys(moduleHealths);

    const items: SetupItem[] = [];

    // -- Core systems (always done) --
    items.push({
      id: 'core',
      label: 'Core Architecture',
      status: 'done',
      detail: 'EventBus, config, lifecycle, dependency resolver, audit, approval gate',
      guide: '',
    });
    items.push({
      id: 'safety',
      label: 'Safety Model',
      status: 'done',
      detail: 'Proposals \u2192 approval tokens (15-min TTL) \u2192 gated execution \u2192 audit log',
      guide: '',
    });

    // -- Database --
    // Check if the underlying storage engine is persistent
    const storageInner = (this.ctx?.storage as unknown as { inner?: { constructor: { name: string } } })?.inner;
    const engineName = storageInner?.constructor?.name ?? '';
    const hasPersistentDb = engineName === 'SQLiteStorage' || engineName === 'FileStorage';
    const engineLabel = engineName === 'SQLiteStorage' ? 'SQLite' : engineName === 'FileStorage' ? 'file' : 'memory';
    items.push({
      id: 'database',
      label: 'Persistent Database',
      status: hasPersistentDb ? 'done' : 'missing',
      detail: hasPersistentDb
        ? `Using ${engineLabel} storage engine. Data persists across restarts.`
        : 'Data is stored in-memory (lost on restart). No persistent backend configured.',
      guide: hasPersistentDb
        ? ''
        : 'Set storage.engine to "sqlite" in config with options.dbPath. See README \u2192 Storage Implementation Guide.',
    });

    // -- LLM --
    const aiModule = moduleIds.includes('enricher.aiSummary');
    items.push({
      id: 'llm',
      label: 'LLM Integration',
      status: aiModule ? 'stub' : 'missing',
      detail: aiModule
        ? 'AI Summary module loaded but using template fallback. No real API key configured.'
        : 'enricher.aiSummary module not enabled.',
      guide: 'Set provider to "openai" or "anthropic" in config. Set OPENAI_API_KEY or ANTHROPIC_API_KEY env var. See README \u2192 LLM Integration Guide.',
    });

    // -- Auth --
    items.push({
      id: 'auth',
      label: 'API Authentication',
      status: 'missing',
      detail: 'REST API (ui.api) has no authentication middleware. All endpoints are open.',
      guide: 'Add JWT or API-key middleware to ui.api handleRequest(). See README \u2192 Auth Implementation Guide.',
    });

    // -- Connectors: real vs stubbed --
    const realConnectors = ['connector.fileTail', 'connector.syslog', 'connector.metrics'];
    const stubbedConnectors: Record<string, string> = {
      'connector.kubernetes': 'Simulates K8s API. Needs @kubernetes/client-node SDK.',
      'connector.cloudwatch': 'Simulates CloudWatch. Needs @aws-sdk/client-cloudwatch-logs.',
      'connector.journald': 'Simulates journalctl. Needs real child_process spawn.',
    };

    for (const id of realConnectors) {
      if (moduleIds.includes(id)) {
        items.push({
          id,
          label: id,
          status: 'done',
          detail: 'Real implementation, working end-to-end.',
          guide: '',
        });
      }
    }
    for (const [id, detail] of Object.entries(stubbedConnectors)) {
      if (moduleIds.includes(id)) {
        items.push({ id, label: id, status: 'stub', detail, guide: `Replace simulated API calls in src/modules/${id}/index.ts with real SDK.` });
      }
    }

    // -- Notifiers: all stubbed --
    const stubbedNotifiers: Record<string, string> = {
      'notifier.slack': 'Builds correct payload but uses raw fetch. Needs Slack SDK + OAuth.',
      'notifier.pagerduty': 'Builds correct payload but uses raw fetch. Needs PagerDuty SDK.',
      'notifier.teams': 'Sends Adaptive Cards via webhook. Works for basic use; Graph API for richer features.',
      'notifier.email': 'Builds HTML email with raw SMTP. Needs nodemailer for TLS/auth.',
    };
    for (const [id, detail] of Object.entries(stubbedNotifiers)) {
      if (moduleIds.includes(id)) {
        items.push({ id, label: id, status: 'stub', detail, guide: `Install proper SDK and update src/modules/${id}/index.ts.` });
      }
    }

    // -- Detectors (all real) --
    for (const id of ['detector.regex', 'detector.threshold', 'detector.anomaly']) {
      if (moduleIds.includes(id)) {
        items.push({ id, label: id, status: 'done', detail: 'Real detection logic, fully tested.', guide: '' });
      }
    }

    // -- Containerization --
    items.push({
      id: 'container',
      label: 'Containerization',
      status: 'missing',
      detail: 'No Dockerfile, docker-compose, or Helm chart.',
      guide: 'See README \u2192 Container Guide for ready-to-use Dockerfile and docker-compose.yml.',
    });

    // -- Observability --
    items.push({
      id: 'prometheus',
      label: 'Prometheus Metrics Export',
      status: 'missing',
      detail: 'Modules track internal counters but no /metrics endpoint exists.',
      guide: 'Add a /metrics endpoint to ui.api that collects health().details from all modules. See README \u2192 Observability Guide.',
    });

    // -- Error Recovery --
    items.push({
      id: 'resilience',
      label: 'Error Recovery & Resilience',
      status: 'missing',
      detail: 'No circuit breakers, retry-with-backoff, or dead letter queues.',
      guide: 'Wrap external calls (fetch, DB) in a retry utility with exponential backoff. Add circuit breaker state to connectors and notifiers.',
    });

    return items;
  }

  private serveSetupJson(res: http.ServerResponse): void {
    const checklist = this.buildSetupChecklist();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(checklist, null, 2));
  }

  private serveSetupHtml(res: http.ServerResponse): void {
    const html = this.renderSetupHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /** Build the setup-status HTML page. Public for testing. */
  renderSetupHtml(): string {
    const title = this.esc(this.config.title) + ' — Setup Status';
    const checklist = this.buildSetupChecklist();
    const done = checklist.filter((i) => i.status === 'done').length;
    const stub = checklist.filter((i) => i.status === 'stub').length;
    const missing = checklist.filter((i) => i.status === 'missing').length;
    const total = checklist.length;
    const pct = Math.round((done / total) * 100);

    const rows = checklist.map((item) => {
      const icon = item.status === 'done' ? '\u2705' : item.status === 'stub' ? '\u26a0\ufe0f' : '\u274c';
      const badgeClass = item.status === 'done' ? 'badge-healthy' : item.status === 'stub' ? 'badge-degraded' : 'badge-unhealthy';
      const guideHtml = item.guide
        ? `<div class="guide">${this.esc(item.guide)}</div>`
        : '';
      return `<tr>
        <td>${icon}</td>
        <td><strong>${this.esc(item.label)}</strong></td>
        <td><span class="badge ${badgeClass}">${item.status}</span></td>
        <td>${this.esc(item.detail)}${guideHtml}</td>
      </tr>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: #0d1117; color: #c9d1d9; padding: 20px; max-width: 1000px; margin: 0 auto; }
  h1 { color: #58a6ff; margin-bottom: 8px; }
  .subtitle { color: #8b949e; margin-bottom: 24px; font-size: 14px; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .progress-bar { background: #21262d; border-radius: 8px; height: 24px; margin-bottom: 24px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 8px; background: linear-gradient(90deg, #238636 0%, #3fb950 100%);
                    display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: #fff;
                    min-width: 40px; transition: width 0.3s; }
  .summary { display: flex; gap: 16px; margin-bottom: 24px; }
  .sum-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 20px; flex: 1; text-align: center; }
  .sum-num { font-size: 28px; font-weight: 700; }
  .sum-num.green { color: #3fb950; }
  .sum-num.yellow { color: #d29922; }
  .sum-num.red { color: #f85149; }
  .sum-label { font-size: 12px; color: #8b949e; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { color: #8b949e; font-weight: 600; font-size: 12px; text-transform: uppercase; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-healthy { background: #238636; color: #fff; }
  .badge-degraded { background: #9e6a03; color: #fff; }
  .badge-unhealthy { background: #da3633; color: #fff; }
  .guide { margin-top: 6px; padding: 8px 12px; background: #161b22; border-left: 3px solid #58a6ff;
           border-radius: 4px; font-size: 12px; color: #8b949e; line-height: 1.5; }
  .nav { margin-bottom: 20px; }
  .footer { margin-top: 24px; font-size: 11px; color: #484f58; text-align: center; }
</style>
</head>
<body>
  <div class="nav"><a href="/">\u2190 Back to Dashboard</a></div>
  <h1>${title}</h1>
  <p class="subtitle">Honest assessment of what\u2019s production-ready, what\u2019s stubbed, and what\u2019s missing. Each missing item includes implementation guidance.</p>

  <div class="progress-bar">
    <div class="progress-fill" style="width: ${pct}%">${pct}% production-ready</div>
  </div>

  <div class="summary">
    <div class="sum-card"><div class="sum-num green">${done}</div><div class="sum-label">\u2705 Complete</div></div>
    <div class="sum-card"><div class="sum-num yellow">${stub}</div><div class="sum-label">\u26a0\ufe0f Stubbed</div></div>
    <div class="sum-card"><div class="sum-num red">${missing}</div><div class="sum-label">\u274c Missing</div></div>
  </div>

  <table>
    <thead><tr><th></th><th>Component</th><th>Status</th><th>Details &amp; Guidance</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>

  <div class="footer">
    OpsPilot Setup Status \u2014 see <a href="https://github.com/ArcaneAIAutomation/OpsPilot#project-status">README \u2192 Project Status</a> for full implementation guides
  </div>
</body>
</html>`;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private esc(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getConfig(): DashboardConfig {
    return this.config;
  }

  getRecentEvents(): DashboardEvent[] {
    return this.recentEvents;
  }

  getMetrics(): { requestCount: number; errorCount: number; eventsReceived: number } {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      eventsReceived: this.eventsReceived,
    };
  }

  getServer(): http.Server | null {
    return this.server;
  }
}
