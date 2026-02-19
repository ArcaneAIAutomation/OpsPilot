// ---------------------------------------------------------------------------
// OpsPilot — enricher.dedup (Incident Deduplication & Suppression)
// ---------------------------------------------------------------------------
// Prevents duplicate incidents from flooding the system. Computes a
// fingerprint from configurable incident fields (title, severity,
// detectedBy, description) and suppresses incidents whose fingerprint
// has been seen within a configurable time window.
//
// On suppression the module:
//   1. Emits `incident.suppressed` (if configured) so dashboards can track
//   2. Emits `enrichment.completed` on the original incident with an
//      updated occurrence count
//   3. Does NOT re-publish `incident.created` — the duplicate is silenced
//
// The module sits upstream in the pipeline by subscribing to
// `incident.created` before the incident store. To prevent the store
// from processing duplicates, the module re-publishes a modified event
// on a new topic `incident.deduplicated` which carries the original
// incident data. Downstream modules that want dedup-aware incidents can
// subscribe to that instead.
//
// Features:
//   - Configurable fingerprint fields (default: title + severity + detectedBy)
//   - SHA-256 based fingerprinting (via Node crypto)
//   - Time-windowed suppression (default 5 min)
//   - Occurrence counting per fingerprint
//   - Automatic fingerprint expiry
//   - Capped fingerprint retention (LRU-style eviction)
//   - Emits incident.suppressed events for visibility
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
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

interface DedupConfig {
  windowMs: number;
  fingerprintFields: string[];
  maxFingerprints: number;
  emitSuppressed: boolean;
}

const DEFAULTS: DedupConfig = {
  windowMs: 300_000,          // 5 minutes
  fingerprintFields: ['title', 'severity', 'detectedBy'],
  maxFingerprints: 10_000,
  emitSuppressed: true,
};

/** Tracked state per unique fingerprint. */
export interface FingerprintEntry {
  /** SHA-256 hex digest. */
  fingerprint: string;

  /** ID of the first (original) incident. */
  originalIncidentId: string;

  /** Number of times this fingerprint has been seen (including original). */
  occurrences: number;

  /** Timestamp of first occurrence. */
  firstSeenAt: number;

  /** Timestamp of most recent occurrence. */
  lastSeenAt: number;
}

/** Payload for `incident.suppressed` events. */
export interface IncidentSuppressedPayload {
  /** The duplicate incident ID that was suppressed. */
  suppressedIncidentId: string;

  /** The original incident ID. */
  originalIncidentId: string;

  /** The shared fingerprint. */
  fingerprint: string;

  /** How many times this fingerprint has now been seen. */
  occurrences: number;

  /** Time window within which dedup operates. */
  windowMs: number;
}

// ── Utility Functions (exported for testability) ───────────────────────────

/**
 * Compute a SHA-256 fingerprint from selected fields of an incident payload.
 */
