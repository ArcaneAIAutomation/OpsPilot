// ---------------------------------------------------------------------------
// OpsPilot — Approval Gate
// ---------------------------------------------------------------------------
// Implements the NON-NEGOTIABLE safety model:
//   Proposal → Approval → Token → Execution → Audit
//
// No action executes without a valid, non-expired approval token.
// All decisions (approve / deny) are audit-logged.
// ---------------------------------------------------------------------------

import {
  IApprovalGate,
  ApprovalRequest,
  ApprovalToken,
  ApprovalStatus,
  IAuditLogger,
} from '../types/security';
import { IStorageEngine } from '../types/storage';
import { IEventBus, OpsPilotEvent } from '../types/events';
import { ILogger } from '../types/module';
import { SecurityError } from '../../shared/errors';
import { generateId } from '../../shared/utils';

const REQUESTS_COLLECTION = 'system::approval_requests';
const TOKENS_COLLECTION = 'system::approval_tokens';

/** Default token lifetime: 15 minutes. */
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;

interface StoredRequest extends ApprovalRequest {
  status: ApprovalStatus;
  deniedReason?: string;
}

export class ApprovalGate implements IApprovalGate {
  private readonly storage: IStorageEngine;
  private readonly bus: IEventBus;
  private readonly audit: IAuditLogger;
  private readonly logger: ILogger;

  constructor(
    storage: IStorageEngine,
    bus: IEventBus,
    audit: IAuditLogger,
    logger: ILogger,
  ) {
    this.storage = storage;
    this.bus = bus;
    this.audit = audit;
    this.logger = logger.child('ApprovalGate');
  }

  // ── Request ──────────────────────────────────────────────────────────────

  async requestApproval(
    request: Omit<ApprovalRequest, 'id' | 'requestedAt'>,
  ): Promise<ApprovalRequest> {
    const full: StoredRequest = {
      ...request,
      id: generateId(),
      requestedAt: new Date(),
      status: ApprovalStatus.Pending,
    };

    await this.storage.set(REQUESTS_COLLECTION, full.id, full);

    await this.audit.log({
      action: 'action.requested',
      actor: request.requestedBy,
      target: request.actionType,
      details: {
        requestId: full.id,
        description: request.description,
        reasoning: request.reasoning,
      },
    });

    // Notify subscribers
    const event: OpsPilotEvent<ApprovalRequest> = {
      type: 'action.proposed',
      source: 'core.approvalGate',
      timestamp: new Date(),
      payload: full,
    };
    await this.bus.publish(event);

    this.logger.info('Approval requested', {
      requestId: full.id,
      actionType: request.actionType,
      requestedBy: request.requestedBy,
    });

    return full;
  }

  // ── Approve ──────────────────────────────────────────────────────────────

  async approve(requestId: string, approvedBy: string): Promise<ApprovalToken> {
    const stored = await this.storage.get<StoredRequest>(REQUESTS_COLLECTION, requestId);
    if (!stored) {
      throw new SecurityError(`Approval request not found: ${requestId}`);
    }
    if (stored.status !== ApprovalStatus.Pending) {
      throw new SecurityError(
        `Cannot approve request ${requestId}: current status is "${stored.status}"`,
      );
    }

    // Update request status
    stored.status = ApprovalStatus.Approved;
    await this.storage.set(REQUESTS_COLLECTION, requestId, stored);

    // Create token
    const token: ApprovalToken = {
      id: generateId(),
      requestId,
      approvedBy,
      approvedAt: new Date(),
      expiresAt: new Date(Date.now() + DEFAULT_TOKEN_TTL_MS),
    };
    await this.storage.set(TOKENS_COLLECTION, token.id, token);

    await this.audit.log({
      action: 'action.approved',
      actor: approvedBy,
      target: stored.actionType,
      details: {
        requestId,
        tokenId: token.id,
        expiresAt: token.expiresAt?.toISOString(),
      },
    });

    // Notify subscribers
    const event: OpsPilotEvent<{ request: ApprovalRequest; token: ApprovalToken }> = {
      type: 'action.approved',
      source: 'core.approvalGate',
      timestamp: new Date(),
      payload: { request: stored, token },
    };
    await this.bus.publish(event);

    this.logger.info('Action approved', {
      requestId,
      tokenId: token.id,
      approvedBy,
    });

    return token;
  }

  // ── Deny ─────────────────────────────────────────────────────────────────

  async deny(requestId: string, deniedBy: string, reason?: string): Promise<void> {
    const stored = await this.storage.get<StoredRequest>(REQUESTS_COLLECTION, requestId);
    if (!stored) {
      throw new SecurityError(`Approval request not found: ${requestId}`);
    }
    if (stored.status !== ApprovalStatus.Pending) {
      throw new SecurityError(
        `Cannot deny request ${requestId}: current status is "${stored.status}"`,
      );
    }

    stored.status = ApprovalStatus.Denied;
    stored.deniedReason = reason;
    await this.storage.set(REQUESTS_COLLECTION, requestId, stored);

    await this.audit.log({
      action: 'action.denied',
      actor: deniedBy,
      target: stored.actionType,
      details: {
        requestId,
        reason,
      },
    });

    this.logger.info('Action denied', { requestId, deniedBy, reason });
  }

  // ── Status ───────────────────────────────────────────────────────────────

  async getStatus(requestId: string): Promise<ApprovalStatus> {
    const stored = await this.storage.get<StoredRequest>(REQUESTS_COLLECTION, requestId);
    if (!stored) {
      throw new SecurityError(`Approval request not found: ${requestId}`);
    }

    // Check for expiration on pending requests (time-based auto-expire)
    if (stored.status === ApprovalStatus.Approved) {
      // Find associated token and check expiry
      const tokens = await this.storage.list<ApprovalToken>(TOKENS_COLLECTION);
      const token = tokens.find((t) => t.requestId === requestId);
      if (token?.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
        stored.status = ApprovalStatus.Expired;
        await this.storage.set(REQUESTS_COLLECTION, requestId, stored);
      }
    }

    return stored.status;
  }

  // ── Token Validation ─────────────────────────────────────────────────────

  async validateToken(token: ApprovalToken): Promise<boolean> {
    // Verify the token exists in storage (not forged)
    const stored = await this.storage.get<ApprovalToken>(TOKENS_COLLECTION, token.id);
    if (!stored) {
      this.logger.warn('Token validation failed: token not found', { tokenId: token.id });
      return false;
    }

    // Verify the request ID matches
    if (stored.requestId !== token.requestId) {
      this.logger.warn('Token validation failed: request ID mismatch', {
        tokenId: token.id,
        expected: stored.requestId,
        received: token.requestId,
      });
      return false;
    }

    // Check expiration
    if (stored.expiresAt && new Date(stored.expiresAt).getTime() < Date.now()) {
      this.logger.warn('Token validation failed: expired', {
        tokenId: token.id,
        expiresAt: stored.expiresAt,
      });
      return false;
    }

    // Verify the underlying request is still approved
    const request = await this.storage.get<StoredRequest>(REQUESTS_COLLECTION, stored.requestId);
    if (!request || request.status !== ApprovalStatus.Approved) {
      this.logger.warn('Token validation failed: request not in approved state', {
        tokenId: token.id,
        requestStatus: request?.status,
      });
      return false;
    }

    return true;
  }
}
