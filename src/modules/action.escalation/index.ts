// ---------------------------------------------------------------------------
// OpsPilot — action.escalation (Escalation Engine)
// ---------------------------------------------------------------------------
// Watches for open incidents and escalates them through configurable policy
// levels when they remain unresolved for too long.
//
// The engine works by:
//   1. Subscribing to `incident.created` to start tracking new incidents
//   2. Subscribing to `incident.updated` to detect acknowledgement / resolution
//   3. Running a periodic sweep (checkIntervalMs) that compares each
//      tracked incident's age against its matching policy levels
//   4. Emitting `incident.escalated` events when thresholds are exceeded
//   5. Emitting `enrichment.completed` with escalation metadata
//
// Policies are matched by severity and/or title regex. Multiple policies
// can match; the first match wins. Each policy has ordered levels with
// increasing timeouts.
//
// Acknowledging an incident optionally pauses escalation timers. Resolved
// or closed incidents are automatically dropped from tracking.
// ---------------------------------------------------------------------------

import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { OpsPilotEvent, EventSubscription } from '../../core/types/events';
import {
  IncidentCreatedPayload,
  IncidentUpdatedPayload,
  EnrichmentCompletedPayload,
} from '../../shared/events';
import configSchema from './schema.json';

// ── Types ──────────────────────────────────────────────────────────────────

interface EscalationLevel {
  level: number;
  afterMs: number;
  notify: string[];
  repeat: boolean;
  repeatIntervalMs?: number;
}

interface EscalationPolicy {
  id: string;
  matchSeverity?: string[];
  matchTitlePattern?: string;
  levels: EscalationLevel[];
}

interface EscalationConfig {
  checkIntervalMs: number;
  policies: EscalationPolicy[];
  maxTrackedIncidents: number;
  resolvedStatuses: string[];
  acknowledgedPausesEscalation: boolean;
}

const DEFAULTS: EscalationConfig = {
  checkIntervalMs: 30_000,
  policies: [],
  maxTrackedIncidents: 5_000,
  resolvedStatuses: ['resolved', 'closed'],
  acknowledgedPausesEscalation: true,
};

/** Tracked escalation state for a single incident. */
export interface EscalationState {
  incidentId: string;
  severity: string;
  title: string;
  policyId: string;
  /** When the incident was created (epoch ms). */
  startedAt: number;
  /** Highest level that has been triggered (0 = none). */
  currentLevel: number;
  /** Status: 'open' | 'acknowledged' | 'escalated' */
  status: 'open' | 'acknowledged' | 'escalated';
  /** When the incident was acknowledged (epoch ms) — pauses timer if configured. */
  acknowledgedAt?: number;
  /** Timestamp of the last notification sent per level. */
  lastNotifiedAt: Map<number, number>;
}

/** Payload for `incident.escalated` events. */
export interface IncidentEscalatedPayload {
  incidentId: string;
  policyId: string;
  level: number;
  notify: string[];
  elapsedMs: number;
  severity: string;
  title: string;
}

// ── Module Implementation ──────────────────────────────────────────────────

