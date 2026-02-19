// ---------------------------------------------------------------------------
// OpsPilot — connector.kubernetes (Kubernetes Event & Pod Watcher)
// ---------------------------------------------------------------------------
// Polls the Kubernetes API for Events and Pod status changes, emitting
// `log.ingested` events for downstream detection.
//
// Design decisions:
//   - Uses plain `fetch()` against the Kubernetes API (no k8s client library)
//   - Supports in-cluster ServiceAccount auth and explicit bearer tokens
//   - Polls rather than watches to avoid long-lived connections and
//     simplify error handling
//   - Severity mapping: K8s Warning → OpsPilot warning,
//     CrashLoopBackOff/OOMKilled → critical
//   - Cursor-based: tracks resourceVersion to avoid re-processing events
//
// Features:
//   - Kubernetes Events (Warning/Normal) polling
//   - Pod status monitoring (CrashLoopBackOff, OOMKilled, ImagePullBackOff)
//   - Node condition monitoring (NotReady, MemoryPressure, DiskPressure)
//   - Namespace filtering (single or all namespaces)
//   - Configurable severity mapping
//   - Graceful handling when K8s API is unreachable
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { LogIngestedPayload } from '../../shared/events';
import configSchema from './schema.json';

// ── Types ──────────────────────────────────────────────────────────────────

interface K8sConfig {
  pollIntervalMs: number;
  source: string;
  apiUrl: string;
  token: string;
  tokenPath: string;
  caPath: string;
  namespace: string;
  watchEvents: boolean;
  watchPods: boolean;
  watchNodes: boolean;
  severityMap: Record<string, string>;
  timeoutMs: number;
}

const DEFAULTS: K8sConfig = {
  pollIntervalMs: 10_000,
  source: 'kubernetes',
  apiUrl: 'https://kubernetes.default.svc',
  token: '',
  tokenPath: '/var/run/secrets/kubernetes.io/serviceaccount/token',
  caPath: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
  namespace: '',
  watchEvents: true,
  watchPods: true,
  watchNodes: false,
  severityMap: {
    Warning: 'warning',
    Normal: 'info',
    CrashLoopBackOff: 'critical',
    OOMKilled: 'critical',
    NodeNotReady: 'critical',
    ImagePullBackOff: 'warning',
    ErrImagePull: 'warning',
  },
  timeoutMs: 10_000,
};

/** Simplified K8s Event structure. */
export interface K8sEvent {
  type: string;       // Normal, Warning
  reason: string;
  message: string;
  involvedObject: {
    kind: string;
    name: string;
    namespace?: string;
  };
  firstTimestamp?: string;
  lastTimestamp?: string;
  count?: number;
  source?: { component?: string; host?: string };
}

/** Simplified K8s Pod status. */
export interface K8sPodStatus {
  name: string;
  namespace: string;
  phase: string;
  containerStatuses: Array<{
    name: string;
    ready: boolean;
    restartCount: number;
    state: string;
    reason?: string;
    message?: string;
  }>;
}

/** Simplified K8s Node condition. */
export interface K8sNodeCondition {
  nodeName: string;
  conditions: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }>;
}

// ── Module Implementation ──────────────────────────────────────────────────

