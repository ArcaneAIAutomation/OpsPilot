// ---------------------------------------------------------------------------
// OpsPilot — CLI Approval Interface
// ---------------------------------------------------------------------------
// Interactive command-line interface for operators to:
//   - List pending approval requests
//   - Approve or deny requests
//   - View recent audit log
//   - List active incidents
//
// This module listens on stdin and provides a simple command parser.
// It is NOT a module — it runs in the main process alongside the
// Application and accesses core subsystems directly.
// ---------------------------------------------------------------------------

import * as readline from 'node:readline';
import { IApprovalGate, ApprovalStatus, AuditEntry, IAuditLogger } from '../core/types/security';
import { IStorageEngine } from '../core/types/storage';
import { ILogger } from '../core/types/module';
import { IEventBus, OpsPilotEvent } from '../core/types/events';

// ── Internal stored request shape (mirrors ApprovalGate internals) ─────────

interface StoredRequest {
  id: string;
  actionType: string;
  description: string;
  reasoning: string;
  requestedBy: string;
  requestedAt: string;
  status: string;
  deniedReason?: string;
  metadata?: Record<string, unknown>;
}

// ── CLI Options ────────────────────────────────────────────────────────────

export interface CLIOptions {
  storage: IStorageEngine;
  approvalGate: IApprovalGate;
  auditLogger: IAuditLogger;
  bus: IEventBus;
  logger: ILogger;
  /** Operator identity for audit trail. */
  operatorId?: string;
}

// ── CLI Implementation ─────────────────────────────────────────────────────

export class ApprovalCLI {
  private readonly storage: IStorageEngine;
  private readonly gate: IApprovalGate;
  private readonly audit: IAuditLogger;
  private readonly bus: IEventBus;
  private readonly logger: ILogger;
  private readonly operatorId: string;
  private rl: readline.Interface | null = null;
  private running = false;

  // Collections used by ApprovalGate (mirrors internal constants)
  private readonly REQUESTS_COLLECTION = 'system::approval_requests';

  constructor(options: CLIOptions) {
    this.storage = options.storage;
    this.gate = options.approvalGate;
    this.audit = options.auditLogger;
    this.bus = options.bus;
    this.logger = options.logger.child('CLI');
    this.operatorId = options.operatorId ?? 'operator';
  }

