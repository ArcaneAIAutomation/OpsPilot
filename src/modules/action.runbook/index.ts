// ---------------------------------------------------------------------------
// OpsPilot — action.runbook (Runbook Automation Engine)
// ---------------------------------------------------------------------------
// Listens for `enrichment.completed` events of type `ai-summary` that
// contain `suggestedRunbooks`, then orchestrates step-by-step execution
// through the approval gate.
//
// Safety model (NON-NEGOTIABLE):
//   - When requireApprovalPerStep=true (default), each step is proposed
//     for human approval before execution.
//   - When requireApprovalPerStep=false, approving the runbook approves
//     all its steps in sequence.
//   - Each step execution is audited as an `action.executed` event.
//
// Lifecycle:
//   1. Receives enrichment with suggestedRunbooks
//   2. Creates a RunbookExecution tracker
//   3. Proposes the runbook (or auto-starts if configured)
//   4. On approval, executes steps sequentially
//   5. Emits runbook.started / runbook.stepCompleted / runbook.completed
//
// The module does NOT execute real commands. Steps are simulated in
// sandbox mode (same as action.safe). Real integrations would delegate
// to sandboxed executors via the tool registry.
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
  EnrichmentCompletedPayload,
  ActionExecutedPayload,
} from '../../shared/events';
import { ApprovalRequest, ApprovalToken } from '../../core/types/security';
import { generateId } from '../../shared/utils';
import configSchema from './schema.json';

// ── Types ──────────────────────────────────────────────────────────────────

interface RunbookConfig {
  autoExecute: boolean;
  requireApprovalPerStep: boolean;
  stepTimeoutMs: number;
  maxConcurrentRunbooks: number;
  maxRunbookHistory: number;
  cooldownMs: number;
  severityFilter: string[];
}

const DEFAULTS: RunbookConfig = {
  autoExecute: false,
  requireApprovalPerStep: true,
  stepTimeoutMs: 300_000,
  maxConcurrentRunbooks: 10,
  maxRunbookHistory: 500,
  cooldownMs: 60_000,
  severityFilter: ['warning', 'critical'],
};

/** Suggested runbook shape from AI summary enrichment. */
interface SuggestedRunbook {
  id: string;
  title: string;
  steps: string[];
}

export type RunbookStepStatus = 'pending' | 'awaiting_approval' | 'executing' | 'completed' | 'failed' | 'skipped';
export type RunbookStatus = 'proposed' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunbookStep {
  index: number;
  instruction: string;
  status: RunbookStepStatus;
  output?: string;
  startedAt?: number;
  completedAt?: number;
  approvalRequestId?: string;
}

export interface RunbookExecution {
  id: string;
  runbookId: string;
  runbookTitle: string;
  incidentId: string;
  severity: string;
  status: RunbookStatus;
  steps: RunbookStep[];
  currentStepIndex: number;
  startedAt: number;
  completedAt?: number;
  /** Approval request ID for the whole-runbook approval (when requireApprovalPerStep=false). */
  approvalRequestId?: string;
}

/** Payload for `runbook.started` events. */
export interface RunbookStartedPayload {
  executionId: string;
  runbookId: string;
  runbookTitle: string;
  incidentId: string;
  totalSteps: number;
}

/** Payload for `runbook.stepCompleted` events. */
export interface RunbookStepCompletedPayload {
  executionId: string;
  runbookId: string;
  incidentId: string;
  stepIndex: number;
  instruction: string;
  status: RunbookStepStatus;
  output?: string;
}

/** Payload for `runbook.completed` events. */
export interface RunbookCompletedPayload {
  executionId: string;
  runbookId: string;
  runbookTitle: string;
  incidentId: string;
  status: RunbookStatus;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  durationMs: number;
}

// ── Module Implementation ──────────────────────────────────────────────────