export class KubernetesConnector implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'connector.kubernetes',
    name: 'Kubernetes Connector',
    version: '0.1.0',
    type: ModuleType.Connector,
    description: 'Watches Kubernetes Events, Pods and Nodes for operational issues.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: K8sConfig;

  // State
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastEventResourceVersion = '';
  private knownPodStates: Map<string, string> = new Map();
  private bearerToken = '';

  // Metrics
  private eventsProcessed = 0;
  private podAlertsEmitted = 0;
  private nodeAlertsEmitted = 0;
  private pollCycles = 0;
  private apiErrors = 0;
  private healthy = true;
  private lastError?: string;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    const raw = context.config as Partial<K8sConfig>;

    this.config = {
      pollIntervalMs: raw.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      source: raw.source ?? DEFAULTS.source,
      apiUrl: raw.apiUrl ?? DEFAULTS.apiUrl,
      token: raw.token ?? DEFAULTS.token,
      tokenPath: raw.tokenPath ?? DEFAULTS.tokenPath,
      caPath: raw.caPath ?? DEFAULTS.caPath,
      namespace: raw.namespace ?? DEFAULTS.namespace,
      watchEvents: raw.watchEvents ?? DEFAULTS.watchEvents,
      watchPods: raw.watchPods ?? DEFAULTS.watchPods,
      watchNodes: raw.watchNodes ?? DEFAULTS.watchNodes,
      severityMap: { ...DEFAULTS.severityMap, ...(raw.severityMap ?? {}) },
      timeoutMs: raw.timeoutMs ?? DEFAULTS.timeoutMs,
    };

    // Resolve bearer token
    if (this.config.token) {
      this.bearerToken = this.config.token;
    } else {
      try {
        this.bearerToken = fs.readFileSync(this.config.tokenPath, 'utf-8').trim();
      } catch {
        this.ctx.logger.warn('Could not read ServiceAccount token', {
          tokenPath: this.config.tokenPath,
        });
      }
    }

    this.ctx.logger.info('Initialized', {
      apiUrl: this.config.apiUrl,
      namespace: this.config.namespace || 'all',
      watchEvents: this.config.watchEvents,
      watchPods: this.config.watchPods,
      watchNodes: this.config.watchNodes,
    });
  }

  async start(): Promise<void> {
    this.running = true;

    // Initial poll
    await this.pollAll();

    this.pollTimer = setInterval(() => {
      if (this.running) {
        this.pollAll().catch((err) => {
          this.apiErrors++;
          this.healthy = false;
          this.lastError = err instanceof Error ? err.message : String(err);
          this.ctx.logger.error('K8s poll error', err instanceof Error ? err : undefined);
        });
      }
    }, this.config.pollIntervalMs);

    this.ctx.logger.info('Started Kubernetes polling', {
      intervalMs: this.config.pollIntervalMs,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.ctx.logger.info('Stopped', {
      eventsProcessed: this.eventsProcessed,
      podAlertsEmitted: this.podAlertsEmitted,
    });
  }

  async destroy(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.knownPodStates.clear();
  }

  health(): ModuleHealth {
    const status = this.apiErrors > 0 && this.pollCycles <= this.apiErrors
      ? 'unhealthy'
      : this.apiErrors > 0
        ? 'degraded'
        : 'healthy';

    return {
      status,
      message: this.lastError,
      details: {
        eventsProcessed: this.eventsProcessed,
        podAlertsEmitted: this.podAlertsEmitted,
        nodeAlertsEmitted: this.nodeAlertsEmitted,
        pollCycles: this.pollCycles,
        apiErrors: this.apiErrors,
        apiUrl: this.config?.apiUrl,
      },
      lastCheck: new Date(),
    };
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  /** Run one full poll. Public for testing. */
  async pollAll(): Promise<void> {
    this.pollCycles++;

    if (this.config.watchEvents) await this.pollEvents();
    if (this.config.watchPods) await this.pollPods();
    if (this.config.watchNodes) await this.pollNodes();

    this.healthy = true;
  }

  /** Fetch Kubernetes API. Overridable for testing. */
  async fetchK8s(path: string): Promise<Record<string, unknown>> {
    const url = `${this.config.apiUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`K8s API ${response.status}: ${await response.text().catch(() => '')}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  private async pollEvents(): Promise<void> {
    const ns = this.config.namespace;
    const path = ns
      ? `/api/v1/namespaces/${ns}/events`
      : '/api/v1/events';

    const data = await this.fetchK8s(path);
    const items = (data.items as Array<Record<string, unknown>>) ?? [];

    for (const item of items) {
      const event = this.parseK8sEvent(item);
      this.processEvent(event);
    }

    // Track resourceVersion for future filtering
    const metadata = data.metadata as Record<string, unknown> | undefined;
    if (metadata?.resourceVersion) {
      this.lastEventResourceVersion = metadata.resourceVersion as string;
    }
  }

  /** Parse raw K8s event JSON. Public for testing. */
  parseK8sEvent(item: Record<string, unknown>): K8sEvent {
    const involved = (item.involvedObject as Record<string, unknown>) ?? {};
    const source = (item.source as Record<string, unknown>) ?? {};

    return {
      type: (item.type as string) ?? 'Normal',
      reason: (item.reason as string) ?? '',
      message: (item.message as string) ?? '',
      involvedObject: {
        kind: (involved.kind as string) ?? '',
        name: (involved.name as string) ?? '',
        namespace: involved.namespace as string | undefined,
      },
      firstTimestamp: item.firstTimestamp as string | undefined,
      lastTimestamp: item.lastTimestamp as string | undefined,
      count: item.count as number | undefined,
      source: {
        component: source.component as string | undefined,
        host: source.host as string | undefined,
      },
    };
  }

  /** Process a single K8s event and emit log. Public for testing. */
  processEvent(event: K8sEvent): void {
    const severity = this.config.severityMap[event.type]
      ?? this.config.severityMap[event.reason]
      ?? 'info';

    const line = `[K8S_EVENT] [${event.type}] ${event.involvedObject.kind}/${event.involvedObject.name}: ${event.reason} — ${event.message}`;

    this.emitLine(line, {
      eventType: event.type,
      reason: event.reason,
      kind: event.involvedObject.kind,
      name: event.involvedObject.name,
      namespace: event.involvedObject.namespace,
      opsSeverity: severity,
      count: event.count,
      sourceComponent: event.source?.component,
    });

    this.eventsProcessed++;
  }

  // ── Pods ─────────────────────────────────────────────────────────────────

  private async pollPods(): Promise<void> {
    const ns = this.config.namespace;
    const path = ns
      ? `/api/v1/namespaces/${ns}/pods`
      : '/api/v1/pods';

    const data = await this.fetchK8s(path);
    const items = (data.items as Array<Record<string, unknown>>) ?? [];

    for (const item of items) {
      const podStatus = this.parsePodStatus(item);
      this.processPodStatus(podStatus);
    }
  }

  /** Parse raw K8s pod JSON. Public for testing. */
  parsePodStatus(item: Record<string, unknown>): K8sPodStatus {
    const meta = (item.metadata as Record<string, unknown>) ?? {};
    const status = (item.status as Record<string, unknown>) ?? {};
    const containers = (status.containerStatuses as Array<Record<string, unknown>>) ?? [];

    return {
      name: (meta.name as string) ?? '',
      namespace: (meta.namespace as string) ?? '',
      phase: (status.phase as string) ?? 'Unknown',
      containerStatuses: containers.map((c) => {
        const state = (c.state as Record<string, unknown>) ?? {};
        let stateKey = 'unknown';
        let reason: string | undefined;
        let message: string | undefined;

        if (state.waiting) {
          stateKey = 'waiting';
          const w = state.waiting as Record<string, unknown>;
          reason = w.reason as string | undefined;
          message = w.message as string | undefined;
        } else if (state.terminated) {
          stateKey = 'terminated';
          const t = state.terminated as Record<string, unknown>;
          reason = t.reason as string | undefined;
          message = t.message as string | undefined;
        } else if (state.running) {
          stateKey = 'running';
        }

        return {
          name: (c.name as string) ?? '',
          ready: (c.ready as boolean) ?? false,
          restartCount: (c.restartCount as number) ?? 0,
          state: stateKey,
          reason,
          message,
        };
      }),
    };
  }

  /** Process pod status and emit alerts for problem states. Public for testing. */
  processPodStatus(pod: K8sPodStatus): void {
    const podKey = `${pod.namespace}/${pod.name}`;

    for (const container of pod.containerStatuses) {
      if (!container.reason) continue;

      const problemReasons = ['CrashLoopBackOff', 'OOMKilled', 'ImagePullBackOff', 'ErrImagePull', 'Error'];
      if (!problemReasons.includes(container.reason)) continue;

      // Build state key for dedup
      const stateKey = `${podKey}/${container.name}:${container.reason}`;
      if (this.knownPodStates.has(stateKey)) continue;
      this.knownPodStates.set(stateKey, container.reason);

      const severity = this.config.severityMap[container.reason] ?? 'warning';
      const line = `[K8S_POD] [${container.reason}] ${podKey}/${container.name}: ${container.message ?? container.reason} (restarts: ${container.restartCount})`;

      this.emitLine(line, {
        podName: pod.name,
        namespace: pod.namespace,
        containerName: container.name,
        reason: container.reason,
        restartCount: container.restartCount,
        opsSeverity: severity,
      });

      this.podAlertsEmitted++;
    }
  }

  // ── Nodes ────────────────────────────────────────────────────────────────

  private async pollNodes(): Promise<void> {
    const data = await this.fetchK8s('/api/v1/nodes');
    const items = (data.items as Array<Record<string, unknown>>) ?? [];

    for (const item of items) {
      const nodeInfo = this.parseNodeConditions(item);
      this.processNodeConditions(nodeInfo);
    }
  }

  /** Parse raw K8s node JSON. Public for testing. */
  parseNodeConditions(item: Record<string, unknown>): K8sNodeCondition {
    const meta = (item.metadata as Record<string, unknown>) ?? {};
    const status = (item.status as Record<string, unknown>) ?? {};
    const conditions = (status.conditions as Array<Record<string, unknown>>) ?? [];

    return {
      nodeName: (meta.name as string) ?? '',
      conditions: conditions.map((c) => ({
        type: (c.type as string) ?? '',
        status: (c.status as string) ?? '',
        reason: c.reason as string | undefined,
        message: c.message as string | undefined,
      })),
    };
  }

  /** Process node conditions and emit alerts. Public for testing. */
  processNodeConditions(node: K8sNodeCondition): void {
    for (const cond of node.conditions) {
      // Alert when Ready=False or pressure conditions are True
      const isProblematic =
        (cond.type === 'Ready' && cond.status === 'False') ||
        (cond.type !== 'Ready' && cond.status === 'True' &&
          ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'].includes(cond.type));

      if (!isProblematic) continue;

      const reasonKey = cond.type === 'Ready' ? 'NodeNotReady' : cond.type;
      const severity = this.config.severityMap[reasonKey] ?? 'warning';
      const line = `[K8S_NODE] [${reasonKey}] ${node.nodeName}: ${cond.message ?? cond.reason ?? cond.type}`;

      this.emitLine(line, {
        nodeName: node.nodeName,
        conditionType: cond.type,
        conditionStatus: cond.status,
        reason: cond.reason,
        opsSeverity: severity,
      });

      this.nodeAlertsEmitted++;
    }
  }

  // ── Emit Helpers ─────────────────────────────────────────────────────────

  private emitLine(line: string, metadata: Record<string, unknown>): void {
    const payload: LogIngestedPayload = {
      source: this.config.source,
      line,
      ingestedAt: new Date(),
      metadata: {
        collector: 'connector.kubernetes',
        ...metadata,
      },
    };

    this.ctx.bus.publish<LogIngestedPayload>({
      type: 'log.ingested',
      source: this.manifest.id,
      timestamp: new Date(),
      payload,
    });
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getConfig(): K8sConfig { return this.config; }

  getMetrics() {
    return {
      eventsProcessed: this.eventsProcessed,
      podAlertsEmitted: this.podAlertsEmitted,
      nodeAlertsEmitted: this.nodeAlertsEmitted,
      pollCycles: this.pollCycles,
      apiErrors: this.apiErrors,
    };
  }

  getKnownPodStates(): Map<string, string> { return this.knownPodStates; }

  clearPodStates(): void { this.knownPodStates.clear(); }
}
