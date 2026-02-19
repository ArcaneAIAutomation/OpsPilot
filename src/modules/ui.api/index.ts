// ---------------------------------------------------------------------------
// OpsPilot — ui.api (HTTP REST API Module)
// ---------------------------------------------------------------------------
// Exposes OpsPilot data and operations via a RESTful HTTP API built on
// Node.js built-in `http` module (zero external dependencies).
//
// Endpoints:
//   GET  /api/health                    — System health + module statuses
//   GET  /api/livez                     — Liveness probe (always 200 if running)
//   GET  /api/readyz                    — Readiness probe (200 if healthy, 503 if degraded)
//   GET  /api/incidents                 — List incidents (?severity=&status=&limit=)
//   GET  /api/incidents/:id             — Get single incident
//   GET  /api/approvals/pending         — List pending approval requests
//   POST /api/approvals/:id/approve     — Approve a request
//   POST /api/approvals/:id/deny        — Deny a request
//   GET  /api/audit                     — Query audit trail (?action=&actor=&limit=)
//   GET  /api/tools                     — List registered OpenClaw tools
//
// Safety: The REST API can propose actions and approve/deny requests,
// but it NEVER bypasses the approval gate. All mutations go through
// the standard safety flow.
// ---------------------------------------------------------------------------

import http from 'node:http';
import { URL } from 'node:url';
import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
  ILogger,
} from '../../core/types/module';
import { IStorageEngine } from '../../core/types/storage';
import { IApprovalGate, IAuditLogger, ApprovalStatus } from '../../core/types/security';
import { IToolRegistry } from '../../core/types/openclaw';
import { IAuthService, AuthIdentity } from '../../core/types/auth';
import { KeyedRateLimiter, RateLimitResult } from '../../shared/rate-limiter';
import { MetricsCollector } from '../../shared/metrics';
import configSchema from './schema.json';

// ── Types ──────────────────────────────────────────────────────────────────

interface ApiConfig {
  host: string;
  port: number;
  basePath: string;
  corsOrigin: string;
  rateLimitPerMinute: number;
}

interface RouteMatch {
  handler: (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, query: URLSearchParams) => Promise<void>;
  params: Record<string, string>;
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, query: URLSearchParams) => Promise<void>;
}

// ── Dependencies (injected after construction) ─────────────────────────────

export interface ApiDependencies {
  storage: IStorageEngine;
  approvalGate: IApprovalGate;
  auditLogger: IAuditLogger;
  toolRegistry: IToolRegistry;
  getModuleHealths: () => Record<string, ModuleHealth>;
  authService?: IAuthService;
}

// ── Stored types imported by convention ────────────────────────────────────

interface StoredIncident {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  detectedBy: string;
  createdAt: string;
  enrichments: Record<string, unknown>;
  timeline: Array<{ timestamp: string; action: string; actor: string; details?: Record<string, unknown> }>;
  [key: string]: unknown;
}

interface StoredApprovalRequest {
  id: string;
  actionType: string;
  description: string;
  reasoning: string;
  requestedBy: string;
  requestedAt: string;
  status: string;
  metadata?: Record<string, unknown>;
}

// ── Module Implementation ──────────────────────────────────────────────────