export class EscalationEngine implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'action.escalation',
    name: 'Escalation Engine',
    version: '0.1.0',
    type: ModuleType.Action,
    description:
      'Automatically escalates unresolved incidents through configurable policy levels.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: EscalationConfig;
  private subscriptions: EventSubscription[] = [];
  private tracked: Map<string, EscalationState> = new Map();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  // Compiled regexes per policy
  private policyRegexes: Map<string, RegExp> = new Map();

  // Metrics
  private totalEscalations = 0;
  private totalTracked = 0;
  private totalResolved = 0;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    const raw = context.config ?? {};
    this.config = {
      ...DEFAULTS,
      ...raw,
      policies: (raw as Record<string, unknown>).policies
        ? ((raw as Record<string, unknown>).policies as EscalationPolicy[])
        : DEFAULTS.policies,
      resolvedStatuses: (raw as Record<string, unknown>).resolvedStatuses
        ? ((raw as Record<string, unknown>).resolvedStatuses as string[])
        : DEFAULTS.resolvedStatuses,
    };

    // Compile title regexes
    for (const policy of this.config.policies) {
      if (policy.matchTitlePattern) {
        try {
          this.policyRegexes.set(policy.id, new RegExp(policy.matchTitlePattern, 'i'));
        } catch {
          this.ctx.logger.warn('Invalid regex in escalation policy', {
            policyId: policy.id,
            pattern: policy.matchTitlePattern,
          });
        }
      }
      // Sort levels by ascending order
      policy.levels.sort((a, b) => a.level - b.level);
    }

    this.ctx.logger.info('Initialized', {
      policies: this.config.policies.length,
      checkIntervalMs: this.config.checkIntervalMs,
    });
  }

  async start(): Promise<void> {
    this.subscriptions.push(
      this.ctx.bus.subscribe<IncidentCreatedPayload>(
        'incident.created',
        (event) => this.onIncidentCreated(event),
      ),
    );

    this.subscriptions.push(
      this.ctx.bus.subscribe<IncidentUpdatedPayload>(
        'incident.updated',
        (event) => this.onIncidentUpdated(event),
      ),
    );

    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, this.config.checkIntervalMs);

    this.ctx.logger.info('Started — sweeping every', {
      intervalMs: this.config.checkIntervalMs,
    });
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions = [];
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.ctx.logger.info('Stopped', {
      totalEscalations: this.totalEscalations,
      totalTracked: this.totalTracked,
      totalResolved: this.totalResolved,
    });
  }

  async destroy(): Promise<void> {
    this.tracked.clear();
    this.policyRegexes.clear();
    this.subscriptions = [];
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  health(): ModuleHealth {
    return {
      status: 'healthy',
      details: {
        trackedIncidents: this.tracked.size,
        policies: this.config.policies.length,
        totalEscalations: this.totalEscalations,
        totalTracked: this.totalTracked,
        totalResolved: this.totalResolved,
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Handlers ───────────────────────────────────────────────────────

  private onIncidentCreated(event: OpsPilotEvent<IncidentCreatedPayload>): void {
    const payload = event.payload;

    // Find matching policy
    const policy = this.findPolicy(payload.severity, payload.title);
    if (!policy) return; // No applicable policy

    // Enforce capacity
    this.enforceCapacity();

    const state: EscalationState = {
      incidentId: payload.incidentId,
      severity: payload.severity,
      title: payload.title,
      policyId: policy.id,
      startedAt: Date.now(),
      currentLevel: 0,
      status: 'open',
      lastNotifiedAt: new Map(),
    };

    this.tracked.set(payload.incidentId, state);
    this.totalTracked++;

    this.ctx.logger.debug('Tracking incident for escalation', {
      incidentId: payload.incidentId,
      policyId: policy.id,
      levels: policy.levels.length,
    });
  }

  private onIncidentUpdated(event: OpsPilotEvent<IncidentUpdatedPayload>): void {
    const payload = event.payload;
    const state = this.tracked.get(payload.incidentId);
    if (!state) return; // Not tracked

    if (payload.field === 'status') {
      const newStatus = String(payload.newValue);

      if (this.config.resolvedStatuses.includes(newStatus)) {
        this.tracked.delete(payload.incidentId);
        this.totalResolved++;
        this.ctx.logger.debug('Incident resolved — stopped tracking', {
          incidentId: payload.incidentId,
        });
        return;
      }

      if (newStatus === 'acknowledged') {
        state.status = 'acknowledged';
        state.acknowledgedAt = Date.now();
        this.ctx.logger.debug('Incident acknowledged', {
          incidentId: payload.incidentId,
          pausesEscalation: this.config.acknowledgedPausesEscalation,
        });
      }
    }
  }

  // ── Sweep Logic ──────────────────────────────────────────────────────────

  /** Public so tests can call it directly instead of waiting for timers. */
  async sweep(): Promise<void> {
    const now = Date.now();

    for (const [incidentId, state] of this.tracked) {
      // Skip if acknowledged and config says to pause
      if (
        state.status === 'acknowledged' &&
        this.config.acknowledgedPausesEscalation
      ) {
        continue;
      }

      const policy = this.config.policies.find((p) => p.id === state.policyId);
      if (!policy) continue;

      const elapsed = now - state.startedAt;

      // Walk through levels in order to find the highest applicable
      for (const level of policy.levels) {
        if (elapsed < level.afterMs) continue; // Not yet time

        if (level.level > state.currentLevel) {
          // New escalation level reached
          state.currentLevel = level.level;
          state.status = 'escalated';
          state.lastNotifiedAt.set(level.level, now);
          this.totalEscalations++;

          await this.emitEscalation(state, level, elapsed);
        } else if (
          level.level === state.currentLevel &&
          level.repeat &&
          level.repeatIntervalMs
        ) {
          // Check for repeat notification
          const lastNotified = state.lastNotifiedAt.get(level.level) ?? 0;
          if (now - lastNotified >= level.repeatIntervalMs) {
            state.lastNotifiedAt.set(level.level, now);
            await this.emitEscalation(state, level, elapsed);
          }
        }
      }
    }
  }

  // ── Event Emission ───────────────────────────────────────────────────────

  private async emitEscalation(
    state: EscalationState,
    level: EscalationLevel,
    elapsedMs: number,
  ): Promise<void> {
    const escalationPayload: IncidentEscalatedPayload = {
      incidentId: state.incidentId,
      policyId: state.policyId,
      level: level.level,
      notify: level.notify,
      elapsedMs,
      severity: state.severity,
      title: state.title,
    };

    await this.ctx.bus.publish<IncidentEscalatedPayload>({
      type: 'incident.escalated',
      source: this.manifest.id,
      timestamp: new Date(),
      payload: escalationPayload,
    });

    // Also emit enrichment
    const enrichPayload: EnrichmentCompletedPayload = {
      incidentId: state.incidentId,
      enricherModule: this.manifest.id,
      enrichmentType: 'escalation',
      data: {
        policyId: state.policyId,
        level: level.level,
        notify: level.notify,
        elapsedMs,
      },
      completedAt: new Date(),
    };

    await this.ctx.bus.publish<EnrichmentCompletedPayload>({
      type: 'enrichment.completed',
      source: this.manifest.id,
      timestamp: new Date(),
      payload: enrichPayload,
    });

    this.ctx.logger.info('Incident escalated', {
      incidentId: state.incidentId,
      level: level.level,
      policyId: state.policyId,
      elapsedMs,
      notify: level.notify,
    });
  }

  // ── Policy Matching ──────────────────────────────────────────────────────

  private findPolicy(severity: string, title: string): EscalationPolicy | undefined {
    for (const policy of this.config.policies) {
      let match = true;

      // Check severity
      if (policy.matchSeverity && policy.matchSeverity.length > 0) {
        if (!policy.matchSeverity.includes(severity)) {
          match = false;
        }
      }

      // Check title pattern
      if (match && policy.matchTitlePattern) {
        const regex = this.policyRegexes.get(policy.id);
        if (regex && !regex.test(title)) {
          match = false;
        }
      }

      if (match) return policy;
    }
    return undefined;
  }

  // ── Capacity Management ──────────────────────────────────────────────────

  private enforceCapacity(): void {
    while (this.tracked.size >= this.config.maxTrackedIncidents) {
      // Evict oldest
      let oldestId: string | undefined;
      let oldestTime = Infinity;
      for (const [id, state] of this.tracked) {
        if (state.startedAt < oldestTime) {
          oldestTime = state.startedAt;
          oldestId = id;
        }
      }
      if (oldestId) {
        this.tracked.delete(oldestId);
      } else {
        break;
      }
    }
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getTracked(): Map<string, EscalationState> {
    return this.tracked;
  }

  getMetrics(): {
    totalEscalations: number;
    totalTracked: number;
    totalResolved: number;
    activeTracked: number;
  } {
    return {
      totalEscalations: this.totalEscalations,
      totalTracked: this.totalTracked,
      totalResolved: this.totalResolved,
      activeTracked: this.tracked.size,
    };
  }

  getConfig(): EscalationConfig {
    return this.config;
  }
}
