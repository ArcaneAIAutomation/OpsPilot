// ---------------------------------------------------------------------------
// OpsPilot — Security & Approval Types
// ---------------------------------------------------------------------------
// The safety model is NON-NEGOTIABLE:
//   AI suggestions → Proposal → Approval → Execution → Audit
// Nothing executes without an approval token.
// ---------------------------------------------------------------------------

// ── Approval Request ───────────────────────────────────────────────────────

export interface ApprovalRequest {
  /** Unique request identifier. */
  readonly id: string;

  /** Category of the proposed action (e.g. `restart.service`). */
  readonly actionType: string;

  /** Human-readable description of what will happen. */
  readonly description: string;

  /** AI-generated reasoning for why this action is recommended. */
  readonly reasoning: string;

  /** Module ID that requested the action. */
  readonly requestedBy: string;

  /** When the request was created. */
  readonly requestedAt: Date;

  /** Arbitrary metadata for UI display or auditing. */
  readonly metadata?: Record<string, unknown>;
}

// ── Approval Token ─────────────────────────────────────────────────────────

/** Proof that a specific request was approved. Required for execution. */
export interface ApprovalToken {
  readonly id: string;
  readonly requestId: string;
  readonly approvedBy: string;
  readonly approvedAt: Date;
  readonly expiresAt?: Date;
}

// ── Approval Status ────────────────────────────────────────────────────────

export enum ApprovalStatus {
  Pending = 'pending',
  Approved = 'approved',
  Denied = 'denied',
  Expired = 'expired',
}

// ── Approval Gate Interface ────────────────────────────────────────────────

export interface IApprovalGate {
  /** Create a new approval request. Returns the persisted request. */
  requestApproval(
    request: Omit<ApprovalRequest, 'id' | 'requestedAt'>,
  ): Promise<ApprovalRequest>;

  /** Approve a pending request. Returns a time-limited token. */
  approve(requestId: string, approvedBy: string): Promise<ApprovalToken>;

  /** Deny a pending request. */
  deny(requestId: string, deniedBy: string, reason?: string): Promise<void>;

  /** Check the current status of a request. */
  getStatus(requestId: string): Promise<ApprovalStatus>;

  /** Validate that a token is genuine, not expired, and not revoked. */
  validateToken(token: ApprovalToken): Promise<boolean>;
}

// ── Audit Trail ────────────────────────────────────────────────────────────

export interface AuditEntry {
  readonly id: string;
  readonly timestamp: Date;

  /** Machine-readable action identifier, e.g. `action.approved`. */
  readonly action: string;

  /** Who performed the action (user ID, module ID, or `system`). */
  readonly actor: string;

  /** What the action targeted (incident ID, service name, etc.). */
  readonly target?: string;

  /** Arbitrary structured details. */
  readonly details?: Record<string, unknown>;

  /** Correlation ID for cross-event tracing. */
  readonly correlationId?: string;
}

export interface AuditFilter {
  action?: string;
  actor?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface IAuditLogger {
  /** Append an immutable audit entry. */
  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void>;

  /** Query the audit trail. */
  query(filter: AuditFilter): Promise<AuditEntry[]>;
}
