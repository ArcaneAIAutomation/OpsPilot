// ---------------------------------------------------------------------------
// OpsPilot — ui.dashboard (Immersive Configuration & Operations Dashboard)
// ---------------------------------------------------------------------------
// Serves a modern, self-contained HTML dashboard on a configurable port.
// No external dependencies — all HTML, CSS, and JS are embedded as
// template literals. The dashboard features:
//   - Immersive glassmorphism design with animated system topology
//   - Interactive configuration wizard with auto-discovery
//   - Real-time event stream with severity-based filtering
//   - Module health heatmap with drill-down detail
//   - Environment validation & production readiness scoring
//   - Guided setup flow for each module category
//
// Endpoints:
//   GET /                     — HTML dashboard (main operational view)
//   GET /setup                — Interactive configuration wizard
//   GET /api/status           — JSON system status
//   GET /api/events           — JSON recent events
//   GET /api/modules          — JSON module health map
//   GET /api/setup            — JSON setup checklist
//   GET /api/config/current   — JSON current configuration summary
//   GET /api/config/env       — JSON environment variable detection
//   GET /api/topology         — JSON module topology / event flow
// ---------------------------------------------------------------------------

import http from 'node:http';
import os from 'node:os';
import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { OpsPilotEvent, EventSubscription } from '../../core/types/events';
import { IAuthService } from '../../core/types/auth';
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
  authService?: IAuthService;
}

// ── Setup checklist item ───────────────────────────────────────────────────

interface SetupItem {
  id: string;
  label: string;
  category: 'core' | 'connector' | 'detector' | 'enricher' | 'action' | 'notifier' | 'ui' | 'infra';
  status: 'done' | 'stub' | 'missing';
  detail: string;
  guide: string;
  impact: 'critical' | 'high' | 'medium' | 'low';
  envVars?: string[];
  configPath?: string;
}

// ── Environment variable info ──────────────────────────────────────────────

interface EnvVarInfo {
  name: string;
  set: boolean;
  purpose: string;
  category: string;
}

// ── Topology node ──────────────────────────────────────────────────────────

