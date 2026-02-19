// ---------------------------------------------------------------------------
// OpsPilot — action.safe
// ---------------------------------------------------------------------------
// The Safe Action module implements the end-to-end approval workflow:
//
//   1. Subscribes to `incident.created` events
//   2. Matches incidents against configurable remediation rules
//   3. PROPOSES actions via the ApprovalGate (never auto-executes)
//   4. Listens for `action.approved` events
//   5. Validates the approval token
//   6. Executes the action ONLY with a valid, non-expired token
//   7. Emits `action.executed` event
//   8. Full audit trail at every step
//
// Safety model (NON-NEGOTIABLE):
//   AI suggestions → Proposal → Human Approval → Token → Execution → Audit
//   Nothing executes without an approval token.
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
  ActionExecutedPayload,
  IncidentSeverity,
} from '../../shared/events';
import { ApprovalRequest, ApprovalToken } from '../../core/types/security';
import { generateId } from '../../shared/utils';
import configSchema from './schema.json';

// ── Config Types ───────────────────────────────────────────────────────────

interface ActionRule {
  id: string;
  actionType: string;
  description: string;
  triggerSeverity: IncidentSeverity[];
  triggerPattern?: string;
  command?: string;
  enabled: boolean;
}

interface SafeActionConfig {
  autoPropose: boolean;
  proposalDelaySec: number;
  actions: ActionRule[];
}

// ── Compiled Rule ──────────────────────────────────────────────────────────

interface CompiledActionRule extends ActionRule {
  regex?: RegExp;
}

// ── Pending Proposal Tracking ──────────────────────────────────────────────

interface PendingExecution {
  requestId: string;
  rule: CompiledActionRule;
  incidentId: string;
}

// ── Module Implementation ──────────────────────────────────────────────────