export class RunbookEngine implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'action.runbook',
    name: 'Runbook Automation Engine',
    version: '0.1.0',
    type: ModuleType.Action,
    description: 'Orchestrates step-by-step runbook execution with approval gating.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: RunbookConfig;
  private subscriptions: EventSubscription[] = [];

  // Active and completed executions
  private executions: Map<string, RunbookExecution> = new Map();
  private history: RunbookExecution[] = [];

  // Map approval request IDs to execution IDs for lookup
  private approvalToExecution: Map<string, { executionId: string; stepIndex?: number }> = new Map();

  // Cooldown tracking: incidentId → last runbook completion timestamp
  private cooldowns: Map<string, number> = new Map();

  // Metrics
  private totalStarted = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalStepsExecuted = 0;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    this.config = { ...DEFAULTS, ...context.config } as RunbookConfig;

    this.ctx.logger.info('Initialized', {
      autoExecute: this.config.autoExecute,
      requireApprovalPerStep: this.config.requireApprovalPerStep,
      maxConcurrentRunbooks: this.config.maxConcurrentRunbooks,
      severityFilter: this.config.severityFilter,
    });
  }

  async start(): Promise<void> {
    // Listen for AI summary enrichments containing runbooks
    this.subscriptions.push(
      this.ctx.bus.subscribe<EnrichmentCompletedPayload>(
        'enrichment.completed',
        (event) => this.onEnrichmentCompleted(event),
      ),
    );

    // Listen for approvals to continue runbook execution
    this.subscriptions.push(
      this.ctx.bus.subscribe<{ request: ApprovalRequest; token: ApprovalToken }>(
        'action.approved',
        (event) => this.onActionApproved(event),
      ),
    );

    this.ctx.logger.info('Started — listening for enrichment.completed and action.approved');
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions = [];
    this.ctx.logger.info('Stopped', {
      totalStarted: this.totalStarted,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalStepsExecuted: this.totalStepsExecuted,
    });
  }

  async destroy(): Promise<void> {
    this.executions.clear();
    this.approvalToExecution.clear();
    this.cooldowns.clear();
    this.history = [];
    this.subscriptions = [];
  }

  health(): ModuleHealth {
    return {
      status: 'healthy',
      details: {
        activeRunbooks: this.executions.size,
        historySize: this.history.length,
        totalStarted: this.totalStarted,
        totalCompleted: this.totalCompleted,
        totalFailed: this.totalFailed,
        totalStepsExecuted: this.totalStepsExecuted,
      },
      lastCheck: new Date(),
    };
  }

  // ── Event: Enrichment Completed ──────────────────────────────────────────

  private async onEnrichmentCompleted(
    event: OpsPilotEvent<EnrichmentCompletedPayload>,
  ): Promise<void> {
    const payload = event.payload;

    // Only process ai-summary enrichments with runbooks
    if (payload.enrichmentType !== 'ai-summary') return;

    const runbooks = payload.data.suggestedRunbooks as SuggestedRunbook[] | undefined;
    if (!runbooks || runbooks.length === 0) return;

    // Check severity filter
    const severity = (payload.data as Record<string, unknown>).severity as string | undefined;
    // Severity may not be in the enrichment data directly — we'll check what's available
    // and use it if present, otherwise allow through
    if (severity && this.config.severityFilter.length > 0) {
      if (!this.config.severityFilter.includes(severity)) return;
    }

    // Check cooldown
    const lastCooldown = this.cooldowns.get(payload.incidentId);
    if (lastCooldown && Date.now() - lastCooldown < this.config.cooldownMs) {
      this.ctx.logger.debug('Runbook skipped — cooldown active', {
        incidentId: payload.incidentId,
      });
      return;
    }

    // Check capacity
    if (this.executions.size >= this.config.maxConcurrentRunbooks) {
      this.ctx.logger.warn('Max concurrent runbooks reached, skipping', {
        incidentId: payload.incidentId,
        active: this.executions.size,
      });
      return;
    }

    // Use the first suggested runbook (highest relevance)
    const runbook = runbooks[0];
    await this.startRunbook(runbook, payload.incidentId, severity);
  }

  // ── Runbook Lifecycle ────────────────────────────────────────────────────

  private async startRunbook(
    runbook: SuggestedRunbook,
    incidentId: string,
    severity?: string,
  ): Promise<void> {
    const executionId = `RB-${generateId().slice(0, 8)}`;

    const execution: RunbookExecution = {
      id: executionId,
      runbookId: runbook.id,
      runbookTitle: runbook.title,
      incidentId,
      severity: severity ?? 'unknown',
      status: 'proposed',
      steps: runbook.steps.map((instruction, index) => ({
        index,
        instruction,
        status: 'pending' as RunbookStepStatus,
      })),
      currentStepIndex: 0,
      startedAt: Date.now(),
    };

    this.executions.set(executionId, execution);

    this.ctx.logger.info('Runbook proposed', {
      executionId,
      runbookId: runbook.id,
      runbookTitle: runbook.title,
      incidentId,
      totalSteps: runbook.steps.length,
    });

    if (this.config.autoExecute) {
      // Skip approval — jump straight to execution
      execution.status = 'running';
      this.totalStarted++;
      await this.emitRunbookStarted(execution);
      await this.advanceExecution(executionId);
    } else {
      // Propose for approval
      await this.proposeRunbookApproval(execution);
    }
  }

  private async proposeRunbookApproval(execution: RunbookExecution): Promise<void> {
    const stepsList = execution.steps
      .map((s, i) => `  ${i + 1}. ${s.instruction}`)
      .join('\n');

    const request = await this.ctx.approvalGate.requestApproval({
      actionType: 'runbook.execute',
      description: `Execute runbook "${execution.runbookTitle}" (${execution.steps.length} steps)`,
      reasoning: `AI summary suggested this runbook for incident ${execution.incidentId}.\n\nSteps:\n${stepsList}`,
      requestedBy: this.manifest.id,
      metadata: {
        executionId: execution.id,
        runbookId: execution.runbookId,
        incidentId: execution.incidentId,
      },
    });

    execution.status = 'awaiting_approval';
    execution.approvalRequestId = request.id;
    this.approvalToExecution.set(request.id, { executionId: execution.id });
  }

  // ── Event: Action Approved ───────────────────────────────────────────────

  private async onActionApproved(
    event: OpsPilotEvent<{ request: ApprovalRequest; token: ApprovalToken }>,
  ): Promise<void> {
    const { request, token } = event.payload;

    const mapping = this.approvalToExecution.get(request.id);
    if (!mapping) return; // Not our approval

    // Validate the token (NON-NEGOTIABLE)
    const isValid = await this.ctx.approvalGate.validateToken(token);
    if (!isValid) {
      this.ctx.logger.warn('Token validation failed for runbook approval', {
        requestId: request.id,
      });
      return;
    }

    const execution = this.executions.get(mapping.executionId);
    if (!execution) return;

    if (mapping.stepIndex !== undefined) {
      // This is a step-level approval
      const step = execution.steps[mapping.stepIndex];
      if (step && step.status === 'awaiting_approval') {
        await this.executeStep(execution, step);
        await this.advanceExecution(execution.id);
      }
    } else {
      // This is a whole-runbook approval
      execution.status = 'running';
      this.totalStarted++;
      await this.emitRunbookStarted(execution);
      await this.advanceExecution(execution.id);
    }

    // Clean up the mapping
    this.approvalToExecution.delete(request.id);
  }

  // ── Step Execution ───────────────────────────────────────────────────────

  private async advanceExecution(executionId: string): Promise<void> {
    const execution = this.executions.get(executionId);
    if (!execution || execution.status === 'completed' || execution.status === 'failed') return;

    while (execution.currentStepIndex < execution.steps.length) {
      const step = execution.steps[execution.currentStepIndex];

      if (step.status === 'completed' || step.status === 'failed') {
        execution.currentStepIndex++;
        continue;
      }

      if (this.config.requireApprovalPerStep && !this.config.autoExecute) {
        // Need per-step approval
        if (step.status === 'pending') {
          await this.proposeStepApproval(execution, step);
          return; // Wait for approval
        }
        if (step.status === 'awaiting_approval') {
          return; // Already waiting
        }
      }

      // Execute the step
      await this.executeStep(execution, step);

      if ((step.status as string) === 'failed') {
        execution.status = 'failed';
        await this.completeRunbook(execution);
        return;
      }

      execution.currentStepIndex++;
    }

    // All steps done
    execution.status = 'completed';
    await this.completeRunbook(execution);
  }

  private async proposeStepApproval(
    execution: RunbookExecution,
    step: RunbookStep,
  ): Promise<void> {
    const request = await this.ctx.approvalGate.requestApproval({
      actionType: 'runbook.step',
      description: `Step ${step.index + 1}/${execution.steps.length}: ${step.instruction}`,
      reasoning: `Runbook "${execution.runbookTitle}" step ${step.index + 1} for incident ${execution.incidentId}`,
      requestedBy: this.manifest.id,
      metadata: {
        executionId: execution.id,
        runbookId: execution.runbookId,
        incidentId: execution.incidentId,
        stepIndex: step.index,
      },
    });

    step.status = 'awaiting_approval';
    step.approvalRequestId = request.id;
    this.approvalToExecution.set(request.id, {
      executionId: execution.id,
      stepIndex: step.index,
    });
  }

  private async executeStep(
    execution: RunbookExecution,
    step: RunbookStep,
  ): Promise<void> {
    step.status = 'executing';
    step.startedAt = Date.now();

    try {
      // Simulate step execution (sandbox mode, same as action.safe)
      step.output = `[SIMULATED] Would execute: ${step.instruction}`;
      step.status = 'completed';
      step.completedAt = Date.now();
      this.totalStepsExecuted++;

      this.ctx.logger.info('Runbook step completed', {
        executionId: execution.id,
        step: step.index + 1,
        totalSteps: execution.steps.length,
        instruction: step.instruction,
      });

      await this.emitStepCompleted(execution, step);

      // Emit action.executed for audit trail
      await this.ctx.bus.publish<ActionExecutedPayload>({
        type: 'action.executed',
        source: this.manifest.id,
        timestamp: new Date(),
        payload: {
          requestId: step.approvalRequestId ?? execution.id,
          tokenId: 'runbook-step',
          actionType: 'runbook.step',
          result: 'success',
          output: step.output,
          executedBy: this.manifest.id,
          executedAt: new Date(),
        },
      });
    } catch (err) {
      step.status = 'failed';
      step.completedAt = Date.now();
      step.output = err instanceof Error ? err.message : String(err);

      this.ctx.logger.error(
        'Runbook step failed',
        err instanceof Error ? err : new Error(String(err)),
        { executionId: execution.id, step: step.index },
      );

      await this.emitStepCompleted(execution, step);
    }
  }

  private async completeRunbook(execution: RunbookExecution): Promise<void> {
    execution.completedAt = Date.now();

    if (execution.status === 'completed') {
      this.totalCompleted++;
    } else {
      this.totalFailed++;
    }

    // Update cooldown
    this.cooldowns.set(execution.incidentId, Date.now());

    // Move to history
    this.executions.delete(execution.id);
    this.history.push(execution);

    // Trim history
    while (this.history.length > this.config.maxRunbookHistory) {
      this.history.shift();
    }

    await this.emitRunbookCompleted(execution);

    this.ctx.logger.info('Runbook execution completed', {
      executionId: execution.id,
      status: execution.status,
      durationMs: execution.completedAt - execution.startedAt,
    });
  }

  // ── Event Emission ───────────────────────────────────────────────────────

  private async emitRunbookStarted(execution: RunbookExecution): Promise<void> {
    const payload: RunbookStartedPayload = {
      executionId: execution.id,
      runbookId: execution.runbookId,
      runbookTitle: execution.runbookTitle,
      incidentId: execution.incidentId,
      totalSteps: execution.steps.length,
    };

    await this.ctx.bus.publish<RunbookStartedPayload>({
      type: 'runbook.started',
      source: this.manifest.id,
      timestamp: new Date(),
      payload,
    });
  }

  private async emitStepCompleted(
    execution: RunbookExecution,
    step: RunbookStep,
  ): Promise<void> {
    const payload: RunbookStepCompletedPayload = {
      executionId: execution.id,
      runbookId: execution.runbookId,
      incidentId: execution.incidentId,
      stepIndex: step.index,
      instruction: step.instruction,
      status: step.status,
      output: step.output,
    };

    await this.ctx.bus.publish<RunbookStepCompletedPayload>({
      type: 'runbook.stepCompleted',
      source: this.manifest.id,
      timestamp: new Date(),
      payload,
    });
  }

  private async emitRunbookCompleted(execution: RunbookExecution): Promise<void> {
    const completedSteps = execution.steps.filter((s) => s.status === 'completed').length;
    const failedSteps = execution.steps.filter((s) => s.status === 'failed').length;

    const payload: RunbookCompletedPayload = {
      executionId: execution.id,
      runbookId: execution.runbookId,
      runbookTitle: execution.runbookTitle,
      incidentId: execution.incidentId,
      status: execution.status,
      totalSteps: execution.steps.length,
      completedSteps,
      failedSteps,
      durationMs: (execution.completedAt ?? Date.now()) - execution.startedAt,
    };

    await this.ctx.bus.publish<RunbookCompletedPayload>({
      type: 'runbook.completed',
      source: this.manifest.id,
      timestamp: new Date(),
      payload,
    });
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getExecutions(): Map<string, RunbookExecution> {
    return this.executions;
  }

  getHistory(): RunbookExecution[] {
    return this.history;
  }

  getMetrics(): {
    totalStarted: number;
    totalCompleted: number;
    totalFailed: number;
    totalStepsExecuted: number;
    activeRunbooks: number;
    historySize: number;
  } {
    return {
      totalStarted: this.totalStarted,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalStepsExecuted: this.totalStepsExecuted,
      activeRunbooks: this.executions.size,
      historySize: this.history.length,
    };
  }

  getConfig(): RunbookConfig {
    return this.config;
  }

  getCooldowns(): Map<string, number> {
    return this.cooldowns;
  }

  getApprovalMappings(): Map<string, { executionId: string; stepIndex?: number }> {
    return this.approvalToExecution;
  }
}