export class RestApiModule implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'ui.api',
    name: 'REST API',
    version: '0.1.0',
    type: ModuleType.UIExtension,
    description: 'HTTP REST API for external integrations and dashboards.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: ApiConfig;
  private server: http.Server | null = null;
  private routes: Route[] = [];
  private deps!: ApiDependencies;
  private rateLimiter!: KeyedRateLimiter;
  private metricsCollector!: MetricsCollector;

  // Metrics
  private requestCount = 0;
  private errorCount = 0;
  private healthy = true;
  private lastError: string | undefined;

  // ── Dependency Injection ─────────────────────────────────────────────────

  setDependencies(deps: ApiDependencies): void {
    this.deps = deps;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    const DEFAULTS: ApiConfig = {
      host: '0.0.0.0',
      port: 3000,
      basePath: '/api',
      corsOrigin: '*',
      rateLimitPerMinute: 120,
    };

    this.config = {
      ...DEFAULTS,
      ...context.config,
    } as ApiConfig;

    // Use system port if configured and module port is default
    // (system port takes precedence)

    this.rateLimiter = new KeyedRateLimiter({
      maxRequests: this.config.rateLimitPerMinute,
      windowMs: 60_000,
    });

    this.metricsCollector = new MetricsCollector({ prefix: 'opspilot' });

    this.registerRoutes();

    this.ctx.logger.info('Initialized', {
      host: this.config.host,
      port: this.config.port,
      basePath: this.config.basePath,
    });
  }

  async start(): Promise<void> {
    if (!this.deps) {
      this.ctx.logger.warn('Dependencies not injected, REST API will be limited');
    }

    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.errorCount++;
          this.ctx.logger.error(
            'Unhandled request error',
            err instanceof Error ? err : new Error(String(err)),
          );
          this.sendJson(res, 500, { error: 'Internal server error' });
        });
      });

      this.server.on('error', (err) => {
        this.healthy = false;
        this.lastError = err.message;
        this.ctx.logger.error('HTTP server error', err);
        reject(err);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        this.ctx.logger.info('REST API server started', {
          url: `http://${this.config.host}:${this.config.port}${this.config.basePath}`,
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.ctx.logger.info('REST API server stopped', {
            requestsServed: this.requestCount,
            errors: this.errorCount,
          });
          this.server = null;
          resolve();
        });
      });
    }
  }

  async destroy(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.routes = [];
    this.ctx = undefined!;
    this.config = undefined!;
  }

  health(): ModuleHealth {
    return {
      status: this.healthy ? 'healthy' : 'degraded',
      message: this.lastError,
      details: {
        port: this.config?.port,
        requestCount: this.requestCount,
        errorCount: this.errorCount,
        serverRunning: this.server !== null && this.server.listening,
      },
      lastCheck: new Date(),
    };
  }

  // ── Route Registration ───────────────────────────────────────────────────

  private registerRoutes(): void {
    const base = this.config.basePath.replace(/\/$/, '');

    this.addRoute('GET', `${base}/health`, (req, res, params, query) =>
      this.handleHealth(req, res, params, query),
    );
    this.addRoute('GET', `${base}/livez`, (req, res, params, query) =>
      this.handleLivez(req, res, params, query),
    );
    this.addRoute('GET', `${base}/readyz`, (req, res, params, query) =>
      this.handleReadyz(req, res, params, query),
    );
    this.addRoute('GET', `${base}/incidents`, (req, res, params, query) =>
      this.handleListIncidents(req, res, params, query),
    );
    this.addRoute('GET', `${base}/incidents/:id`, (req, res, params, query) =>
      this.handleGetIncident(req, res, params, query),
    );
    this.addRoute('GET', `${base}/approvals/pending`, (req, res, params, query) =>
      this.handlePendingApprovals(req, res, params, query),
    );
    this.addRoute('POST', `${base}/approvals/:id/approve`, (req, res, params, query) =>
      this.handleApprove(req, res, params, query),
    );
    this.addRoute('POST', `${base}/approvals/:id/deny`, (req, res, params, query) =>
      this.handleDeny(req, res, params, query),
    );
    this.addRoute('GET', `${base}/audit`, (req, res, params, query) =>
      this.handleAudit(req, res, params, query),
    );
    this.addRoute('GET', `${base}/tools`, (req, res, params, query) =>
      this.handleTools(req, res, params, query),
    );
    this.addRoute('GET', `${base}/metrics`, (req, res, params, query) =>
      this.handleMetrics(req, res, params, query),
    );
  }

  private addRoute(
    method: string,
    path: string,
    handler: Route['handler'],
  ): void {
    const paramNames: string[] = [];
    const patternStr = path.replace(/:([a-zA-Z_]+)/g, (_match, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });

    this.routes.push({
      method,
      pattern: new RegExp(`^${patternStr}$`),
      paramNames,
      handler,
    });
  }

  // ── Request Handling ─────────────────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    this.requestCount++;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', this.config.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const query = url.searchParams;
    const method = req.method ?? 'GET';

    // ── Rate Limiting Gate ─────────────────────────────────────────────
    const clientKey = this.getClientKey(req);
    const rl = this.rateLimiter.tryAcquire(clientKey);
    res.setHeader('X-RateLimit-Limit', String(rl.limit));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rl.resetAt / 1000)));
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(Math.ceil((rl.resetAt - Date.now()) / 1000)));
      this.sendJson(res, 429, {
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${Math.ceil((rl.resetAt - Date.now()) / 1000)}s`,
        retryAfter: Math.ceil((rl.resetAt - Date.now()) / 1000),
      });
      return;
    }

    // ── Authentication Gate ────────────────────────────────────────────
    const authService = this.deps?.authService;
    if (authService?.enabled) {
      if (!authService.isPublicPath(pathname)) {
        const identity = authService.authenticate(
          req.headers as Record<string, string | string[] | undefined>,
        );
        if (!identity) {
          this.sendJson(res, 401, {
            error: 'Unauthorized',
            message: 'Valid Bearer token or X-API-Key required',
          });
          return;
        }
        // Attach identity for downstream handlers
        (req as unknown as Record<string, unknown>).__authIdentity = identity;
      }
    }

    const match = this.matchRoute(method, pathname);
    if (match) {
      await match.handler(req, res, match.params, query);
    } else {
      this.sendJson(res, 404, { error: 'Not found', path: pathname });
    }
  }

  private matchRoute(method: string, pathname: string): RouteMatch | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;

      const match = pathname.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = match[i + 1];
        });
        return { handler: route.handler, params };
      }
    }
    return null;
  }

  // ── Route Handlers ───────────────────────────────────────────────────────

  private async handleHealth(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    _params: Record<string, string>,
    _query: URLSearchParams,
  ): Promise<void> {
    const modules = this.deps?.getModuleHealths?.() ?? {};

    const overallHealthy = Object.values(modules).every(
      (h) => h.status !== 'unhealthy',
    );

    const health = {
      status: overallHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      modules: Object.fromEntries(
        Object.entries(modules).map(([id, h]) => [
          id,
          { status: h.status, message: h.message },
        ]),
      ),
    };

    this.sendJson(res, overallHealthy ? 200 : 503, health);
  }

  /**
   * Liveness probe — returns 200 if the process is running.
   * Used by container orchestrators to detect deadlocked processes.
   */
  private async handleLivez(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    _params: Record<string, string>,
    _query: URLSearchParams,
  ): Promise<void> {
    this.sendJson(res, 200, { status: 'alive', timestamp: new Date().toISOString() });
  }

  /**
   * Readiness probe — returns 200 if healthy, 503 if degraded/unhealthy.
   * Used by load balancers to route traffic only to ready instances.
   */
  private async handleReadyz(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    _params: Record<string, string>,
    _query: URLSearchParams,
  ): Promise<void> {
    const modules = this.deps?.getModuleHealths?.() ?? {};
    const ready = Object.values(modules).every(
      (h) => h.status !== 'unhealthy',
    );
    this.sendJson(res, ready ? 200 : 503, {
      status: ready ? 'ready' : 'not-ready',
      timestamp: new Date().toISOString(),
    });
  }

  private async handleListIncidents(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    _params: Record<string, string>,
    query: URLSearchParams,
  ): Promise<void> {
    if (!this.deps?.storage) {
      this.sendJson(res, 503, { error: 'Storage not available' });
      return;
    }

    let incidents = await this.deps.storage.list<StoredIncident>('incidents');

    // Apply filters
    const severity = query.get('severity');
    if (severity) {
      incidents = incidents.filter((i) => i.severity === severity);
    }

    const status = query.get('status');
    if (status) {
      incidents = incidents.filter((i) => i.status === status);
    }

    // Sort newest first
    incidents.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const limit = parseInt(query.get('limit') ?? '100', 10);
    if (limit > 0) {
      incidents = incidents.slice(0, limit);
    }

    this.sendJson(res, 200, {
      count: incidents.length,
      incidents,
    });
  }

  private async handleGetIncident(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    params: Record<string, string>,
    _query: URLSearchParams,
  ): Promise<void> {
    if (!this.deps?.storage) {
      this.sendJson(res, 503, { error: 'Storage not available' });
      return;
    }

    const incident = await this.deps.storage.get<StoredIncident>(
      'incidents',
      params.id,
    );

    if (!incident) {
      this.sendJson(res, 404, { error: 'Incident not found', id: params.id });
      return;
    }

    this.sendJson(res, 200, incident);
  }

  private async handlePendingApprovals(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    _params: Record<string, string>,
    _query: URLSearchParams,
  ): Promise<void> {
    if (!this.deps?.storage) {
      this.sendJson(res, 503, { error: 'Storage not available' });
      return;
    }

    // Query pending approval requests from storage
    const allRequests = await this.deps.storage.list<StoredApprovalRequest>(
      'system::approval_requests',
    );

    const pending = allRequests.filter((r) => r.status === 'pending');

    this.sendJson(res, 200, {
      count: pending.length,
      requests: pending,
    });
  }

  private async handleApprove(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    params: Record<string, string>,
    _query: URLSearchParams,
  ): Promise<void> {
    if (!this.deps?.approvalGate) {
      this.sendJson(res, 503, { error: 'Approval gate not available' });
      return;
    }

    try {
      const body = await this.readBody(req);
      const approvedBy = String(body.approvedBy ?? 'api-user');

      const token = await this.deps.approvalGate.approve(
        params.id,
        approvedBy,
      );

      await this.deps.auditLogger?.log({
        action: 'api.approval.approved',
        actor: approvedBy,
        target: params.id,
        details: { via: 'rest-api' },
      });

      this.sendJson(res, 200, {
        message: 'Approved',
        requestId: params.id,
        token: {
          id: token.id,
          expiresAt: token.expiresAt,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 400, { error: message });
    }
  }

  private async handleDeny(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    params: Record<string, string>,
    _query: URLSearchParams,
  ): Promise<void> {
    if (!this.deps?.approvalGate) {
      this.sendJson(res, 503, { error: 'Approval gate not available' });
      return;
    }

    try {
      const body = await this.readBody(req);
      const deniedBy = String(body.deniedBy ?? 'api-user');
      const reason = body.reason ? String(body.reason) : undefined;

      await this.deps.approvalGate.deny(params.id, deniedBy, reason);

      await this.deps.auditLogger?.log({
        action: 'api.approval.denied',
        actor: deniedBy,
        target: params.id,
        details: { via: 'rest-api', reason },
      });

      this.sendJson(res, 200, {
        message: 'Denied',
        requestId: params.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 400, { error: message });
    }
  }

  private async handleAudit(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    _params: Record<string, string>,
    query: URLSearchParams,
  ): Promise<void> {
    if (!this.deps?.auditLogger) {
      this.sendJson(res, 503, { error: 'Audit logger not available' });
      return;
    }

    const filter: Record<string, unknown> = {};
    if (query.has('action')) filter.action = query.get('action');
    if (query.has('actor')) filter.actor = query.get('actor');
    if (query.has('limit')) filter.limit = parseInt(query.get('limit')!, 10);

    const entries = await this.deps.auditLogger.query(filter);

    this.sendJson(res, 200, {
      count: entries.length,
      entries,
    });
  }

  private async handleTools(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    _params: Record<string, string>,
    _query: URLSearchParams,
  ): Promise<void> {
    if (!this.deps?.toolRegistry) {
      this.sendJson(res, 503, { error: 'Tool registry not available' });
      return;
    }

    const tools = this.deps.toolRegistry.listTools();

    this.sendJson(res, 200, {
      count: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        registeredBy: t.registeredBy,
        requiresApproval: t.requiresApproval,
        tags: t.tags,
      })),
    });
  }

  private async handleMetrics(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    _params: Record<string, string>,
    _query: URLSearchParams,
  ): Promise<void> {
    const moduleHealths = this.deps?.getModuleHealths?.() ?? {};

    // Add API-specific metrics
    this.metricsCollector.clearCustomMetrics();
    this.metricsCollector.registerMetric({
      name: 'http_requests_total',
      type: 'counter',
      help: 'Total HTTP requests served',
      value: this.requestCount,
    });
    this.metricsCollector.registerMetric({
      name: 'http_errors_total',
      type: 'counter',
      help: 'Total HTTP errors',
      value: this.errorCount,
    });

    const body = this.metricsCollector.collect(moduleHealths);
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
    res.end(body);
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  private sendJson(
    res: http.ServerResponse,
    statusCode: number,
    data: unknown,
  ): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  private readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  // ── Getter for testing ───────────────────────────────────────────────────

  getServer(): http.Server | null {
    return this.server;
  }

  getConfig(): ApiConfig {
    return this.config;
  }

  getRateLimiter(): KeyedRateLimiter {
    return this.rateLimiter;
  }

  // ── Internal Helpers ─────────────────────────────────────────────────────

  private getClientKey(req: http.IncomingMessage): string {
    // Use API key or auth identity as client key for authenticated users;
    // otherwise fall back to IP address.
    const apiKey = req.headers['x-api-key'];
    if (apiKey) return `key:${typeof apiKey === 'string' ? apiKey.slice(0, 8) : 'arr'}`;

    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded[0];
      return `ip:${ip}`;
    }

    return `ip:${req.socket.remoteAddress ?? 'unknown'}`;
  }
}
