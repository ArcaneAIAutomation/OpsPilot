// ---------------------------------------------------------------------------
// OpsPilot — enricher.correlator (Incident Correlation Engine)
// ---------------------------------------------------------------------------
// Groups related incidents that arrive within a configurable time window.
// Uses keyword similarity (Jaccard index on tokenised titles/descriptions)
// and optional source matching to decide whether a new incident belongs to
// an existing correlation group.
//
// When a group crosses the "storm threshold", the module emits an
// `incident.storm` event so downstream notifiers can aggregate alerts
// instead of flooding operators with duplicates.
//
// Features:
//   - Time-windowed grouping (default 60 s)
//   - Keyword-based Jaccard similarity (configurable threshold)
//   - Per-group storm detection with configurable threshold
//   - Emits `enrichment.completed` with correlation data for every matched
//     incident so the Incident Store can track relationships
//   - Emits `incident.storm` when a group exceeds stormThreshold
//   - Automatic group expiry (configurable TTL, default 1 h)
//   - Capped group retention (maxGroups, LRU-like eviction)
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
  EnrichmentCompletedPayload,
} from '../../shared/events';
import configSchema from './schema.json';

// ── Types ──────────────────────────────────────────────────────────────────

interface CorrelatorConfig {
  timeWindowMs: number;
  similarityThreshold: number;
  maxGroupSize: number;
  stormThreshold: number;
  maxGroups: number;
  groupTtlMs: number;
}

const DEFAULTS: CorrelatorConfig = {
  timeWindowMs: 60_000,
  similarityThreshold: 0.4,
  maxGroupSize: 50,
  stormThreshold: 5,
  maxGroups: 500,
  groupTtlMs: 3_600_000,
};

/** A correlation group holds references to related incidents. */
export interface CorrelationGroup {
  /** Unique group identifier. */
  id: string;

  /** ID of the first (root) incident in this group. */
  rootIncidentId: string;

  /** IDs of all member incidents (including root). */
  memberIds: string[];

  /** Combined keyword set from all member titles + descriptions. */
  keywords: Set<string>;

  /** Source module of the root incident. */
  source: string;

  /** Severity of the root incident. */
  severity: string;

  /** Timestamp of the first incident. */
  createdAt: number;

  /** Timestamp of the most recent addition. */
  lastActivityAt: number;

  /** Whether a storm alert has been emitted for this group. */
  stormEmitted: boolean;
}

/** Payload for `incident.storm` events. */
export interface IncidentStormPayload {
  groupId: string;
  rootIncidentId: string;
  memberCount: number;
  severity: string;
  source: string;
  timeWindowMs: number;
  titles: string[];
}

// ── Utility Functions (exported for testability) ───────────────────────────

/**
 * Tokenise a string into a lowercased word set.
 * Strips non-alphanumeric characters and drops tokens ≤ 2 chars.
 */
export function tokenize(text: string): Set<string> {
  const result = new Set<string>();
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  for (const w of words) {
    if (w.length > 2) result.add(w);
  }
  return result;
}