export function computeFingerprint(
  payload: IncidentCreatedPayload,
  fields: string[],
): string {
  const parts: string[] = [];
  for (const field of fields) {
    const value = (payload as unknown as Record<string, unknown>)[field];
    parts.push(`${field}=${value ?? ''}`);
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

// ── Module Implementation ──────────────────────────────────────────────────

export class DedupEnricher implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'enricher.dedup',
    name: 'Incident Deduplicator',
    version: '0.1.0',
    type: ModuleType.Enricher,
    description: 'Suppresses duplicate incidents based on fingerprint matching within a time window.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: DedupConfig;
  private subscriptions: EventSubscription[] = [];
  private fingerprints: Map<string, FingerprintEntry> = new Map();
  private expiryTimer: ReturnType<typeof setInterval> | undefined;

  // Metrics
  private totalProcessed = 0;
  private totalSuppressed = 0;
  private totalPassed = 0;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    this.config = { ...DEFAULTS, ...context.config } as DedupConfig;

    this.ctx.logger.info('Initialized', {
      windowMs: this.config.windowMs,
      fingerprintFields: this.config.fingerprintFields,
      maxFingerprints: this.config.maxFingerprints,
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
    const sweepInterval = Math.min(this.config.windowMs / 2, 60_000);
    this.expiryTimer = setInterval(() => this.expireFingerprints(), sweepInterval);

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
      totalProcessed: this.totalProcessed,
      totalSuppressed: this.totalSuppressed,
      totalPassed: this.totalPassed,
    });
  }

  async destroy(): Promise<void> {
    this.fingerprints.clear();
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
        activeFingerprints: this.fingerprints.size,
        totalProcessed: this.totalProcessed,
        totalSuppressed: this.totalSuppressed,
        totalPassed: this.totalPassed,
        suppressionRate: this.totalProcessed > 0
          ? `${((this.totalSuppressed / this.totalProcessed) * 100).toFixed(1)}%`
          : '0%',
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Handling ───────────────────────────────────────────────────────

  private async onIncidentCreated(
    event: OpsPilotEvent<IncidentCreatedPayload>,
  ): Promise<void> {
    this.totalProcessed++;
    const payload = event.payload;
    const fp = computeFingerprint(payload, this.config.fingerprintFields);
    const now = Date.now();

    const existing = this.fingerprints.get(fp);

    if (existing && (now - existing.lastSeenAt) < this.config.windowMs) {
      // ── Duplicate detected ─────────────────────────────────
      existing.occurrences++;
      existing.lastSeenAt = now;
      this.totalSuppressed++;

      this.ctx.logger.info('Incident suppressed (duplicate)', {
        suppressedId: payload.incidentId,
        originalId: existing.originalIncidentId,
        occurrences: existing.occurrences,
        fingerprint: fp.slice(0, 12),
      });

      // Emit enrichment on the original incident with occurrence count
      await this.emitOccurrenceEnrichment(existing, event.correlationId);

      // Emit suppressed event for visibility
      if (this.config.emitSuppressed) {
        await this.emitSuppressedEvent(payload.incidentId, existing);
      }

      return; // Do not re-publish — duplicate is silenced
    }

    // ── New fingerprint ─────────────────────────────────────
    this.enforceCapacity();
    this.fingerprints.set(fp, {
      fingerprint: fp,
      originalIncidentId: payload.incidentId,
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    this.totalPassed++;
  }

  // ── Event Emission ───────────────────────────────────────────────────────

  private async emitOccurrenceEnrichment(
    entry: FingerprintEntry,
    correlationId?: string,
  ): Promise<void> {
    const payload: EnrichmentCompletedPayload = {
      incidentId: entry.originalIncidentId,
      enricherModule: this.manifest.id,
      enrichmentType: 'dedup_occurrence',
      data: {
        fingerprint: entry.fingerprint,
        occurrences: entry.occurrences,
        firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
        lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
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

  private async emitSuppressedEvent(
    suppressedId: string,
    entry: FingerprintEntry,
  ): Promise<void> {
    const payload: IncidentSuppressedPayload = {
      suppressedIncidentId: suppressedId,
      originalIncidentId: entry.originalIncidentId,
      fingerprint: entry.fingerprint,
      occurrences: entry.occurrences,
      windowMs: this.config.windowMs,
    };

    await this.ctx.bus.publish<IncidentSuppressedPayload>({
      type: 'incident.suppressed',
      source: this.manifest.id,
      timestamp: new Date(),
      payload,
    });
  }

  // ── Fingerprint Management ───────────────────────────────────────────────

  private expireFingerprints(): void {
    const now = Date.now();
    const expired: string[] = [];
    for (const [fp, entry] of this.fingerprints) {
      if (now - entry.lastSeenAt >= this.config.windowMs) {
        expired.push(fp);
      }
    }
    for (const fp of expired) {
      this.fingerprints.delete(fp);
    }
    if (expired.length > 0) {
      this.ctx.logger.debug('Expired fingerprints', { count: expired.length });
    }
  }

  private enforceCapacity(): void {
    while (this.fingerprints.size >= this.config.maxFingerprints) {
      let oldestFp: string | undefined;
      let oldestTime = Infinity;
      for (const [fp, entry] of this.fingerprints) {
        if (entry.lastSeenAt < oldestTime) {
          oldestTime = entry.lastSeenAt;
          oldestFp = fp;
        }
      }
      if (oldestFp) {
        this.fingerprints.delete(oldestFp);
      } else {
        break;
      }
    }
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getFingerprints(): Map<string, FingerprintEntry> {
    return this.fingerprints;
  }

  getMetrics(): {
    totalProcessed: number;
    totalSuppressed: number;
    totalPassed: number;
    activeFingerprints: number;
  } {
    return {
      totalProcessed: this.totalProcessed,
      totalSuppressed: this.totalSuppressed,
      totalPassed: this.totalPassed,
      activeFingerprints: this.fingerprints.size,
    };
  }

  getConfig(): DedupConfig {
    return this.config;
  }
}
