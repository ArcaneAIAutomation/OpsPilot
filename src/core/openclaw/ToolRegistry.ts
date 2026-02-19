// ---------------------------------------------------------------------------
// OpsPilot — OpenClaw Tool Registry
// ---------------------------------------------------------------------------
// Central registry for all tools registered by modules. Handles:
//   - Tool registration/unregistration
//   - Input validation via JSON Schema
//   - Approval token enforcement for mutating tools
//   - Audit logging of all invocations
// ---------------------------------------------------------------------------

import Ajv from 'ajv';
import {
  OpenClawTool,
  ToolHandler,
  ToolInvocation,
  ToolResult,
  IToolRegistry,
} from '../types/openclaw';
import { IApprovalGate } from '../types/security';
import { IAuditLogger } from '../types/security';
import { ILogger } from '../types/module';

interface RegisteredTool {
  tool: OpenClawTool;
  handler: ToolHandler;
}

export class ToolRegistry implements IToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly ajv: Ajv;
  private readonly approvalGate: IApprovalGate;
  private readonly audit: IAuditLogger;
  private readonly logger: ILogger;

  constructor(
    approvalGate: IApprovalGate,
    audit: IAuditLogger,
    logger: ILogger,
  ) {
    this.approvalGate = approvalGate;
    this.audit = audit;
    this.logger = logger.child('ToolRegistry');
    this.ajv = new Ajv({ allErrors: true, strict: false });
  }

  // ── Registration ─────────────────────────────────────────────────────────

  register(tool: OpenClawTool, handler: ToolHandler): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: "${tool.name}"`);
    }

    // Pre-compile the input schema for fast validation
    try {
      this.ajv.compile(tool.inputSchema);
    } catch (err) {
      throw new Error(
        `Invalid input schema for tool "${tool.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.tools.set(tool.name, { tool, handler });
    this.logger.info('Tool registered', { name: tool.name, registeredBy: tool.registeredBy });
  }

  unregister(toolName: string): boolean {
    const existed = this.tools.delete(toolName);
    if (existed) {
      this.logger.info('Tool unregistered', { name: toolName });
    }
    return existed;
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getTool(toolName: string): OpenClawTool | undefined {
    return this.tools.get(toolName)?.tool;
  }

  listTools(filter?: { tag?: string; requiresApproval?: boolean }): OpenClawTool[] {
    let result = Array.from(this.tools.values()).map((r) => r.tool);

    if (filter?.tag) {
      result = result.filter((t) => t.tags?.includes(filter.tag!));
    }
    if (filter?.requiresApproval !== undefined) {
      result = result.filter((t) => t.requiresApproval === filter.requiresApproval);
    }

    return result;
  }

  // ── Invocation ───────────────────────────────────────────────────────────

  async invoke(invocation: ToolInvocation): Promise<ToolResult> {
    const registered = this.tools.get(invocation.toolName);
    if (!registered) {
      return { success: false, error: `Unknown tool: "${invocation.toolName}"` };
    }

    const { tool, handler } = registered;

    // Validate input against schema
    const validate = this.ajv.compile(tool.inputSchema);
    if (!validate(invocation.params)) {
      const errors = validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ');
      return { success: false, error: `Invalid input: ${errors}` };
    }

    // Enforce approval for mutating tools
    if (tool.requiresApproval) {
      if (!invocation.approvalToken) {
        return {
          success: false,
          error: 'This tool requires an approval token. Propose the action first.',
        };
      }

      const tokenValid = await this.approvalGate.validateToken(invocation.approvalToken);
      if (!tokenValid) {
        return {
          success: false,
          error: 'Approval token is invalid or expired.',
        };
      }
    }

    // Audit the invocation
    await this.audit.log({
      action: 'tool.invoked',
      actor: invocation.invokedBy,
      target: invocation.toolName,
      details: {
        params: invocation.params,
        requiresApproval: tool.requiresApproval,
        hasToken: !!invocation.approvalToken,
      },
    });

    // Execute the handler
    try {
      const result = await handler(invocation);

      // Audit the result
      await this.audit.log({
        action: result.success ? 'tool.succeeded' : 'tool.failed',
        actor: invocation.invokedBy,
        target: invocation.toolName,
        details: {
          success: result.success,
          error: result.error,
        },
      });

      this.logger.info('Tool invoked', {
        tool: invocation.toolName,
        invokedBy: invocation.invokedBy,
        success: result.success,
      });

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      await this.audit.log({
        action: 'tool.error',
        actor: invocation.invokedBy,
        target: invocation.toolName,
        details: { error: errorMsg },
      });

      this.logger.error(
        'Tool invocation error',
        err instanceof Error ? err : new Error(errorMsg),
        { tool: invocation.toolName },
      );

      return { success: false, error: errorMsg };
    }
  }
}