interface TopologyNode {
  id: string;
  type: string;
  status: string;
  events: { publishes: string[]; subscribes: string[] };
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Authentication Gate (for API endpoints only) ───────────────────
    const authService = this.deps?.authService;
    if (authService?.enabled && path.startsWith('/api/')) {
      if (!authService.isPublicPath(path)) {
        const identity = authService.authenticate(
          req.headers as Record<string, string | string[] | undefined>,
        );
        if (!identity) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Unauthorized',
            message: 'Valid Bearer token or X-API-Key required',
          }));
          return;
        }
      }
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
    } else if (path === '/api/config/current') {
      this.serveConfigCurrent(res);
    } else if (path === '/api/config/env') {
      this.serveConfigEnv(res);
    } else if (path === '/api/topology') {
      this.serveTopology(res);
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

  // ── New API endpoints ──────────────────────────────────────────────────

  private serveConfigCurrent(res: http.ServerResponse): void {
    const moduleHealths = this.deps?.getModuleHealths() ?? {};
    const moduleIds = Object.keys(moduleHealths);
    const storageInner = (this.ctx?.storage as unknown as { inner?: { constructor: { name: string } } })?.inner;
    const engineName = storageInner?.constructor?.name ?? 'MemoryStorage';

    const summary = {
      system: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        uptime: process.uptime(),
        memory: {
          total: os.totalmem(),
          free: os.freemem(),
          used: os.totalmem() - os.freemem(),
          usedPct: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
        },
        cpus: os.cpus().length,
        loadAvg: os.loadavg(),
      },
      storage: { engine: engineName },
      auth: { enabled: this.deps?.authService?.enabled ?? false },
      modules: {
        total: moduleIds.length,
        byCategory: this.categorizeModules(moduleIds),
      },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary, null, 2));
  }

  private serveConfigEnv(res: http.ServerResponse): void {
    const envVars = this.detectEnvironmentVars();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(envVars, null, 2));
  }

  private serveTopology(res: http.ServerResponse): void {
    const topology = this.buildTopology();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(topology, null, 2));
  }

  private categorizeModules(ids: string[]): Record<string, string[]> {
    const cats: Record<string, string[]> = {};
    for (const id of ids) {
      const cat = id.split('.')[0];
      if (!cats[cat]) cats[cat] = [];
      cats[cat].push(id);
    }
    return cats;
  }

  private detectEnvironmentVars(): EnvVarInfo[] {
    const defs: Array<{ name: string; purpose: string; category: string }> = [
      { name: 'OPSPILOT_JWT_SECRET', purpose: 'JWT signing secret for API authentication', category: 'auth' },
      { name: 'OPSPILOT_API_KEY', purpose: 'Static API key for service-to-service auth', category: 'auth' },
      { name: 'OPENAI_API_KEY', purpose: 'OpenAI API key for AI summary enrichment', category: 'llm' },
      { name: 'ANTHROPIC_API_KEY', purpose: 'Anthropic API key for AI summary enrichment', category: 'llm' },
      { name: 'SLACK_WEBHOOK_URL', purpose: 'Slack incoming webhook URL for notifications', category: 'notifier' },
      { name: 'PAGERDUTY_ROUTING_KEY', purpose: 'PagerDuty Events API v2 integration key', category: 'notifier' },
      { name: 'TEAMS_WEBHOOK_URL', purpose: 'Microsoft Teams incoming webhook URL', category: 'notifier' },
      { name: 'SMTP_HOST', purpose: 'SMTP server for email notifications', category: 'notifier' },
      { name: 'SMTP_PASSWORD', purpose: 'SMTP password for email notifications', category: 'notifier' },
      { name: 'AWS_ACCESS_KEY_ID', purpose: 'AWS credentials for CloudWatch connector', category: 'connector' },
      { name: 'AWS_SECRET_ACCESS_KEY', purpose: 'AWS credentials for CloudWatch connector', category: 'connector' },
      { name: 'AWS_REGION', purpose: 'AWS region for CloudWatch connector', category: 'connector' },
      { name: 'KUBECONFIG', purpose: 'Kubernetes config path for K8s connector', category: 'connector' },
      { name: 'NODE_ENV', purpose: 'Node.js environment (development/production)', category: 'system' },
    ];

    return defs.map((d) => ({
      ...d,
      set: process.env[d.name] !== undefined && process.env[d.name] !== '',
    }));
  }

  private buildTopology(): TopologyNode[] {
    const moduleHealths = this.deps?.getModuleHealths() ?? {};
    const flow: Record<string, { publishes: string[]; subscribes: string[] }> = {
      'connector.fileTail': { publishes: ['log.ingested'], subscribes: [] },
      'connector.metrics': { publishes: ['log.ingested', 'metric.collected'], subscribes: [] },
      'connector.healthCheck': { publishes: ['log.ingested', 'health.changed'], subscribes: [] },
      'connector.syslog': { publishes: ['log.ingested'], subscribes: [] },
      'connector.journald': { publishes: ['log.ingested'], subscribes: [] },
      'connector.kubernetes': { publishes: ['log.ingested'], subscribes: [] },
      'connector.cloudwatch': { publishes: ['log.ingested'], subscribes: [] },
      'detector.regex': { publishes: ['incident.created'], subscribes: ['log.ingested'] },
      'detector.threshold': { publishes: ['incident.created'], subscribes: ['log.ingested'] },
      'detector.anomaly': { publishes: ['incident.created'], subscribes: ['log.ingested'] },
      'enricher.incidentStore': { publishes: ['incident.updated'], subscribes: ['incident.created', 'enrichment.completed'] },
      'enricher.aiSummary': { publishes: ['enrichment.completed'], subscribes: ['incident.created'] },
      'enricher.correlator': { publishes: ['enrichment.completed'], subscribes: ['incident.created'] },
      'enricher.dedup': { publishes: ['enrichment.completed'], subscribes: ['incident.created'] },
      'action.safe': { publishes: ['action.proposed', 'action.executed'], subscribes: ['incident.created', 'action.approved'] },
      'action.escalation': { publishes: ['action.proposed'], subscribes: ['incident.created'] },
      'action.runbook': { publishes: ['action.proposed', 'action.executed'], subscribes: ['enrichment.completed'] },
      'notifier.channels': { publishes: [], subscribes: ['incident.created', 'action.proposed', 'action.approved', 'action.executed', 'enrichment.completed'] },
      'notifier.slack': { publishes: [], subscribes: ['incident.created', 'action.proposed', 'action.executed', 'enrichment.completed'] },
      'notifier.pagerduty': { publishes: [], subscribes: ['incident.created', 'action.executed'] },
      'notifier.teams': { publishes: [], subscribes: ['incident.created', 'action.proposed', 'action.executed', 'enrichment.completed'] },
      'notifier.email': { publishes: [], subscribes: ['incident.created', 'action.proposed', 'action.executed', 'enrichment.completed'] },
      'openclaw.tools': { publishes: [], subscribes: [] },
      'ui.api': { publishes: [], subscribes: [] },
      'ui.websocket': { publishes: [], subscribes: ['incident.created', 'incident.updated', 'action.proposed', 'action.approved', 'action.executed', 'enrichment.completed', 'log.ingested'] },
      'ui.dashboard': { publishes: [], subscribes: ['log.ingested', 'incident.created', 'incident.updated', 'action.proposed', 'action.approved', 'action.executed', 'enrichment.completed', 'metric.collected', 'health.changed'] },
    };

    const nodes: TopologyNode[] = [];
    for (const [id, health] of Object.entries(moduleHealths)) {
      nodes.push({
        id,
        type: id.split('.')[0],
        status: health.status,
        events: flow[id] ?? { publishes: [], subscribes: [] },
      });
    }
    return nodes;
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
:root {
  --bg-primary: #0a0e17;
  --bg-secondary: #111827;
  --bg-card: rgba(17, 24, 39, 0.7);
  --bg-glass: rgba(17, 24, 39, 0.4);
  --border: rgba(55, 65, 81, 0.5);
  --border-glow: rgba(59, 130, 246, 0.3);
  --text-primary: #f1f5f9;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent: #3b82f6;
  --accent-glow: rgba(59, 130, 246, 0.15);
  --success: #10b981;
  --success-bg: rgba(16, 185, 129, 0.1);
  --warning: #f59e0b;
  --warning-bg: rgba(245, 158, 11, 0.1);
  --danger: #ef4444;
  --danger-bg: rgba(239, 68, 68, 0.1);
  --purple: #8b5cf6;
  --radius: 12px;
  --radius-sm: 8px;
  --shadow: 0 4px 24px rgba(0,0,0,0.3);
  --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  min-height: 100vh;
  overflow-x: hidden;
}
/* Animated gradient mesh background */
body::before {
  content: '';
  position: fixed;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(ellipse at 20% 50%, rgba(59,130,246,0.08) 0%, transparent 50%),
              radial-gradient(ellipse at 80% 20%, rgba(139,92,246,0.06) 0%, transparent 50%),
              radial-gradient(ellipse at 40% 80%, rgba(16,185,129,0.05) 0%, transparent 50%);
  animation: meshMove 20s ease-in-out infinite;
  z-index: 0;
  pointer-events: none;
}
@keyframes meshMove {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  33% { transform: translate(2%, -1%) rotate(1deg); }
  66% { transform: translate(-1%, 2%) rotate(-1deg); }
}

/* Layout */
.shell { position: relative; z-index: 1; max-width: 1440px; margin: 0 auto; padding: 24px; }
.topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 0; margin-bottom: 24px; border-bottom: 1px solid var(--border);
}
.topbar-brand { display: flex; align-items: center; gap: 12px; }
.brand-icon {
  width: 40px; height: 40px; border-radius: 10px;
  background: linear-gradient(135deg, var(--accent), var(--purple));
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; font-weight: 700; color: #fff;
  box-shadow: 0 0 20px rgba(59,130,246,0.3);
}
.brand-title { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
.brand-env {
  font-size: 11px; padding: 3px 10px; border-radius: 20px;
  background: var(--accent-glow); color: var(--accent);
  border: 1px solid rgba(59,130,246,0.2); font-weight: 600; text-transform: uppercase;
}
.topbar-nav { display: flex; gap: 8px; align-items: center; }
.nav-link {
  padding: 8px 16px; border-radius: var(--radius-sm);
  color: var(--text-secondary); text-decoration: none;
  font-size: 13px; font-weight: 500; transition: var(--transition);
  border: 1px solid transparent;
}
.nav-link:hover, .nav-link.active {
  color: var(--text-primary); background: var(--bg-glass);
  border-color: var(--border);
}
.nav-link.active { border-color: var(--accent); color: var(--accent); }
.pulse-dot {
  width: 8px; height: 8px; border-radius: 50%;
  display: inline-block; margin-right: 6px;
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 currentColor; }
  50% { opacity: 0.7; box-shadow: 0 0 0 4px transparent; }
}
.dot-green { background: var(--success); color: var(--success); }
.dot-yellow { background: var(--warning); color: var(--warning); }
.dot-red { background: var(--danger); color: var(--danger); }

