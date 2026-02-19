// ---------------------------------------------------------------------------
// OpsPilot — Shared Event Payload Types
// ---------------------------------------------------------------------------
// Canonical payload shapes for well-known events. Modules import these
// types to produce and consume events with compile-time safety.
// Placing them in `shared/` keeps modules decoupled from each other
// while giving everyone a common vocabulary.
// ---------------------------------------------------------------------------

// ── Log Events ─────────────────────────────────────────────────────────────

/** Payload for `log.ingested` events emitted by connector modules. */
export interface LogIngestedPayload {
  /** Origin identifier (file path, service name, stream ID). */
  source: string;

  /** Raw log line exactly as read from the source. */
  line: string;

  /** 1-based line number within the source (if applicable). */
  lineNumber?: number;

  /** Timestamp when the line was read by the connector. */
  ingestedAt: Date;

  /** Optional encoding metadata. */
  encoding?: string;

  /** Arbitrary connector-specific metadata. */
  metadata?: Record<string, unknown>;
}

// ── Incident Events ────────────────────────────────────────────────────────

/** Severity levels for incidents. */
export type IncidentSeverity = 'info' | 'warning' | 'critical';

/** Payload for `incident.created` events emitted by detector modules. */
export interface IncidentCreatedPayload {
  /** Unique incident ID. */
  incidentId: string;

  /** Human-readable title. */
  title: string;

  /** Detailed description of what was detected. */
  description: string;

  /** Severity assessment. */
  severity: IncidentSeverity;

  /** The detector module that created this incident. */
  detectedBy: string;

  /** Reference to the source data that triggered detection. */
  sourceEvent?: string;

  /** When the incident was detected. */
  detectedAt: Date;

  /** Arbitrary structured context. */
  context?: Record<string, unknown>;
}

/** Payload for `incident.updated` events. */
export interface IncidentUpdatedPayload {
  incidentId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  updatedBy: string;
  updatedAt: Date;
}

// ── Action Events ──────────────────────────────────────────────────────────

/** Payload for `action.proposed` events. */
export interface ActionProposedPayload {
  requestId: string;
  actionType: string;
  description: string;
  reasoning: string;
  requestedBy: string;
  incidentId?: string;
}

/** Payload for `action.approved` events. */
export interface ActionApprovedPayload {
  requestId: string;
  tokenId: string;
  approvedBy: string;
}

/** Payload for `action.executed` events. */
export interface ActionExecutedPayload {
  requestId: string;
  tokenId: string;
  actionType: string;
  result: 'success' | 'failure';
  output?: string;
  executedBy: string;
  executedAt: Date;
}

// ── Enrichment Events ──────────────────────────────────────────────────────

/** Payload for `enrichment.completed` events. */
export interface EnrichmentCompletedPayload {
  incidentId: string;
  enricherModule: string;
  enrichmentType: string;
  data: Record<string, unknown>;
  completedAt: Date;
}
