// ---------------------------------------------------------------------------
// OpsPilot — enricher.incidentStore
// ---------------------------------------------------------------------------
// Central incident storage enricher. Subscribes to `incident.created` and
// persists every incident into namespaced storage. Provides query methods
// that other modules (OpenClaw tools, UI extensions) can use.
//
// This module is the "source of truth" for incidents. It also listens for
// `enrichment.completed` events to attach enrichment data to existing
// incidents, and emits `incident.updated` events when incidents change.
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
  IncidentSeverity,
} from '../../shared/events';
import configSchema from './schema.json';

// ── Config ─────────────────────────────────────────────────────────────────

interface IncidentStoreConfig {
  maxIncidents: number;
  retentionMs: number;
}

// ── Stored Incident Shape ──────────────────────────────────────────────────

export interface StoredIncident {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  detectedBy: string;
  sourceEvent?: string;
  detectedAt: string;       // ISO string for serialisation
  createdAt: string;         // when it was stored
  status: 'open' | 'acknowledged' | 'resolved' | 'closed';
  context?: Record<string, unknown>;
  enrichments: Record<string, unknown>;   // enricherModule → data
  timeline: TimelineEntry[];
}

export interface TimelineEntry {
  timestamp: string;
  action: string;
  actor: string;
  details?: Record<string, unknown>;
}

// ── Collection Names ───────────────────────────────────────────────────────

const INCIDENTS_COLLECTION = 'incidents';

// ── Module Implementation ──────────────────────────────────────────────────

