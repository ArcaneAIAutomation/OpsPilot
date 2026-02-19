// ---------------------------------------------------------------------------
// OpsPilot — OpenClaw Types
// ---------------------------------------------------------------------------
// OpenClaw is the plugin interface layer. Modules register "tools" that
// can be invoked by external AI agents, CLI commands, or UI actions.
//
// Tools are deterministic functions — they read data, query state, or
// propose actions. Tools that mutate state MUST go through the approval
// gate. AI is NEVER used for execution.
// ---------------------------------------------------------------------------

/**
 * Describes a single callable tool exposed by a module.
 */
export interface OpenClawTool {
  /** Unique tool identifier, e.g. `incidents.list` */
  readonly name: string;

  /** Human-readable description for AI/UI consumption. */
  readonly description: string;

  /** Module that registered this tool. */
  readonly registeredBy: string;

  /** JSON Schema for the tool's input parameters. */
  readonly inputSchema: Record<string, unknown>;

  /**
   * Whether this tool requires an approval token for execution.
   * Tools that read data: false
   * Tools that propose/execute actions: true
   */
  readonly requiresApproval: boolean;

  /** Tags for categorization / filtering. */
  readonly tags?: readonly string[];
}

/**
 * The result returned by tool execution.
 */
export interface ToolResult {
  /** Whether the tool executed successfully. */
  success: boolean;

  /** Human-readable result data. */
  data?: unknown;

  /** Error message if success is false. */
  error?: string;
}

/**
 * Invocation request for a tool.
 */
export interface ToolInvocation {
  /** Name of the tool to invoke. */
  toolName: string;

  /** Input parameters (validated against inputSchema). */
  params: Record<string, unknown>;

  /** Who is invoking the tool (user ID, AI agent, etc.). */
  invokedBy: string;

  /** Approval token, required for tools with requiresApproval=true. */
  approvalToken?: {
    id: string;
    requestId: string;
    approvedBy: string;
    approvedAt: Date;
    expiresAt?: Date;
  };
}

/**
 * Handler function for a registered tool.
 */
export type ToolHandler = (invocation: ToolInvocation) => Promise<ToolResult>;

/**
 * Registry for managing OpenClaw tools.
 */
export interface IToolRegistry {
  /** Register a new tool. Throws if a tool with the same name exists. */
  register(tool: OpenClawTool, handler: ToolHandler): void;

  /** Unregister a tool by name. */
  unregister(toolName: string): boolean;

  /** Get a tool definition by name. */
  getTool(toolName: string): OpenClawTool | undefined;

  /** List all registered tools. */
  listTools(filter?: { tag?: string; requiresApproval?: boolean }): OpenClawTool[];

  /** Invoke a tool by name with the given invocation. */
  invoke(invocation: ToolInvocation): Promise<ToolResult>;
}