/* Stat cards row */
.stats-row {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px; margin-bottom: 24px;
}
.stat-card {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 20px;
  backdrop-filter: blur(12px); transition: var(--transition);
  position: relative; overflow: hidden;
}
.stat-card::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  opacity: 0; transition: opacity 0.3s;
}
.stat-card:hover::before { opacity: 1; }
.stat-card:hover { border-color: var(--border-glow); transform: translateY(-2px); box-shadow: var(--shadow); }
.stat-value { font-size: 32px; font-weight: 800; letter-spacing: -1px; line-height: 1; }
.stat-label { font-size: 12px; color: var(--text-muted); margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.stat-sub { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
.stat-green .stat-value { color: var(--success); }
.stat-yellow .stat-value { color: var(--warning); }
.stat-red .stat-value { color: var(--danger); }
.stat-blue .stat-value { color: var(--accent); }
.stat-purple .stat-value { color: var(--purple); }

/* Section layout */
.section { margin-bottom: 24px; }
.section-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 12px;
}
.section-title {
  font-size: 14px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.8px; color: var(--text-secondary);
  display: flex; align-items: center; gap: 8px;
}
.section-title .icon { font-size: 16px; }
.section-badge {
  font-size: 11px; padding: 2px 8px; border-radius: 10px;
  background: var(--bg-glass); color: var(--text-muted);
  border: 1px solid var(--border);
}
.filter-btns { display: flex; gap: 4px; }
.filter-btn {
  padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border);
  background: transparent; color: var(--text-muted); font-size: 11px;
  cursor: pointer; transition: var(--transition); font-weight: 500;
}
.filter-btn:hover, .filter-btn.active {
  background: var(--accent-glow); color: var(--accent); border-color: rgba(59,130,246,0.3);
}

/* Module grid */
.module-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.module-card {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px;
  backdrop-filter: blur(12px); transition: var(--transition);
  cursor: default; position: relative;
}
.module-card:hover { border-color: var(--border-glow); transform: translateY(-1px); }
.module-card .mc-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 8px;
}
.module-card .mc-id { font-size: 13px; font-weight: 600; font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; }
.module-card .mc-badge {
  font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.3px;
}
.mc-badge.healthy { background: var(--success-bg); color: var(--success); border: 1px solid rgba(16,185,129,0.2); }
.mc-badge.degraded { background: var(--warning-bg); color: var(--warning); border: 1px solid rgba(245,158,11,0.2); }
.mc-badge.unhealthy { background: var(--danger-bg); color: var(--danger); border: 1px solid rgba(239,68,68,0.2); }
.module-card .mc-type {
  font-size: 10px; color: var(--text-muted); text-transform: uppercase;
  letter-spacing: 0.5px; font-weight: 600;
}
.module-card .mc-detail {
  margin-top: 8px; font-size: 11px; color: var(--text-muted);
  max-height: 0; overflow: hidden; transition: max-height 0.3s;
}
.module-card:hover .mc-detail { max-height: 100px; }
.module-card .mc-msg {
  font-size: 12px; color: var(--danger); margin-top: 4px;
  padding: 4px 8px; background: var(--danger-bg); border-radius: 6px;
}
.mc-glow-healthy { border-left: 3px solid var(--success); }
.mc-glow-degraded { border-left: 3px solid var(--warning); }
.mc-glow-unhealthy { border-left: 3px solid var(--danger); }