  // ── Start / Stop ─────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '\n\x1b[36mopspilot>\x1b[0m ',
    });

    // Subscribe to action.proposed to alert the operator in real-time
    this.bus.subscribe('action.proposed', (event) => {
      this.onActionProposed(event);
    });

    this.printBanner();
    this.rl.prompt();

    this.rl.on('line', async (line: string) => {
      await this.handleInput(line.trim());
      if (this.running && this.rl) {
        this.rl.prompt();
      }
    });

    this.rl.on('close', () => {
      this.running = false;
    });
  }

  stop(): void {
    this.running = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  // ── Banner ───────────────────────────────────────────────────────────────

  private printBanner(): void {
    this.print('');
    this.print('╔══════════════════════════════════════════════╗');
    this.print('║        OpsPilot — Approval Console          ║');
    this.print('╚══════════════════════════════════════════════╝');
    this.print('');
    this.print('Commands:');
    this.print('  \x1b[33mpending\x1b[0m            List pending approval requests');
    this.print('  \x1b[33mapprove <id>\x1b[0m        Approve a pending request');
    this.print('  \x1b[33mdeny <id> [reason]\x1b[0m  Deny a pending request');
    this.print('  \x1b[33mstatus <id>\x1b[0m         Check request status');
    this.print('  \x1b[33maudit [limit]\x1b[0m       Show recent audit entries');
    this.print('  \x1b[33mhelp\x1b[0m               Show this help');
    this.print('  \x1b[33mquit\x1b[0m               Exit the CLI (keeps OpsPilot running)');
    this.print('');
  }

  // ── Real-time notification ───────────────────────────────────────────────

  private onActionProposed(event: OpsPilotEvent<unknown>): void {
    const payload = event.payload as StoredRequest;
    this.print('');
    this.print('\x1b[33m⚡ NEW APPROVAL REQUEST\x1b[0m');
    this.print(`  ID:          ${payload.id}`);
    this.print(`  Action:      ${payload.actionType}`);
    this.print(`  Description: ${payload.description}`);
    this.print(`  Requested by: ${payload.requestedBy}`);
    this.print(`  Reasoning:   ${payload.reasoning}`);
    this.print('');
    this.print('  Use \x1b[33mapprove ' + payload.id + '\x1b[0m or \x1b[33mdeny ' + payload.id + ' <reason>\x1b[0m');
    if (this.rl) this.rl.prompt();
  }

  // ── Command Router ───────────────────────────────────────────────────────

  private async handleInput(input: string): Promise<void> {
    if (!input) return;

    const parts = input.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    try {
      switch (command) {
        case 'pending':
        case 'p':
          await this.cmdPending();
          break;

        case 'approve':
        case 'a':
          await this.cmdApprove(args);
          break;

        case 'deny':
        case 'd':
          await this.cmdDeny(args);
          break;

        case 'status':
        case 's':
          await this.cmdStatus(args);
          break;

        case 'audit':
          await this.cmdAudit(args);
          break;

        case 'help':
        case 'h':
        case '?':
          this.printBanner();
          break;

        case 'quit':
        case 'exit':
        case 'q':
          this.print('CLI closed. OpsPilot continues running.');
          this.stop();
          break;

        default:
          this.print(`\x1b[31mUnknown command:\x1b[0m ${command}. Type \x1b[33mhelp\x1b[0m for commands.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.print(`\x1b[31mError:\x1b[0m ${msg}`);
    }
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  private async cmdPending(): Promise<void> {
    const requests = await this.storage.list<StoredRequest>(this.REQUESTS_COLLECTION);
    const pending = requests.filter((r) => r.status === 'pending');

    if (pending.length === 0) {
      this.print('No pending approval requests.');
      return;
    }

    this.print(`\n\x1b[1m${pending.length} pending request(s):\x1b[0m\n`);

    for (const req of pending) {
      const age = this.formatAge(req.requestedAt);
      this.print(`  \x1b[36m${req.id}\x1b[0m`);
      this.print(`    Action:      ${req.actionType}`);
      this.print(`    Description: ${req.description}`);
      this.print(`    Requested by: ${req.requestedBy}`);
      this.print(`    Reasoning:   ${req.reasoning}`);
      this.print(`    Requested:   ${age} ago`);

      if (req.metadata) {
        const incidentId = req.metadata.incidentId as string | undefined;
        if (incidentId) {
          this.print(`    Incident ID: ${incidentId}`);
        }
        const command = req.metadata.command as string | undefined;
        if (command) {
          this.print(`    Command:     ${command}`);
        }
      }
      this.print('');
    }
  }

  private async cmdApprove(args: string[]): Promise<void> {
    const requestId = this.resolveRequestId(args[0]);
    if (!requestId) {
      this.print('Usage: \x1b[33mapprove <request-id>\x1b[0m');
      return;
    }

    const match = await this.findRequest(requestId);
    if (!match) return;

    this.print(`\n\x1b[1mApproval Confirmation\x1b[0m`);
    this.print(`  Request: ${match.id}`);
    this.print(`  Action:  ${match.actionType}`);
    this.print(`  Desc:    ${match.description}`);
    this.print('');

    const token = await this.gate.approve(match.id, this.operatorId);
    this.print(`\x1b[32m✓ Approved.\x1b[0m Token: ${token.id}`);
    this.print(`  Expires: ${token.expiresAt ? new Date(token.expiresAt).toISOString() : 'never'}`);
    this.logger.info('Request approved via CLI', {
      requestId: match.id,
      tokenId: token.id,
      approvedBy: this.operatorId,
    });
  }

  private async cmdDeny(args: string[]): Promise<void> {
    const requestId = this.resolveRequestId(args[0]);
    if (!requestId) {
      this.print('Usage: \x1b[33mdeny <request-id> [reason]\x1b[0m');
      return;
    }

    const match = await this.findRequest(requestId);
    if (!match) return;

    const reason = args.slice(1).join(' ') || undefined;

    await this.gate.deny(match.id, this.operatorId, reason);
    this.print(`\x1b[31m✗ Denied.\x1b[0m Request: ${match.id}`);
    if (reason) {
      this.print(`  Reason: ${reason}`);
    }
    this.logger.info('Request denied via CLI', {
      requestId: match.id,
      deniedBy: this.operatorId,
      reason,
    });
  }

  private async cmdStatus(args: string[]): Promise<void> {
    const requestId = this.resolveRequestId(args[0]);
    if (!requestId) {
      this.print('Usage: \x1b[33mstatus <request-id>\x1b[0m');
      return;
    }

    const match = await this.findRequest(requestId);
    if (!match) return;

    const status = await this.gate.getStatus(match.id);
    const statusColor = status === 'approved' ? '\x1b[32m' : status === 'denied' ? '\x1b[31m' : '\x1b[33m';

    this.print(`\n  Request: ${match.id}`);
    this.print(`  Status:  ${statusColor}${status}\x1b[0m`);
    this.print(`  Action:  ${match.actionType}`);
    this.print(`  Desc:    ${match.description}`);
    this.print(`  From:    ${match.requestedBy}`);
    this.print(`  At:      ${new Date(match.requestedAt).toISOString()}`);
  }

  private async cmdAudit(args: string[]): Promise<void> {
    const limit = parseInt(args[0] ?? '10', 10);
    const entries = await this.audit.query({ limit: Math.min(limit, 50) });

    if (entries.length === 0) {
      this.print('No audit entries found.');
      return;
    }

    this.print(`\n\x1b[1mRecent audit entries (${entries.length}):\x1b[0m\n`);

    for (const entry of entries) {
      const ts = new Date(entry.timestamp).toISOString().replace('T', ' ').slice(0, 19);
      const target = entry.target ? ` → ${entry.target}` : '';
      this.print(`  ${ts}  \x1b[33m${entry.action}\x1b[0m  by ${entry.actor}${target}`);

      if (entry.details) {
        const detailStr = Object.entries(entry.details)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(', ');
        this.print(`    ${detailStr}`);
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Allow prefix matching on request IDs (e.g., first 8 chars). */
  private resolveRequestId(input: string | undefined): string | undefined {
    return input?.trim() || undefined;
  }

  private async findRequest(idOrPrefix: string): Promise<StoredRequest | null> {
    // First try exact match
    const exact = await this.storage.get<StoredRequest>(this.REQUESTS_COLLECTION, idOrPrefix);
    if (exact) return exact;

    // Try prefix match
    const all = await this.storage.list<StoredRequest>(this.REQUESTS_COLLECTION);
    const matches = all.filter((r) => r.id.startsWith(idOrPrefix));

    if (matches.length === 0) {
      this.print(`\x1b[31mNo request found matching:\x1b[0m ${idOrPrefix}`);
      return null;
    }
    if (matches.length > 1) {
      this.print(`\x1b[31mAmbiguous ID:\x1b[0m ${idOrPrefix} matches ${matches.length} requests:`);
      for (const r of matches) {
        this.print(`  ${r.id}  (${r.status})`);
      }
      return null;
    }

    return matches[0];
  }

  private formatAge(dateStr: string | Date): string {
    const ms = Date.now() - new Date(dateStr).getTime();
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
    return `${Math.round(ms / 86_400_000)}d`;
  }

  private print(msg: string): void {
    process.stdout.write(msg + '\n');
  }
}