export class SafeActionModule implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'action.safe',
    name: 'Safe Action Executor',
    version: '0.1.0',
    type: ModuleType.Action,
    description: 'Proposes and executes remediation actions through the approval gate.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: SafeActionConfig;
  private compiledRules: CompiledActionRule[] = [];
  private subscriptions: EventSubscription[] = [];

  // Track proposed actions awaiting approval
  private pendingExecutions = new Map<string, PendingExecution>();

  // Timers for delayed proposals
  private proposalTimers: NodeJS.Timeout[] = [];

  // Metrics
  private actionsProposed = 0;
  private actionsExecuted = 0;
  private actionsFailed = 0;
  private healthy = true;
  private lastError: string | undefined;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    const DEFAULTS: SafeActionConfig = {
      autoPropose: true,
      proposalDelaySec: 5,
      actions: [],
    };

    this.config = {
      ...DEFAULTS,
      ...context.config,
    } as SafeActionConfig;

    // Compile trigger patterns
    this.compiledRules = [];
    for (const rule of this.config.actions) {
      const merged: ActionRule = {
        ...rule,
        enabled: rule.enabled ?? true,
      };

      if (!merged.enabled) {
        this.ctx.logger.debug('Action rule disabled', { ruleId: merged.id });
        continue;
      }

      let regex: RegExp | undefined;
      if (merged.triggerPattern) {
        try {
          regex = new RegExp(merged.triggerPattern, 'i');
        } catch (err) {
          throw new Error(
            `Action rule "${merged.id}" has invalid trigger pattern: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.compiledRules.push({ ...merged, regex });
    }

    this.ctx.logger.info('Initialized', {
      activeRules: this.compiledRules.length,
      autoPropose: this.config.autoPropose,
      proposalDelaySec: this.config.proposalDelaySec,
    });
  }

  async start(): Promise<void> {
    // Listen for new incidents (to propose actions)
    this.subscriptions.push(
      this.ctx.bus.subscribe<IncidentCreatedPayload>(
        'incident.created',
        (event) => this.onIncidentCreated(event),
      ),
    );

    // Listen for approved actions (to execute)
    this.subscriptions.push(
      this.ctx.bus.subscribe<{ request: ApprovalRequest; token: ApprovalToken }>(
        'action.approved',
        (event) => this.onActionApproved(event),
      ),
    );

    this.ctx.logger.info('Started — listening for incident.created and action.approved');
  }

  async stop(): Promise<void> {
    // Clear pending timers
    for (const timer of this.proposalTimers) {
      clearTimeout(timer);
    }
    this.proposalTimers = [];

    // Unsubscribe
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    this.ctx.logger.info('Stopped', {
      actionsProposed: this.actionsProposed,
      actionsExecuted: this.actionsExecuted,
      actionsFailed: this.actionsFailed,
    });
  }

  async destroy(): Promise<void> {
    this.pendingExecutions.clear();
    this.compiledRules = [];
    this.proposalTimers = [];
    this.subscriptions = [];
    this.ctx = undefined!;
    this.config = undefined!;
  }

  health(): ModuleHealth {
    return {
      status: this.healthy ? 'healthy' : 'degraded',
      message: this.lastError,
      details: {
        activeRules: this.compiledRules.length,
        actionsProposed: this.actionsProposed,
        actionsExecuted: this.actionsExecuted,
        actionsFailed: this.actionsFailed,
        pendingApprovals: this.pendingExecutions.size,
      },
      lastCheck: new Date(),
    };
  }

  // ── Event: New Incident ──────────────────────────────────────────────────

  private async onIncidentCreated(
    event: OpsPilotEvent<IncidentCreatedPayload>,
  ): Promise<void> {
    if (!this.config.autoPropose) return;

    const incident = event.payload;

    // Find matching action rules
    for (const rule of this.compiledRules) {
      if (!this.matchesRule(rule, incident)) continue;

      // Delay proposal to allow enrichment to arrive
      if (this.config.proposalDelaySec > 0) {
        const timer = setTimeout(
          () => this.proposeAction(rule, incident, event.correlationId),
          this.config.proposalDelaySec * 1000,
        );
        this.proposalTimers.push(timer);
      } else {
        await this.proposeAction(rule, incident, event.correlationId);
      }
    }
  }

  private matchesRule(
    rule: CompiledActionRule,
    incident: IncidentCreatedPayload,
  ): boolean {
    // Check severity
    if (!rule.triggerSeverity.includes(incident.severity)) {
      return false;
    }

    // Check pattern against title
    if (rule.regex && !rule.regex.test(incident.title)) {
      return false;
    }

    return true;
  }

  private async proposeAction(
    rule: CompiledActionRule,
    incident: IncidentCreatedPayload,
    correlationId?: string,
  ): Promise<void> {
    try {
      const reasoning = `Incident "${incident.title}" (severity: ${incident.severity}) ` +
        `was detected by ${incident.detectedBy}. ` +
        `Rule "${rule.id}" recommends action: ${rule.description}`;

      const request = await this.ctx.approvalGate.requestApproval({
        actionType: rule.actionType,
        description: rule.description,
        reasoning,
        requestedBy: this.manifest.id,
        metadata: {
          incidentId: incident.incidentId,
          ruleId: rule.id,
          severity: incident.severity,
          command: rule.command,
          correlationId,
        },
      });

      // Track for execution when approved
      this.pendingExecutions.set(request.id, {
        requestId: request.id,
        rule,
        incidentId: incident.incidentId,
      });

      this.actionsProposed++;

      this.ctx.logger.info('Action proposed', {
        requestId: request.id,
        actionType: rule.actionType,
        incidentId: incident.incidentId,
        ruleId: rule.id,
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.ctx.logger.error(
        'Failed to propose action',
        err instanceof Error ? err : new Error(String(err)),
        { ruleId: rule.id, incidentId: incident.incidentId },
      );
    }
  }

  // ── Event: Action Approved ───────────────────────────────────────────────

  private async onActionApproved(
    event: OpsPilotEvent<{ request: ApprovalRequest; token: ApprovalToken }>,
  ): Promise<void> {
    const { request, token } = event.payload;

    // Only handle actions we proposed
    const pending = this.pendingExecutions.get(request.id);
    if (!pending) {
      return; // Not our action
    }

    this.ctx.logger.info('Action approved, validating token...', {
      requestId: request.id,
      tokenId: token.id,
    });

    // Validate the token (NON-NEGOTIABLE safety check)
    const isValid = await this.ctx.approvalGate.validateToken(token);
    if (!isValid) {
      this.ctx.logger.warn('Token validation failed, refusing to execute', {
        requestId: request.id,
        tokenId: token.id,
      });
      this.actionsFailed++;
      return;
    }

    // Execute the action
    await this.executeAction(pending, token);

    // Clean up
    this.pendingExecutions.delete(request.id);
  }

  // ── Action Execution ─────────────────────────────────────────────────────

  private async executeAction(
    pending: PendingExecution,
    token: ApprovalToken,
  ): Promise<void> {
    const startTime = Date.now();
    let result: 'success' | 'failure' = 'success';
    let output = '';

    try {
      this.ctx.logger.info('Executing action...', {
        requestId: pending.requestId,
        actionType: pending.rule.actionType,
        incidentId: pending.incidentId,
      });

      // Simulate action execution.
      // In production, this would execute the configured command or handler.
      // For safety, we log and audit rather than running arbitrary commands
      // in this MVP. Real integrations would use sandboxed executors.
      if (pending.rule.command) {
        output = `[SIMULATED] Would execute: ${pending.rule.command}`;
        this.ctx.logger.info('Action simulated (sandbox mode)', {
          command: pending.rule.command,
          incidentId: pending.incidentId,
        });
      } else {
        output = `Action "${pending.rule.actionType}" acknowledged for incident ${pending.incidentId}`;
      }

      this.actionsExecuted++;
    } catch (err) {
      result = 'failure';
      output = err instanceof Error ? err.message : String(err);
      this.actionsFailed++;
      this.lastError = output;

      this.ctx.logger.error(
        'Action execution failed',
        err instanceof Error ? err : new Error(output),
        { requestId: pending.requestId },
      );
    }

    // Emit action.executed event
    const executedPayload: ActionExecutedPayload = {
      requestId: pending.requestId,
      tokenId: token.id,
      actionType: pending.rule.actionType,
      result,
      output,
      executedBy: this.manifest.id,
      executedAt: new Date(),
    };

    await this.ctx.bus.publish<ActionExecutedPayload>({
      type: 'action.executed',
      source: this.manifest.id,
      timestamp: new Date(),
      payload: executedPayload,
    });

    this.ctx.logger.info('Action execution completed', {
      requestId: pending.requestId,
      result,
      durationMs: Date.now() - startTime,
    });
  }
}