/**
 * Compute the Jaccard similarity coefficient between two sets.
 * Returns a value in [0, 1]. Returns 0 if both sets are empty.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersectionSize = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const item of smaller) {
    if (larger.has(item)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

// ── Module Implementation ──────────────────────────────────────────────────

let groupCounter = 0;

export class IncidentCorrelator implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'enricher.correlator',
    name: 'Incident Correlator',
    version: '0.1.0',
    type: ModuleType.Enricher,
    description: 'Groups related incidents by time proximity and keyword similarity.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: CorrelatorConfig;
  private subscriptions: EventSubscription[] = [];
  private groups: Map<string, CorrelationGroup> = new Map();
  private expiryTimer: ReturnType<typeof setInterval> | undefined;

  // Metrics
  private totalCorrelated = 0;
  private totalGroups = 0;
  private totalStorms = 0;
  private totalExpired = 0;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    this.config = { ...DEFAULTS, ...context.config } as CorrelatorConfig;
    this.ctx.logger.info('Initialized', {
      timeWindowMs: this.config.timeWindowMs,
      similarityThreshold: this.config.similarityThreshold,
      stormThreshold: this.config.stormThreshold,
    });
  }

  async start(): Promise<void> {
    this.subscriptions.push(
      this.ctx.bus.subscribe<IncidentCreatedPayload>(
        'incident.created',
        (event) => this.onIncidentCreated(event),
      ),
    );

    // Periodic expiry sweep
    this.expiryTimer = setInterval(() => this.expireGroups(), Math.min(this.config.groupTtlMs / 4, 60_000));

    this.ctx.logger.info('Started — listening for incident.created');
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions = [];
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    this.ctx.logger.info('Stopped', {
      totalCorrelated: this.totalCorrelated,
      totalGroups: this.totalGroups,
      totalStorms: this.totalStorms,
    });
  }

  async destroy(): Promise<void> {
    this.groups.clear();
    this.subscriptions = [];
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = undefined;
    }
  }

  health(): ModuleHealth {
    return {
      status: 'healthy',
      details: {
        activeGroups: this.groups.size,
        totalCorrelated: this.totalCorrelated,
        totalGroups: this.totalGroups,
        totalStorms: this.totalStorms,
        totalExpired: this.totalExpired,
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Handling ───────────────────────────────────────────────────────

  private async onIncidentCreated(
    event: OpsPilotEvent<IncidentCreatedPayload>,
  ): Promise<void> {
    const p = event.payload;
    const now = Date.now();
    const keywords = tokenize(`${p.title} ${p.description}`);

    // Try to find a matching group
    const match = this.findMatchingGroup(keywords, p.detectedBy, now);

    if (match) {
      // Add to existing group
      if (match.memberIds.length >= this.config.maxGroupSize) {
        this.ctx.logger.warn('Correlation group at capacity', {
          groupId: match.id,
          maxGroupSize: this.config.maxGroupSize,
        });
        return;
      }

      match.memberIds.push(p.incidentId);
      // Merge keywords
      for (const kw of keywords) match.keywords.add(kw);
      match.lastActivityAt = now;
      this.totalCorrelated++;

      // Emit enrichment for the correlated incident
      await this.emitCorrelationEnrichment(p.incidentId, match, event.correlationId);

      // Storm detection
      if (
        match.memberIds.length >= this.config.stormThreshold &&
        !match.stormEmitted
      ) {
        match.stormEmitted = true;
        this.totalStorms++;
        await this.emitStormAlert(match);
      }
    } else {
      // Create a new group
      this.enforceGroupCapacity();
      const groupId = `CG-${++groupCounter}-${Date.now()}`;
      const group: CorrelationGroup = {
        id: groupId,
        rootIncidentId: p.incidentId,
        memberIds: [p.incidentId],
        keywords,
        source: p.detectedBy,
        severity: p.severity,
        createdAt: now,
        lastActivityAt: now,
        stormEmitted: false,
      };
      this.groups.set(groupId, group);
      this.totalGroups++;
    }
  }

  /**
   * Find the best matching active group for the given keywords and source.
   * Returns the group with the highest similarity score above the threshold,
   * or null if none qualify.
   */
  private findMatchingGroup(
    keywords: Set<string>,
    source: string,
    now: number,
  ): CorrelationGroup | null {
    let bestGroup: CorrelationGroup | null = null;
    let bestScore = 0;

    for (const group of this.groups.values()) {
      // Time window check
      if (now - group.lastActivityAt > this.config.timeWindowMs) continue;

      // Size check
      if (group.memberIds.length >= this.config.maxGroupSize) continue;

      // Similarity
      const sim = jaccardSimilarity(keywords, group.keywords);

      // Source match bonus: if same source, lower the effective threshold
      const effectiveThreshold = source === group.source
        ? this.config.similarityThreshold * 0.7
        : this.config.similarityThreshold;

      if (sim >= effectiveThreshold && sim > bestScore) {
        bestScore = sim;
        bestGroup = group;
      }
    }

    return bestGroup;
  }

  /**
   * Emit an enrichment.completed event linking an incident to its correlation
   * group.
   */
  private async emitCorrelationEnrichment(
    incidentId: string,
    group: CorrelationGroup,
    correlationId?: string,
  ): Promise<void> {
    const payload: EnrichmentCompletedPayload = {
      incidentId,
      enricherModule: this.manifest.id,
      enrichmentType: 'correlation',
      data: {
        groupId: group.id,
        rootIncidentId: group.rootIncidentId,
        memberCount: group.memberIds.length,
        isStorm: group.stormEmitted,
      },
      completedAt: new Date(),
    };

    await this.ctx.bus.publish<EnrichmentCompletedPayload>({
      type: 'enrichment.completed',
      source: this.manifest.id,
      timestamp: new Date(),
      correlationId,
      payload,
    });
  }

  /**
   * Emit an incident.storm event when a group crosses the storm threshold.
   */
  private async emitStormAlert(group: CorrelationGroup): Promise<void> {
    const payload: IncidentStormPayload = {
      groupId: group.id,
      rootIncidentId: group.rootIncidentId,
      memberCount: group.memberIds.length,
      severity: group.severity,
      source: group.source,
      timeWindowMs: this.config.timeWindowMs,
      titles: [], // will be populated by caller if needed
    };

    await this.ctx.bus.publish<IncidentStormPayload>({
      type: 'incident.storm',
      source: this.manifest.id,
      timestamp: new Date(),
      payload,
    });

    this.ctx.logger.warn('Incident storm detected', {
      groupId: group.id,
      memberCount: group.memberIds.length,
      severity: group.severity,
    });
  }

  /**
   * Remove groups that have expired (exceeded groupTtlMs since last activity).
   */
  private expireGroups(): void {
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, group] of this.groups) {
      if (now - group.lastActivityAt > this.config.groupTtlMs) {
        expired.push(id);
      }
    }
    for (const id of expired) {
      this.groups.delete(id);
      this.totalExpired++;
    }
    if (expired.length > 0) {
      this.ctx.logger.debug('Expired correlation groups', { count: expired.length });
    }
  }

  /**
   * Enforce maxGroups by evicting the oldest inactive group.
   */
  private enforceGroupCapacity(): void {
    while (this.groups.size >= this.config.maxGroups) {
      let oldestId: string | undefined;
      let oldestTime = Infinity;
      for (const [id, group] of this.groups) {
        if (group.lastActivityAt < oldestTime) {
          oldestTime = group.lastActivityAt;
          oldestId = id;
        }
      }
      if (oldestId) {
        this.groups.delete(oldestId);
        this.totalExpired++;
      } else {
        break;
      }
    }
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getGroups(): Map<string, CorrelationGroup> {
    return this.groups;
  }

  getMetrics(): {
    totalCorrelated: number;
    totalGroups: number;
    totalStorms: number;
    totalExpired: number;
    activeGroups: number;
  } {
    return {
      totalCorrelated: this.totalCorrelated,
      totalGroups: this.totalGroups,
      totalStorms: this.totalStorms,
      totalExpired: this.totalExpired,
      activeGroups: this.groups.size,
    };
  }

  getConfig(): CorrelatorConfig {
    return this.config;
  }
}