export class IncidentStore implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'enricher.incidentStore',
    name: 'Incident Store',
    version: '0.1.0',
    type: ModuleType.Enricher,
    description: 'Central incident persistence and query engine.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: IncidentStoreConfig;
  private subscriptions: EventSubscription[] = [];

  // Metrics
  private incidentsStored = 0;
  private enrichmentsApplied = 0;
  private healthy = true;
  private lastError: string | undefined;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    const DEFAULTS: IncidentStoreConfig = {
      maxIncidents: 10000,
      retentionMs: 86400000, // 24 hours
    };

    this.config = {
      ...DEFAULTS,
      ...context.config,
    } as IncidentStoreConfig;

    this.ctx.logger.info('Initialized', {
      maxIncidents: this.config.maxIncidents,
      retentionMs: this.config.retentionMs,
    });
  }

  async start(): Promise<void> {
    // Listen for new incidents
    this.subscriptions.push(
      this.ctx.bus.subscribe<IncidentCreatedPayload>(
        'incident.created',
        (event) => this.onIncidentCreated(event),
      ),
    );

    // Listen for enrichments to attach to existing incidents
    this.subscriptions.push(
      this.ctx.bus.subscribe<EnrichmentCompletedPayload>(
        'enrichment.completed',
        (event) => this.onEnrichmentCompleted(event),
      ),
    );

    this.ctx.logger.info('Started — listening for incident.created and enrichment.completed');
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    this.ctx.logger.info('Stopped', {
      incidentsStored: this.incidentsStored,
      enrichmentsApplied: this.enrichmentsApplied,
    });
  }

  async destroy(): Promise<void> {
    this.subscriptions = [];
    this.ctx = undefined!;
    this.config = undefined!;
  }

  health(): ModuleHealth {
    return {
      status: this.healthy ? 'healthy' : 'degraded',
      message: this.lastError,
      details: {
        incidentsStored: this.incidentsStored,
        enrichmentsApplied: this.enrichmentsApplied,
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Handlers ───────────────────────────────────────────────────────

  private async onIncidentCreated(
    event: OpsPilotEvent<IncidentCreatedPayload>,
  ): Promise<void> {
    const p = event.payload;
    const now = new Date().toISOString();

    const stored: StoredIncident = {
      id: p.incidentId,
      title: p.title,
      description: p.description,
      severity: p.severity,
      detectedBy: p.detectedBy,
      sourceEvent: p.sourceEvent,
      detectedAt: p.detectedAt instanceof Date
        ? p.detectedAt.toISOString()
        : String(p.detectedAt),
      createdAt: now,
      status: 'open',
      context: p.context,
      enrichments: {},
      timeline: [
        {
          timestamp: now,
          action: 'created',
          actor: p.detectedBy,
          details: { severity: p.severity },
        },
      ],
    };

    await this.ctx.storage.set(INCIDENTS_COLLECTION, stored.id, stored);
    this.incidentsStored++;

    this.ctx.logger.info('Incident stored', {
      incidentId: stored.id,
      severity: stored.severity,
      title: stored.title,
    });

    // Enforce retention / capacity limits
    await this.enforceRetention();
  }

  private async onEnrichmentCompleted(
    event: OpsPilotEvent<EnrichmentCompletedPayload>,
  ): Promise<void> {
    const p = event.payload;

    const incident = await this.ctx.storage.get<StoredIncident>(
      INCIDENTS_COLLECTION,
      p.incidentId,
    );

    if (!incident) {
      this.ctx.logger.warn('Enrichment for unknown incident', {
        incidentId: p.incidentId,
        enricher: p.enricherModule,
      });
      return;
    }

    // Attach enrichment data
    incident.enrichments[p.enricherModule] = p.data;
    incident.timeline.push({
      timestamp: new Date().toISOString(),
      action: 'enrichment.added',
      actor: p.enricherModule,
      details: { enrichmentType: p.enrichmentType },
    });

    await this.ctx.storage.set(INCIDENTS_COLLECTION, incident.id, incident);
    this.enrichmentsApplied++;

    // Emit incident.updated event
    const updatePayload: IncidentUpdatedPayload = {
      incidentId: p.incidentId,
      field: `enrichments.${p.enricherModule}`,
      oldValue: null,
      newValue: p.data,
      updatedBy: p.enricherModule,
      updatedAt: new Date(),
    };

    await this.ctx.bus.publish<IncidentUpdatedPayload>({
      type: 'incident.updated',
      source: this.manifest.id,
      timestamp: new Date(),
      correlationId: event.correlationId,
      payload: updatePayload,
    });

    this.ctx.logger.info('Enrichment attached to incident', {
      incidentId: p.incidentId,
      enricher: p.enricherModule,
      enrichmentType: p.enrichmentType,
    });
  }

  // ── Public Query API ─────────────────────────────────────────────────────
  // These methods are accessible to OpenClaw tools or other modules that
  // hold a reference to this instance.

  /** Get a single incident by ID. */
  async getIncident(incidentId: string): Promise<StoredIncident | undefined> {
    return this.ctx.storage.get<StoredIncident>(INCIDENTS_COLLECTION, incidentId);
  }

  /** List all incidents, optionally filtered. */
  async listIncidents(filter?: {
    severity?: IncidentSeverity;
    status?: StoredIncident['status'];
    limit?: number;
  }): Promise<StoredIncident[]> {
    let all = await this.ctx.storage.list<StoredIncident>(INCIDENTS_COLLECTION);

    if (filter?.severity) {
      all = all.filter((i) => i.severity === filter.severity);
    }
    if (filter?.status) {
      all = all.filter((i) => i.status === filter.status);
    }

    // Sort by createdAt descending (newest first)
    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (filter?.limit && filter.limit > 0) {
      all = all.slice(0, filter.limit);
    }

    return all;
  }

  /** Update an incident's status. */
  async updateStatus(
    incidentId: string,
    newStatus: StoredIncident['status'],
    actor: string,
  ): Promise<StoredIncident> {
    const incident = await this.ctx.storage.get<StoredIncident>(
      INCIDENTS_COLLECTION,
      incidentId,
    );

    if (!incident) {
      throw new Error(`Incident not found: ${incidentId}`);
    }

    const oldStatus = incident.status;
    incident.status = newStatus;
    incident.timeline.push({
      timestamp: new Date().toISOString(),
      action: 'status.changed',
      actor,
      details: { oldStatus, newStatus },
    });

    await this.ctx.storage.set(INCIDENTS_COLLECTION, incident.id, incident);

    // Emit update event
    await this.ctx.bus.publish<IncidentUpdatedPayload>({
      type: 'incident.updated',
      source: this.manifest.id,
      timestamp: new Date(),
      payload: {
        incidentId,
        field: 'status',
        oldValue: oldStatus,
        newValue: newStatus,
        updatedBy: actor,
        updatedAt: new Date(),
      },
    });

    this.ctx.logger.info('Incident status updated', {
      incidentId,
      oldStatus,
      newStatus,
      actor,
    });

    return incident;
  }

  /** Get total counts grouped by severity. */
  async getSummary(): Promise<{
    total: number;
    bySeverity: Record<string, number>;
    byStatus: Record<string, number>;
  }> {
    const all = await this.ctx.storage.list<StoredIncident>(INCIDENTS_COLLECTION);

    const bySeverity: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

    for (const inc of all) {
      bySeverity[inc.severity] = (bySeverity[inc.severity] ?? 0) + 1;
      byStatus[inc.status] = (byStatus[inc.status] ?? 0) + 1;
    }

    return { total: all.length, bySeverity, byStatus };
  }

  // ── Retention ────────────────────────────────────────────────────────────

  private async enforceRetention(): Promise<void> {
    const all = await this.ctx.storage.list<StoredIncident>(INCIDENTS_COLLECTION);

    // Sort oldest first
    const sorted = all.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    let removed = 0;

    // Remove expired incidents (if retentionMs > 0)
    if (this.config.retentionMs > 0) {
      const cutoff = Date.now() - this.config.retentionMs;
      for (const inc of sorted) {
        if (new Date(inc.createdAt).getTime() < cutoff) {
          await this.ctx.storage.delete(INCIDENTS_COLLECTION, inc.id);
          removed++;
        }
      }
    }

    // Remove oldest if over capacity
    const remaining = await this.ctx.storage.list<StoredIncident>(INCIDENTS_COLLECTION);
    if (remaining.length > this.config.maxIncidents) {
      const excess = remaining.length - this.config.maxIncidents;
      const oldest = remaining
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .slice(0, excess);

      for (const inc of oldest) {
        await this.ctx.storage.delete(INCIDENTS_COLLECTION, inc.id);
        removed++;
      }
    }

    if (removed > 0) {
      this.ctx.logger.info('Retention enforced', { removedIncidents: removed });
    }
  }
}