/* Event stream */
.event-stream {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); backdrop-filter: blur(12px);
  overflow: hidden;
}
.event-stream table { width: 100%; border-collapse: collapse; font-size: 13px; }
.event-stream th {
  text-align: left; padding: 12px 16px; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--text-muted); font-weight: 600;
  background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--border);
  position: sticky; top: 0;
}
.event-stream td { padding: 10px 16px; border-bottom: 1px solid rgba(55,65,81,0.3); }
.event-stream tr { transition: background 0.15s; }
.event-stream tr:hover { background: rgba(59,130,246,0.05); }
.event-stream tbody { max-height: 400px; overflow-y: auto; display: block; }
.event-stream thead, .event-stream tbody tr { display: table; width: 100%; table-layout: fixed; }
.ev-time { color: var(--text-muted); font-family: monospace; font-size: 12px; width: 90px; }
.ev-type { font-weight: 600; width: 180px; }
.ev-source { color: var(--text-secondary); width: 140px; }
.ev-summary { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev-incident { color: var(--danger); }
.ev-action { color: var(--warning); }
.ev-enrichment { color: var(--success); }
.ev-metric { color: var(--purple); }
.ev-log { color: var(--text-muted); }

/* Topology mini-map */
.topo-container {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 20px;
  backdrop-filter: blur(12px); position: relative;
}
.topo-flow {
  display: flex; gap: 16px; overflow-x: auto; padding: 8px 0;
  align-items: flex-start;
}
.topo-lane {
  min-width: 160px; flex-shrink: 0;
}
.topo-lane-title {
  font-size: 11px; text-transform: uppercase; color: var(--text-muted);
  font-weight: 700; letter-spacing: 0.5px; margin-bottom: 8px;
  text-align: center; padding: 4px 0;
  border-bottom: 2px solid var(--border);
}
.topo-node {
  font-size: 11px; padding: 6px 10px; margin: 4px 0;
  border-radius: 6px; text-align: center;
  border: 1px solid var(--border); transition: var(--transition);
  font-family: monospace;
}
.topo-node:hover { transform: scale(1.05); }
.topo-node.healthy { border-color: rgba(16,185,129,0.3); background: var(--success-bg); color: var(--success); }
.topo-node.degraded { border-color: rgba(245,158,11,0.3); background: var(--warning-bg); color: var(--warning); }
.topo-node.unhealthy { border-color: rgba(239,68,68,0.3); background: var(--danger-bg); color: var(--danger); }
.topo-arrow {
  text-align: center; color: var(--text-muted); font-size: 18px;
  padding: 0 4px; display: flex; align-items: center;
}

/* Footer */
.dash-footer {
  text-align: center; padding: 16px; font-size: 11px; color: var(--text-muted);
}
.dash-footer a { color: var(--accent); text-decoration: none; }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

/* Responsive */
@media (max-width: 768px) {
  .topbar { flex-direction: column; gap: 12px; }
  .stats-row { grid-template-columns: repeat(2, 1fr); }
  .module-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="shell">
  <!-- Top Bar -->
  <div class="topbar">
    <div class="topbar-brand">
      <div class="brand-icon">O</div>
      <div>
        <div class="brand-title">${title}</div>
        <span class="brand-env" id="env-badge">loading...</span>
      </div>
    </div>
    <div class="topbar-nav">
      <span id="live-status"><span class="pulse-dot dot-green"></span><span id="live-text">Connecting...</span></span>
      <a href="/" class="nav-link active">Dashboard</a>
      <a href="/setup" class="nav-link">Configuration</a>
    </div>
  </div>

  <!-- Stats Row -->
  <div class="stats-row" id="stats-row">
    <div class="stat-card stat-green"><div class="stat-value" id="s-healthy">--</div><div class="stat-label">Healthy</div></div>
    <div class="stat-card stat-yellow"><div class="stat-value" id="s-degraded">--</div><div class="stat-label">Degraded</div></div>
    <div class="stat-card stat-red"><div class="stat-value" id="s-unhealthy">--</div><div class="stat-label">Unhealthy</div></div>
    <div class="stat-card stat-blue"><div class="stat-value" id="s-events">--</div><div class="stat-label">Events</div><div class="stat-sub" id="s-uptime"></div></div>
    <div class="stat-card stat-purple"><div class="stat-value" id="s-mem">--</div><div class="stat-label">Memory</div><div class="stat-sub" id="s-mem-detail"></div></div>
  </div>

  <!-- System Topology -->
  <div class="section">
    <div class="section-header">
      <div class="section-title"><span class="icon">\u{1f5fa}</span> System Topology</div>
      <span class="section-badge" id="topo-count">-- modules</span>
    </div>
    <div class="topo-container">
      <div class="topo-flow" id="topo-flow"></div>
    </div>
  </div>

  <!-- Module Health -->
  <div class="section">
    <div class="section-header">
      <div class="section-title"><span class="icon">\u{1f4e6}</span> Module Health</div>
      <div class="filter-btns">
        <button class="filter-btn active" data-filter="all" onclick="filterModules('all',this)">All</button>
        <button class="filter-btn" data-filter="healthy" onclick="filterModules('healthy',this)">Healthy</button>
        <button class="filter-btn" data-filter="degraded" onclick="filterModules('degraded',this)">Degraded</button>
        <button class="filter-btn" data-filter="unhealthy" onclick="filterModules('unhealthy',this)">Unhealthy</button>
      </div>
    </div>
    <div class="module-grid" id="modules"></div>
  </div>

  <!-- Event Stream -->
  <div class="section">
    <div class="section-header">
      <div class="section-title"><span class="icon">\u{26a1}</span> Event Stream</div>
      <div class="filter-btns">
        <button class="filter-btn active" data-filter="all" onclick="filterEvents('all',this)">All</button>
        <button class="filter-btn" data-filter="incident" onclick="filterEvents('incident',this)">Incidents</button>
        <button class="filter-btn" data-filter="action" onclick="filterEvents('action',this)">Actions</button>
        <button class="filter-btn" data-filter="enrichment" onclick="filterEvents('enrichment',this)">Enrichments</button>
      </div>
    </div>
    <div class="event-stream">
      <table>
        <thead><tr><th class="ev-time">Time</th><th class="ev-type">Type</th><th class="ev-source">Source</th><th class="ev-summary">Summary</th></tr></thead>
        <tbody id="events"></tbody>
      </table>
    </div>
  </div>

  <div class="dash-footer">
    OpsPilot Dashboard \u2014 auto-refreshes every ${refreshMs / 1000}s \u2014 <a href="/setup">Open Configuration Wizard</a>
  </div>
</div>

<script>
(function() {
  const REFRESH = ${refreshMs};
  let currentModuleFilter = 'all';
  let currentEventFilter = 'all';
  let allModules = {};
  let allEvents = [];

  async function fetchJson(url) { const r = await fetch(url); return r.json(); }

  function typeClass(type) {
    if (type.startsWith('incident')) return 'ev-incident';
    if (type.startsWith('action')) return 'ev-action';
    if (type.startsWith('enrichment')) return 'ev-enrichment';
    if (type.startsWith('metric')) return 'ev-metric';
    return 'ev-log';
  }

  function moduleType(id) { return id.split('.')[0]; }
  function formatUptime(s) {
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    return h > 0 ? h+'h '+m+'m' : m+'m '+Math.floor(s%60)+'s';
  }
  function formatBytes(b) {
    if (b > 1073741824) return (b/1073741824).toFixed(1)+' GB';
    return (b/1048576).toFixed(0)+' MB';
  }

  window.filterModules = function(filter, btn) {
    currentModuleFilter = filter;
    document.querySelectorAll('.section:nth-child(3) .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderModules();
  };

  window.filterEvents = function(filter, btn) {
    currentEventFilter = filter;
    document.querySelectorAll('.section:nth-child(4) .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderEvents();
  };

  function renderModules() {
    const mc = document.getElementById('modules');
    mc.innerHTML = '';
    for (const [id, h] of Object.entries(allModules)) {
      if (currentModuleFilter !== 'all' && h.status !== currentModuleFilter) continue;
      const div = document.createElement('div');
      div.className = 'module-card mc-glow-' + h.status;
      const details = h.details ? Object.entries(h.details).slice(0,4).map(([k,v])=>k+': '+v).join(' \\u2022 ') : '';
      div.innerHTML = '<div class="mc-header"><span class="mc-id">'+id+'</span><span class="mc-badge '+h.status+'">'+h.status+'</span></div>'
        + '<div class="mc-type">'+moduleType(id)+'</div>'
        + (h.message ? '<div class="mc-msg">'+h.message+'</div>' : '')
        + '<div class="mc-detail">'+details+'</div>';
      mc.appendChild(div);
    }
  }

  function renderEvents() {
    const tbody = document.getElementById('events');
    tbody.innerHTML = '';
    const filtered = currentEventFilter === 'all' ? allEvents : allEvents.filter(e => e.type.startsWith(currentEventFilter));
    for (const ev of filtered.slice(0, 50)) {
      const tr = document.createElement('tr');
      const ts = new Date(ev.timestamp).toLocaleTimeString();
      tr.innerHTML = '<td class="ev-time">'+ts+'</td>'
        + '<td class="ev-type '+typeClass(ev.type)+'">'+ev.type+'</td>'
        + '<td class="ev-source">'+ev.source+'</td>'
        + '<td class="ev-summary">'+ev.payloadSummary.slice(0,120)+'</td>';
      tbody.appendChild(tr);
    }
    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4" style="text-align:center;color:var(--text-muted);padding:32px;">No events yet \u2014 waiting for data...</td>';
      tbody.appendChild(tr);
    }
  }

  function renderTopology(topology) {
    const lanes = { connector: [], detector: [], enricher: [], action: [], notifier: [], ui: [] };
    for (const node of topology) { (lanes[node.type] || (lanes.ui = lanes.ui || [])).push(node); }
    const flow = document.getElementById('topo-flow');
    flow.innerHTML = '';
    const laneOrder = ['connector','detector','enricher','action','notifier','ui'];
    const laneLabels = { connector: 'Ingest', detector: 'Detect', enricher: 'Enrich', action: 'Act', notifier: 'Notify', ui: 'Present' };
    for (let i = 0; i < laneOrder.length; i++) {
      const key = laneOrder[i];
      const nodes = lanes[key] || [];
      if (nodes.length === 0 && key !== 'connector') continue;
      if (i > 0) { const arrow = document.createElement('div'); arrow.className='topo-arrow'; arrow.textContent='\\u2192'; flow.appendChild(arrow); }
      const lane = document.createElement('div'); lane.className = 'topo-lane';
      lane.innerHTML = '<div class="topo-lane-title">'+laneLabels[key]+'</div>';
      for (const n of nodes) {
        const nd = document.createElement('div');
        nd.className = 'topo-node ' + n.status;
        nd.textContent = n.id.split('.').slice(1).join('.');
        nd.title = n.id + ' (' + n.status + ')\\nPublishes: ' + (n.events.publishes.join(', ')||'none')
          + '\\nSubscribes: ' + (n.events.subscribes.join(', ')||'none');
        lane.appendChild(nd);
      }
      flow.appendChild(lane);
    }
    document.getElementById('topo-count').textContent = topology.length + ' modules';
  }

  async function refresh() {
    try {
      const [status, modules, events, config, topology] = await Promise.all([
        fetchJson('/api/status'), fetchJson('/api/modules'), fetchJson('/api/events'),
        fetchJson('/api/config/current'), fetchJson('/api/topology'),
      ]);

      document.getElementById('s-healthy').textContent = status.modules.healthy;
      document.getElementById('s-degraded').textContent = status.modules.degraded;
      document.getElementById('s-unhealthy').textContent = status.modules.unhealthy;
      document.getElementById('s-events').textContent = status.eventsReceived.toLocaleString();
      document.getElementById('s-uptime').textContent = 'Uptime: ' + formatUptime(status.uptime);
      document.getElementById('s-mem').textContent = config.system.memory.usedPct + '%';
      document.getElementById('s-mem-detail').textContent = formatBytes(config.system.memory.used) + ' / ' + formatBytes(config.system.memory.total);
      document.getElementById('env-badge').textContent = 'Node ' + config.system.nodeVersion;

      const dot = document.getElementById('live-status');
      const dotClass = status.modules.unhealthy > 0 ? 'dot-red' : status.modules.degraded > 0 ? 'dot-yellow' : 'dot-green';
      dot.querySelector('.pulse-dot').className = 'pulse-dot ' + dotClass;
      document.getElementById('live-text').textContent = status.modules.unhealthy > 0 ? 'Issues Detected' : 'All Systems Go';

      allModules = modules;
      allEvents = events;
      renderModules();
      renderEvents();
      renderTopology(topology);
    } catch (e) {
      console.error('Dashboard refresh failed', e);
      document.getElementById('live-text').textContent = 'Connection Lost';
      document.querySelector('.pulse-dot').className = 'pulse-dot dot-red';
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
      category: 'core',
      status: 'done',
      impact: 'critical',
      detail: 'EventBus, config, lifecycle, dependency resolver, audit, approval gate',
      guide: '',
    });
    items.push({
      id: 'safety',
      label: 'Safety Model',
      category: 'core',
      status: 'done',
      impact: 'critical',
      detail: 'Proposals \u2192 approval tokens (15-min TTL) \u2192 gated execution \u2192 audit log',
      guide: '',
    });

    // -- Database --
    const storageInner = (this.ctx?.storage as unknown as { inner?: { constructor: { name: string } } })?.inner;
    const engineName = storageInner?.constructor?.name ?? '';
    const hasPersistentDb = engineName === 'SQLiteStorage' || engineName === 'FileStorage';
    const engineLabel = engineName === 'SQLiteStorage' ? 'SQLite' : engineName === 'FileStorage' ? 'file' : 'memory';
    items.push({
      id: 'database',
      label: 'Persistent Database',
      category: 'infra',
      status: hasPersistentDb ? 'done' : 'missing',
      impact: 'critical',
      detail: hasPersistentDb
        ? `Using ${engineLabel} storage engine. Data persists across restarts.`
        : 'Data is stored in-memory (lost on restart). No persistent backend configured.',
      guide: hasPersistentDb
        ? ''
        : 'Set storage.engine to "sqlite" in config/default.yaml with options.dbPath pointing to your data directory.',
      configPath: 'storage.engine',
      envVars: [],
    });

    // -- LLM --
    const aiModule = moduleIds.includes('enricher.aiSummary');
    const hasOpenAI = process.env['OPENAI_API_KEY'] !== undefined;
    const hasAnthropic = process.env['ANTHROPIC_API_KEY'] !== undefined;
    const hasRealLLM = hasOpenAI || hasAnthropic;
    items.push({
      id: 'llm',
      label: 'LLM Integration',
      category: 'infra',
      status: hasRealLLM ? 'done' : aiModule ? 'stub' : 'missing',
      impact: 'high',
      detail: hasRealLLM
        ? `AI Summary using ${hasOpenAI ? 'OpenAI' : 'Anthropic'} API.`
        : aiModule
          ? 'AI Summary module loaded but using template fallback. Set an API key for real AI insights.'
          : 'enricher.aiSummary module not enabled.',
      guide: 'Set provider to "openai" or "anthropic" in modules.enricher.aiSummary. Export OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable.',
      configPath: 'modules.enricher.aiSummary.provider',
      envVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    });

    // -- Auth --
    const authEnabled = this.deps?.authService?.enabled ?? false;
    items.push({
      id: 'auth',
      label: 'API Authentication',
      category: 'infra',
      status: authEnabled ? 'done' : 'missing',
      impact: 'critical',
      detail: authEnabled
        ? 'JWT + API key authentication enabled on REST API and Dashboard API endpoints.'
        : 'All API endpoints are open without authentication. Critical for production.',
      guide: 'Set auth.enabled: true with jwtSecret in config, or export OPSPILOT_JWT_SECRET / OPSPILOT_API_KEY environment variable.',
      configPath: 'auth.enabled',
      envVars: ['OPSPILOT_JWT_SECRET', 'OPSPILOT_API_KEY'],
    });

    // -- Connectors: real vs stubbed --
    const realConnectors = ['connector.fileTail', 'connector.syslog', 'connector.metrics'];
    const stubbedConnectors: Record<string, string> = {
      'connector.kubernetes': 'Simulates K8s API. Needs @kubernetes/client-node SDK and cluster access.',
      'connector.cloudwatch': 'Simulates CloudWatch. Needs @aws-sdk/client-cloudwatch-logs and AWS credentials.',
      'connector.journald': 'Simulates journalctl. Needs real systemd journal access (Linux only).',
    };

    for (const id of realConnectors) {
      if (moduleIds.includes(id)) {
        items.push({
          id, label: id, category: 'connector',
          status: 'done', impact: 'medium',
          detail: 'Real implementation, working end-to-end.',
          guide: '',
        });
      }
    }
    for (const [id, detail] of Object.entries(stubbedConnectors)) {
      if (moduleIds.includes(id)) {
        items.push({
          id, label: id, category: 'connector',
          status: 'stub', impact: 'medium',
          detail,
          guide: `Replace simulated API calls in src/modules/${id}/index.ts with real SDK.`,
          configPath: `modules.${id}`,
        });
      }
    }
    if (moduleIds.includes('connector.healthCheck')) {
      const hcHealth = moduleHealths['connector.healthCheck'];
      const endpointCount = (hcHealth?.details as Record<string, unknown>)?.endpoints ?? 0;
      items.push({
        id: 'connector.healthCheck', label: 'connector.healthCheck',
        category: 'connector',
        status: Number(endpointCount) > 0 ? 'done' : 'stub',
        impact: 'medium',
        detail: Number(endpointCount) > 0
          ? `Monitoring ${endpointCount} endpoints.`
          : 'Health check module loaded but no endpoints configured.',
        guide: 'Add endpoint definitions to modules.connector.healthCheck.endpoints in config.',
        configPath: 'modules.connector.healthCheck.endpoints',
      });
    }

    // -- Notifiers: all stubbed --
    const stubbedNotifiers: Record<string, { detail: string; envVars: string[] }> = {
      'notifier.slack': { detail: 'Builds correct payload but needs webhook URL configured.', envVars: ['SLACK_WEBHOOK_URL'] },
      'notifier.pagerduty': { detail: 'Builds correct payload but needs routing key configured.', envVars: ['PAGERDUTY_ROUTING_KEY'] },
      'notifier.teams': { detail: 'Sends Adaptive Cards via webhook. Needs webhook URL.', envVars: ['TEAMS_WEBHOOK_URL'] },
      'notifier.email': { detail: 'Builds HTML email. Needs SMTP host and credentials.', envVars: ['SMTP_HOST', 'SMTP_PASSWORD'] },
    };
    for (const [id, info] of Object.entries(stubbedNotifiers)) {
      if (moduleIds.includes(id)) {
        items.push({
          id, label: id, category: 'notifier',
          status: 'stub', impact: 'high',
          detail: info.detail,
          guide: `Configure in modules.${id} or set environment variables: ${info.envVars.join(', ')}`,
          configPath: `modules.${id}`,
          envVars: info.envVars,
        });
      }
    }
    if (moduleIds.includes('notifier.channels')) {
      items.push({
        id: 'notifier.channels', label: 'notifier.channels',
        category: 'notifier', status: 'done', impact: 'medium',
        detail: 'Multi-channel dispatch (console, webhook, file) working.',
        guide: '',
      });
    }

    // -- Detectors (all real) --
    for (const id of ['detector.regex', 'detector.threshold', 'detector.anomaly']) {
      if (moduleIds.includes(id)) {
        items.push({
          id, label: id, category: 'detector',
          status: 'done', impact: 'high',
          detail: 'Real detection logic, fully tested.',
          guide: '',
        });
      }
    }

    // -- Actions --
    for (const id of ['action.safe', 'action.escalation', 'action.runbook']) {
      if (moduleIds.includes(id)) {
        items.push({
          id, label: id, category: 'action',
          status: 'done', impact: 'high',
          detail: 'Action module operational with approval gate.',
          guide: '',
        });
      }
    }

    // -- Enrichers --
    for (const id of ['enricher.incidentStore', 'enricher.correlator', 'enricher.dedup']) {
      if (moduleIds.includes(id)) {
        items.push({
          id, label: id, category: 'enricher',
          status: 'done', impact: 'medium',
          detail: 'Enrichment module running.',
          guide: '',
        });
      }
    }

    // -- UI --
    for (const id of ['ui.api', 'ui.websocket', 'ui.dashboard']) {
      if (moduleIds.includes(id)) {
        items.push({
          id, label: id, category: 'ui',
          status: 'done', impact: 'medium',
          detail: 'UI module serving.',
          guide: '',
        });
      }
    }

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

  /** Build the setup wizard HTML page. Public for testing. */
  renderSetupHtml(): string {
    const title = this.esc(this.config.title);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} \u2014 Configuration</title>
<style>
:root {
  --bg-primary: #0a0e17;
  --bg-secondary: #111827;
  --bg-card: rgba(17, 24, 39, 0.7);
  --bg-glass: rgba(17, 24, 39, 0.4);
  --border: rgba(55, 65, 81, 0.5);
  --border-glow: rgba(59, 130, 246, 0.3);
  --text-primary: #f1f5f9;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent: #3b82f6;
  --accent-glow: rgba(59, 130, 246, 0.15);
  --success: #10b981;
  --success-bg: rgba(16, 185, 129, 0.1);
  --warning: #f59e0b;
  --warning-bg: rgba(245, 158, 11, 0.1);
  --danger: #ef4444;
  --danger-bg: rgba(239, 68, 68, 0.1);
  --purple: #8b5cf6;
  --radius: 12px;
  --radius-sm: 8px;
  --shadow: 0 4px 24px rgba(0,0,0,0.3);
  --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: var(--bg-primary); color: var(--text-primary);
  min-height: 100vh; overflow-x: hidden;
}
body::before {
  content: '';
  position: fixed; top: -50%; left: -50%; width: 200%; height: 200%;
  background: radial-gradient(ellipse at 30% 40%, rgba(139,92,246,0.08) 0%, transparent 50%),
              radial-gradient(ellipse at 70% 60%, rgba(59,130,246,0.06) 0%, transparent 50%),
              radial-gradient(ellipse at 50% 80%, rgba(16,185,129,0.05) 0%, transparent 50%);
  animation: meshMove 20s ease-in-out infinite; z-index: 0; pointer-events: none;
}
@keyframes meshMove { 0%,100%{transform:translate(0,0) rotate(0deg)}33%{transform:translate(2%,-1%) rotate(1deg)}66%{transform:translate(-1%,2%) rotate(-1deg)} }

.shell { position: relative; z-index: 1; max-width: 1200px; margin: 0 auto; padding: 24px; }

/* Topbar */
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; margin-bottom: 32px; border-bottom: 1px solid var(--border); }
.topbar-brand { display: flex; align-items: center; gap: 12px; }
.brand-icon { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, var(--accent), var(--purple)); display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; color: #fff; box-shadow: 0 0 20px rgba(59,130,246,0.3); }
.brand-title { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
.topbar-nav { display: flex; gap: 8px; }
.nav-link { padding: 8px 16px; border-radius: var(--radius-sm); color: var(--text-secondary); text-decoration: none; font-size: 13px; font-weight: 500; transition: var(--transition); border: 1px solid transparent; }
.nav-link:hover,.nav-link.active { color: var(--text-primary); background: var(--bg-glass); border-color: var(--border); }
.nav-link.active { border-color: var(--accent); color: var(--accent); }

/* Hero */
.hero { text-align: center; margin-bottom: 40px; }
.hero h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 8px; }
.hero p { color: var(--text-secondary); font-size: 15px; max-width: 600px; margin: 0 auto; line-height: 1.6; }

/* Readiness ring */
.readiness { display: flex; justify-content: center; gap: 40px; align-items: center; margin: 32px 0; }
.ring-container { position: relative; width: 140px; height: 140px; }
.ring-container svg { transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: var(--border); stroke-width: 8; }
.ring-fill { fill: none; stroke-width: 8; stroke-linecap: round; transition: stroke-dashoffset 1s ease-out; }
.ring-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); text-align: center; }
.ring-pct { font-size: 32px; font-weight: 800; }
.ring-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
.readiness-stats { display: flex; flex-direction: column; gap: 12px; }
.rs-row { display: flex; align-items: center; gap: 10px; }
.rs-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.rs-dot.green { background: var(--success); }
.rs-dot.yellow { background: var(--warning); }
.rs-dot.red { background: var(--danger); }
.rs-count { font-size: 20px; font-weight: 700; min-width: 30px; }
.rs-label { font-size: 13px; color: var(--text-secondary); }

/* Env detection section */
.env-section {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 20px; margin-bottom: 24px;
  backdrop-filter: blur(12px);
}
.env-title { font-size: 14px; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
.env-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 8px; }
.env-item {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  border-radius: var(--radius-sm); transition: background 0.15s;
  font-size: 13px;
}
.env-item:hover { background: rgba(255,255,255,0.03); }
.env-name { font-family: monospace; font-weight: 600; min-width: 200px; }
.env-status { width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; }
.env-set { background: var(--success-bg); color: var(--success); border: 1px solid rgba(16,185,129,0.3); }
.env-unset { background: var(--danger-bg); color: var(--danger); border: 1px solid rgba(239,68,68,0.2); }
.env-purpose { color: var(--text-muted); font-size: 12px; }

/* Category tabs */
.cat-tabs { display: flex; gap: 6px; margin-bottom: 20px; flex-wrap: wrap; }
.cat-tab {
  padding: 8px 16px; border-radius: 20px; border: 1px solid var(--border);
  background: transparent; color: var(--text-muted); font-size: 12px;
  cursor: pointer; transition: var(--transition); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.3px;
}
.cat-tab:hover { background: var(--bg-glass); color: var(--text-secondary); }
.cat-tab.active { background: var(--accent-glow); color: var(--accent); border-color: rgba(59,130,246,0.3); }
.cat-tab .tab-count {
  display: inline-block; margin-left: 6px; padding: 0 6px;
  border-radius: 8px; font-size: 10px;
  background: rgba(255,255,255,0.08);
}

/* Setup cards */
.setup-grid { display: grid; gap: 12px; }
.setup-card {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 20px;
  backdrop-filter: blur(12px); transition: var(--transition);
  position: relative; overflow: hidden;
}
.setup-card:hover { border-color: var(--border-glow); transform: translateY(-1px); box-shadow: var(--shadow); }
.setup-card.done { border-left: 3px solid var(--success); }
.setup-card.stub { border-left: 3px solid var(--warning); }
.setup-card.missing { border-left: 3px solid var(--danger); }
.sc-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.sc-title { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.sc-icon { font-size: 16px; }
.sc-badges { display: flex; gap: 6px; }
.sc-badge {
  font-size: 10px; padding: 3px 10px; border-radius: 10px;
  font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
}
.sc-badge.done { background: var(--success-bg); color: var(--success); border: 1px solid rgba(16,185,129,0.2); }
.sc-badge.stub { background: var(--warning-bg); color: var(--warning); border: 1px solid rgba(245,158,11,0.2); }
.sc-badge.missing { background: var(--danger-bg); color: var(--danger); border: 1px solid rgba(239,68,68,0.2); }
.sc-badge.impact { background: rgba(139,92,246,0.1); color: var(--purple); border: 1px solid rgba(139,92,246,0.2); }
.sc-detail { font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 8px; }
.sc-guide {
  padding: 12px 16px; background: rgba(59,130,246,0.05);
  border-left: 3px solid var(--accent); border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  font-size: 12px; color: var(--text-secondary); line-height: 1.6;
}
.sc-guide code {
  background: rgba(255,255,255,0.08); padding: 1px 6px; border-radius: 4px;
  font-family: monospace; font-size: 11px; color: var(--accent);
}
.sc-meta { margin-top: 8px; display: flex; gap: 12px; flex-wrap: wrap; }
.sc-meta-item { font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; }
.sc-meta-item code { font-family: monospace; color: var(--purple); background: rgba(139,92,246,0.1); padding: 0 4px; border-radius: 3px; font-size: 10px; }

/* System info */
.sys-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin-bottom: 24px; }
.sys-card {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px;
  backdrop-filter: blur(12px);
}
.sys-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; margin-bottom: 4px; }
.sys-value { font-size: 18px; font-weight: 700; }

.dash-footer { text-align: center; padding: 24px; font-size: 11px; color: var(--text-muted); }
.dash-footer a { color: var(--accent); text-decoration: none; }

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
@media(max-width:768px) { .readiness{flex-direction:column} .env-grid{grid-template-columns:1fr} .sys-grid{grid-template-columns:1fr} }
</style>
</head>
<body>
<div class="shell">
  <div class="topbar">
    <div class="topbar-brand">
      <div class="brand-icon">O</div>
      <div><div class="brand-title">${title}</div></div>
    </div>
    <div class="topbar-nav">
      <a href="/" class="nav-link">Dashboard</a>
      <a href="/setup" class="nav-link active">Configuration</a>
    </div>
  </div>

  <div class="hero">
    <h1>\u{2699}\u{fe0f} Configuration &amp; Readiness</h1>
    <p>Auto-discovered system state, environment detection, and guided setup. Each component shows its current status with actionable steps to reach production readiness.</p>
  </div>

  <!-- System Info -->
  <div class="sys-grid" id="sys-info"></div>

  <!-- Readiness Ring -->
  <div class="readiness">
    <div class="ring-container">
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle class="ring-bg" cx="70" cy="70" r="60"/>
        <circle class="ring-fill" id="ring-fill" cx="70" cy="70" r="60"
                stroke-dasharray="377" stroke-dashoffset="377"/>
      </svg>
      <div class="ring-text">
        <div class="ring-pct" id="ring-pct">--</div>
        <div class="ring-label">Ready</div>
      </div>
    </div>
    <div class="readiness-stats">
      <div class="rs-row"><div class="rs-dot green"></div><div class="rs-count" id="rs-done">-</div><div class="rs-label">Complete &amp; operational</div></div>
      <div class="rs-row"><div class="rs-dot yellow"></div><div class="rs-count" id="rs-stub">-</div><div class="rs-label">Stubbed \u2014 needs configuration</div></div>
      <div class="rs-row"><div class="rs-dot red"></div><div class="rs-count" id="rs-missing">-</div><div class="rs-label">Missing \u2014 action required</div></div>
    </div>
  </div>

  <!-- Environment Detection -->
  <div class="env-section">
    <div class="env-title">\u{1f50d} Environment Auto-Detection</div>
    <div class="env-grid" id="env-grid"></div>
  </div>

  <!-- Category Tabs -->
  <div class="cat-tabs" id="cat-tabs"></div>

  <!-- Setup Cards -->
  <div class="setup-grid" id="setup-grid"></div>

  <div class="dash-footer">${title} Configuration Wizard \u2014 <a href="/">Back to Dashboard</a></div>
</div>

<script>
(function() {
  let allItems = [];
  let currentCat = 'all';

  async function fetchJson(u) { const r = await fetch(u); return r.json(); }

  function renderSysInfo(config) {
    const el = document.getElementById('sys-info');
    const items = [
      { label: 'Platform', value: config.system.platform + ' / ' + config.system.arch },
      { label: 'Node.js', value: config.system.nodeVersion },
      { label: 'CPUs', value: config.system.cpus },
      { label: 'Memory', value: Math.round(config.system.memory.total/1073741824*10)/10 + ' GB (' + config.system.memory.usedPct + '% used)' },
      { label: 'Storage Engine', value: config.storage.engine },
      { label: 'Auth', value: config.auth.enabled ? 'Enabled' : 'Disabled' },
      { label: 'Modules', value: config.modules.total },
      { label: 'Uptime', value: Math.floor(config.system.uptime/60) + ' min' },
    ];
    el.innerHTML = items.map(i =>
      '<div class="sys-card"><div class="sys-label">'+i.label+'</div><div class="sys-value">'+i.value+'</div></div>'
    ).join('');
  }

  function renderReadiness(items) {
    const done = items.filter(i=>i.status==='done').length;
    const stub = items.filter(i=>i.status==='stub').length;
    const missing = items.filter(i=>i.status==='missing').length;
    const total = items.length;
    const pct = total > 0 ? Math.round((done/total)*100) : 0;

    document.getElementById('rs-done').textContent = done;
    document.getElementById('rs-stub').textContent = stub;
    document.getElementById('rs-missing').textContent = missing;
    document.getElementById('ring-pct').textContent = pct + '%';

    const circle = document.getElementById('ring-fill');
    const circumference = 377;
    const offset = circumference - (pct / 100) * circumference;
    circle.style.strokeDashoffset = offset;
    circle.style.stroke = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
  }

  function renderEnv(envVars) {
    const el = document.getElementById('env-grid');
    el.innerHTML = envVars.map(v =>
      '<div class="env-item">'
      + '<div class="env-status '+(v.set?'env-set':'env-unset')+'">'+(v.set?'\\u2713':'\\u2717')+'</div>'
      + '<div class="env-name">'+v.name+'</div>'
      + '<div class="env-purpose">'+v.purpose+'</div>'
      + '</div>'
    ).join('');
  }

  function renderTabs(items) {
    const cats = {};
    for (const item of items) {
      cats[item.category] = (cats[item.category]||0) + 1;
    }
    const el = document.getElementById('cat-tabs');
    let html = '<button class="cat-tab active" onclick="window.filterCat(\\'all\\',this)">All <span class="tab-count">'+items.length+'</span></button>';
    const catLabels = { core:'Core', infra:'Infrastructure', connector:'Connectors', detector:'Detectors', enricher:'Enrichers', action:'Actions', notifier:'Notifiers', ui:'UI' };
    for (const [cat, count] of Object.entries(cats)) {
      html += '<button class="cat-tab" onclick="window.filterCat(\\''+cat+'\\',this)">'+(catLabels[cat]||cat)+' <span class="tab-count">'+count+'</span></button>';
    }
    el.innerHTML = html;
  }

  window.filterCat = function(cat, btn) {
    currentCat = cat;
    document.querySelectorAll('.cat-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderCards();
  };

  function renderCards() {
    const grid = document.getElementById('setup-grid');
    const filtered = currentCat === 'all' ? allItems : allItems.filter(i => i.category === currentCat);
    // Sort: missing first, then stub, then done
    const order = { missing: 0, stub: 1, done: 2 };
    filtered.sort((a,b) => (order[a.status]??9) - (order[b.status]??9));

    grid.innerHTML = filtered.map(item => {
      const icon = item.status === 'done' ? '\\u2705' : item.status === 'stub' ? '\\u26a0\\ufe0f' : '\\u274c';
      const guideHtml = item.guide
        ? '<div class="sc-guide">' + item.guide.replace(/([A-Z_]{3,})/g, '<code>$1</code>') + '</div>'
        : '';
      const metaHtml = [];
      if (item.configPath) metaHtml.push('<span class="sc-meta-item">Config: <code>'+item.configPath+'</code></span>');
      if (item.envVars && item.envVars.length) metaHtml.push('<span class="sc-meta-item">Env: '+item.envVars.map(v=>'<code>'+v+'</code>').join(' ')+'</span>');
      return '<div class="setup-card '+item.status+'">'
        + '<div class="sc-header"><div class="sc-title"><span class="sc-icon">'+icon+'</span>'+item.label+'</div>'
        + '<div class="sc-badges"><span class="sc-badge '+item.status+'">'+item.status+'</span><span class="sc-badge impact">'+item.impact+'</span></div></div>'
        + '<div class="sc-detail">'+item.detail+'</div>'
        + guideHtml
        + (metaHtml.length ? '<div class="sc-meta">'+metaHtml.join('')+'</div>' : '')
        + '</div>';
    }).join('');
  }

  async function load() {
    const [setup, config, envVars] = await Promise.all([
      fetchJson('/api/setup'), fetchJson('/api/config/current'), fetchJson('/api/config/env'),
    ]);
    allItems = setup;
    renderSysInfo(config);
    renderReadiness(setup);
    renderEnv(envVars);
    renderTabs(setup);
    renderCards();
  }
  load();
})();
</script>
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
