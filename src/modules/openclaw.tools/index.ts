// ---------------------------------------------------------------------------
// OpsPilot — openclaw.tools
// ---------------------------------------------------------------------------
// Registers core operational tools into the OpenClaw ToolRegistry.
// These tools provide:
//   - incidents.list   — List incidents (read-only, no approval needed)
//   - incidents.get    — Get a single incident by ID (read-only)
//   - incidents.summary — Get incident statistics (read-only)
//   - incidents.updateStatus — Change incident status (requires approval)
//   - actions.propose  — Propose an action for approval (creates request)
//   - audit.query      — Query the audit trail (read-only)
//
// Tools are deterministic functions. AI is NEVER used for execution.
// Mutating tools REQUIRE an approval token.
// ---------------------------------------------------------------------------

import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { IToolRegistry, ToolInvocation, ToolResult } from '../../core/types/openclaw';
import { IncidentStore, StoredIncident } from '../enricher.incidentStore';
import { IncidentSeverity } from '../../shared/events';
import configSchema from './schema.json';

// ── Module Implementation ──────────────────────────────────────────────────

export class OpenClawToolsModule implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'openclaw.tools',
    name: 'OpenClaw Core Tools',
    version: '0.1.0',
    type: ModuleType.OpenClawTool,
    description: 'Registers core operational tools for the OpenClaw interface.',
    dependencies: ['enricher.incidentStore'],
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private toolRegistry!: IToolRegistry;
  private incidentStore!: IncidentStore;

  // Metrics
  private toolsRegistered = 0;
  private healthy = true;

  /**
   * Inject external dependencies that cannot come from ModuleContext.
   * Called by the composition root before `initialize()`.
   */
  setDependencies(toolRegistry: IToolRegistry, incidentStore: IncidentStore): void {
    this.toolRegistry = toolRegistry;
    this.incidentStore = incidentStore;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    if (!this.toolRegistry) {
      throw new Error('ToolRegistry not injected. Call setDependencies() before initialize().');
    }
    if (!this.incidentStore) {
      throw new Error('IncidentStore not injected. Call setDependencies() before initialize().');
    }

    this.ctx.logger.info('Initialized');
  }

  async start(): Promise<void> {
    this.registerTools();
    this.ctx.logger.info('Started', { toolsRegistered: this.toolsRegistered });
  }

  async stop(): Promise<void> {
    // Unregister all tools we registered
    const toolNames = [
      'incidents.list',
      'incidents.get',
      'incidents.summary',
      'incidents.updateStatus',
      'actions.propose',
      'audit.query',
    ];
    for (const name of toolNames) {
      this.toolRegistry.unregister(name);
    }

    this.ctx.logger.info('Stopped — all tools unregistered');
  }

  async destroy(): Promise<void> {
    this.ctx = undefined!;
    this.toolRegistry = undefined!;
    this.incidentStore = undefined!;
  }

  health(): ModuleHealth {
    return {
      status: this.healthy ? 'healthy' : 'degraded',
      details: { toolsRegistered: this.toolsRegistered },
      lastCheck: new Date(),
    };
  }

  // ── Tool Registration ────────────────────────────────────────────────────

  private registerTools(): void {
    // ── incidents.list ─────────────────────────────────────────────────
    this.toolRegistry.register(
      {
        name: 'incidents.list',
        description: 'List incidents with optional severity/status filter and limit.',
        registeredBy: this.manifest.id,
        requiresApproval: false,
        tags: ['incidents', 'read'],
        inputSchema: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
            status: { type: 'string', enum: ['open', 'acknowledged', 'resolved', 'closed'] },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          additionalProperties: false,
        },
      },
      async (inv: ToolInvocation): Promise<ToolResult> => {
        const incidents = await this.incidentStore.listIncidents({
          severity: inv.params.severity as IncidentSeverity | undefined,
          status: inv.params.status as StoredIncident['status'] | undefined,
          limit: (inv.params.limit as number) ?? 20,
        });
        return { success: true, data: incidents };
      },
    );
    this.toolsRegistered++;

    // ── incidents.get ──────────────────────────────────────────────────
    this.toolRegistry.register(
      {
        name: 'incidents.get',
        description: 'Get a single incident by its ID, including timeline and enrichments.',
        registeredBy: this.manifest.id,
        requiresApproval: false,
        tags: ['incidents', 'read'],
        inputSchema: {
          type: 'object',
          properties: {
            incidentId: { type: 'string' },
          },
          required: ['incidentId'],
          additionalProperties: false,
        },
      },
      async (inv: ToolInvocation): Promise<ToolResult> => {
        const incident = await this.incidentStore.getIncident(
          inv.params.incidentId as string,
        );
        if (!incident) {
          return { success: false, error: `Incident not found: ${inv.params.incidentId}` };
        }
        return { success: true, data: incident };
      },
    );
    this.toolsRegistered++;

    // ── incidents.summary ──────────────────────────────────────────────
    this.toolRegistry.register(
      {
        name: 'incidents.summary',
        description: 'Get aggregate incident statistics: counts by severity and status.',
        registeredBy: this.manifest.id,
        requiresApproval: false,
        tags: ['incidents', 'read', 'statistics'],
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      async (): Promise<ToolResult> => {
        const summary = await this.incidentStore.getSummary();
        return { success: true, data: summary };
      },
    );
    this.toolsRegistered++;

    // ── incidents.updateStatus ─────────────────────────────────────────
    this.toolRegistry.register(
      {
        name: 'incidents.updateStatus',
        description:
          'Update the status of an incident (e.g. open → acknowledged → resolved). Requires approval.',
        registeredBy: this.manifest.id,
        requiresApproval: true,
        tags: ['incidents', 'write'],
        inputSchema: {
          type: 'object',
          properties: {
            incidentId: { type: 'string' },
            newStatus: {
              type: 'string',
              enum: ['open', 'acknowledged', 'resolved', 'closed'],
            },
          },
          required: ['incidentId', 'newStatus'],
          additionalProperties: false,
        },
      },
      async (inv: ToolInvocation): Promise<ToolResult> => {
        try {
          const updated = await this.incidentStore.updateStatus(
            inv.params.incidentId as string,
            inv.params.newStatus as StoredIncident['status'],
            inv.invokedBy,
          );
          return { success: true, data: updated };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    );
    this.toolsRegistered++;

    // ── actions.propose ────────────────────────────────────────────────
    this.toolRegistry.register(
      {
        name: 'actions.propose',
        description:
          'Propose an action for human approval. Creates an approval request. The returned requestId can be used to approve/deny the action.',
        registeredBy: this.manifest.id,
        requiresApproval: false,  // proposing does not require approval
        tags: ['actions', 'write'],
        inputSchema: {
          type: 'object',
          properties: {
            actionType: { type: 'string', description: 'e.g. restart.service, scale.up' },
            description: { type: 'string' },
            reasoning: { type: 'string' },
            incidentId: { type: 'string' },
          },
          required: ['actionType', 'description', 'reasoning'],
          additionalProperties: false,
        },
      },
      async (inv: ToolInvocation): Promise<ToolResult> => {
        const request = await this.ctx.approvalGate.requestApproval({
          actionType: inv.params.actionType as string,
          description: inv.params.description as string,
          reasoning: inv.params.reasoning as string,
          requestedBy: inv.invokedBy,
          metadata: inv.params.incidentId
            ? { incidentId: inv.params.incidentId }
            : undefined,
        });
        return {
          success: true,
          data: {
            requestId: request.id,
            status: 'pending',
            message: 'Action proposed. Awaiting human approval.',
          },
        };
      },
    );
    this.toolsRegistered++;

    // ── audit.query ────────────────────────────────────────────────────
    this.toolRegistry.register(
      {
        name: 'audit.query',
        description: 'Query the audit trail. Filter by action, actor, time range, and limit.',
        registeredBy: this.manifest.id,
        requiresApproval: false,
        tags: ['audit', 'read'],
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            actor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          },
          additionalProperties: false,
        },
      },
      async (inv: ToolInvocation): Promise<ToolResult> => {
        // The audit logger is on the context's approvalGate's parent
        // But we can access it via the AuditLogger stored in storage
        // For now, we'll access through the module context pattern
        // Since IAuditLogger isn't directly on ModuleContext, we store
        // a reference during dependency injection — but the clean way
        // is to query storage directly.
        const auditEntries = await this.ctx.storage.list('audit');
        let filtered = auditEntries as Array<Record<string, unknown>>;

        if (inv.params.action) {
          filtered = filtered.filter((e) => e.action === inv.params.action);
        }
        if (inv.params.actor) {
          filtered = filtered.filter((e) => e.actor === inv.params.actor);
        }

        const limit = (inv.params.limit as number) ?? 50;
        filtered = filtered.slice(-limit);

        return { success: true, data: filtered };
      },
    );
    this.toolsRegistered++;
  }
}
