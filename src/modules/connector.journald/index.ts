// ---------------------------------------------------------------------------
// OpsPilot — connector.journald (systemd Journal Reader)
// ---------------------------------------------------------------------------
// Reads entries from the systemd journal via `journalctl --output=json`
// subprocess, parses them, and emits `log.ingested` events.
//
// Since the systemd journal C API is Linux-specific and requires native
// bindings, this connector uses `journalctl` CLI as a portable approach
// that works on any system with systemd installed.
//
// Features:
//   - Polls journalctl with cursor-based resumption (no missed entries)
//   - Unit filtering (e.g., only nginx.service, sshd.service)
//   - Priority filtering (syslog priorities 0-7)
//   - Structured metadata extraction (unit, PID, hostname, priority)
//   - Graceful fallback when journalctl is unavailable (non-Linux systems)
//   - Health reporting with entry counts and error tracking
// ---------------------------------------------------------------------------

import { spawn, ChildProcess } from 'node:child_process';
import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { LogIngestedPayload } from '../../shared/events';
import configSchema from './schema.json';

// ── Types ──────────────────────────────────────────────────────────────────

interface JournaldConfig {
  pollIntervalMs: number;
  source: string;
  units: string[];
  priorities: number[];
  maxEntriesPerPoll: number;
  sinceBoot: boolean;
}

const DEFAULTS: JournaldConfig = {
  pollIntervalMs: 2000,
  source: 'journald',
  units: [],
  priorities: [0, 1, 2, 3, 4, 5, 6],
  maxEntriesPerPoll: 500,
  sinceBoot: true,
};

const PRIORITY_TO_SEVERITY: Record<number, string> = {
  0: 'critical',   // emerg
  1: 'critical',   // alert
  2: 'critical',   // crit
  3: 'warning',    // err
  4: 'warning',    // warning
  5: 'info',       // notice
  6: 'info',       // info
  7: 'info',       // debug
};

/** Parsed journal entry structure. */
export interface JournalEntry {
  cursor: string;
  timestamp: Date;
  hostname: string;
  unit: string;
  message: string;
  priority: number;
  pid?: string;
  uid?: string;
  syslogIdentifier?: string;
}

// ── Module Implementation ──────────────────────────────────────────────────

export class JournaldConnector implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'connector.journald',
    name: 'systemd Journal Reader',
    version: '0.1.0',
    type: ModuleType.Connector,
    description: 'Reads systemd journal entries and emits log.ingested events.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: JournaldConfig;

  // State
  private cursor: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private journalctlAvailable = true;

  // Metrics
  private entriesRead = 0;
  private entriesEmitted = 0;
  private pollCycles = 0;
  private errors = 0;
  private healthy = true;
  private lastError?: string;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    const raw = context.config as Partial<JournaldConfig>;

    this.config = {
      pollIntervalMs: raw.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      source: raw.source ?? DEFAULTS.source,
      units: raw.units ?? [...DEFAULTS.units],
      priorities: raw.priorities ?? [...DEFAULTS.priorities],
      maxEntriesPerPoll: raw.maxEntriesPerPoll ?? DEFAULTS.maxEntriesPerPoll,
      sinceBoot: raw.sinceBoot ?? DEFAULTS.sinceBoot,
    };

    // Check if journalctl is available
    this.journalctlAvailable = await this.checkJournalctl();

    if (!this.journalctlAvailable) {
      this.ctx.logger.warn('journalctl not available — connector will be inactive');
    }

    this.ctx.logger.info('Initialized', {
      units: this.config.units,
      priorities: this.config.priorities,
      available: this.journalctlAvailable,
    });
  }

  async start(): Promise<void> {
    if (!this.journalctlAvailable) {
      this.ctx.logger.warn('journalctl not available, not starting polling');
      return;
    }

    this.running = true;

    // Initial poll
    await this.poll();

    this.pollTimer = setInterval(() => {
      if (this.running) {
        this.poll().catch((err) => {
          this.errors++;
          this.lastError = err instanceof Error ? err.message : String(err);
          this.ctx.logger.error('Journal poll error', err instanceof Error ? err : undefined);
        });
      }
    }, this.config.pollIntervalMs);

    this.ctx.logger.info('Started journal polling', {
      intervalMs: this.config.pollIntervalMs,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.ctx.logger.info('Stopped', {
      entriesRead: this.entriesRead,
      entriesEmitted: this.entriesEmitted,
    });
  }

  async destroy(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  health(): ModuleHealth {
    const status = !this.journalctlAvailable
      ? 'unhealthy'
      : this.healthy
        ? 'healthy'
        : 'degraded';

    return {
      status,
      message: !this.journalctlAvailable
        ? 'journalctl not available'
        : this.lastError,
      details: {
        journalctlAvailable: this.journalctlAvailable,
        entriesRead: this.entriesRead,
        entriesEmitted: this.entriesEmitted,
        pollCycles: this.pollCycles,
        errors: this.errors,
        cursor: this.cursor,
      },
      lastCheck: new Date(),
    };
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  /** Run one poll cycle. Public for testing. */
  async poll(): Promise<void> {
    this.pollCycles++;
    const args = this.buildArgs();
    const entries = await this.execJournalctl(args);

    for (const entry of entries.slice(0, this.config.maxEntriesPerPoll)) {
      this.entriesRead++;
      this.cursor = entry.cursor;

      const opsSeverity = PRIORITY_TO_SEVERITY[entry.priority] ?? 'info';

      const payload: LogIngestedPayload = {
        source: this.config.source,
        line: entry.message,
        ingestedAt: new Date(),
        metadata: {
          collector: 'connector.journald',
          hostname: entry.hostname,
          unit: entry.unit,
          priority: entry.priority,
          opsSeverity,
          pid: entry.pid,
          uid: entry.uid,
          syslogIdentifier: entry.syslogIdentifier,
          cursor: entry.cursor,
          originalTimestamp: entry.timestamp.toISOString(),
        },
      };

      this.ctx.bus.publish<LogIngestedPayload>({
        type: 'log.ingested',
        source: this.manifest.id,
        timestamp: new Date(),
        payload,
      });

      this.entriesEmitted++;
    }

    this.healthy = true;
  }

  // ── journalctl Interaction ───────────────────────────────────────────────

  private buildArgs(): string[] {
    const args = ['--output=json', '--no-pager'];

    if (this.cursor) {
      args.push(`--after-cursor=${this.cursor}`);
    } else if (this.config.sinceBoot) {
      args.push('--boot');
    } else {
      args.push('--lines=0');
    }

    // Unit filters
    for (const unit of this.config.units) {
      args.push(`--unit=${unit}`);
    }

    // Priority filter (max priority level)
    const maxPriority = Math.max(...this.config.priorities);
    args.push(`--priority=${maxPriority}`);

    return args;
  }

  /** Execute journalctl and parse JSON lines. Overridable for testing. */
  async execJournalctl(args: string[]): Promise<JournalEntry[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn('journalctl', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`journalctl exited with code ${code}: ${stderr}`));
          return;
        }

        const entries: JournalEntry[] = [];
        const lines = stdout.split('\n').filter((l) => l.trim().length > 0);

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            entries.push(this.parseEntry(obj));
          } catch {
            // Skip unparseable lines
          }
        }

        resolve(entries);
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /** Parse a journalctl JSON object into a JournalEntry. Public for testing. */
  parseEntry(obj: Record<string, unknown>): JournalEntry {
    const cursor = (obj.__CURSOR as string) ?? '';
    const realtimeUs = obj.__REALTIME_TIMESTAMP as string;
    const timestamp = realtimeUs
      ? new Date(parseInt(realtimeUs, 10) / 1000)
      : new Date();

    return {
      cursor,
      timestamp,
      hostname: (obj._HOSTNAME as string) ?? 'unknown',
      unit: (obj._SYSTEMD_UNIT as string) ?? (obj.SYSLOG_IDENTIFIER as string) ?? 'unknown',
      message: (obj.MESSAGE as string) ?? '',
      priority: parseInt((obj.PRIORITY as string) ?? '6', 10),
      pid: obj._PID as string | undefined,
      uid: obj._UID as string | undefined,
      syslogIdentifier: obj.SYSLOG_IDENTIFIER as string | undefined,
    };
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  private async checkJournalctl(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('journalctl', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getConfig(): JournaldConfig { return this.config; }

  getMetrics() {
    return {
      entriesRead: this.entriesRead,
      entriesEmitted: this.entriesEmitted,
      pollCycles: this.pollCycles,
      errors: this.errors,
    };
  }

  getCursor(): string | null { return this.cursor; }

  isAvailable(): boolean { return this.journalctlAvailable; }

  /** Override availability for testing. */
  setAvailable(available: boolean): void {
    this.journalctlAvailable = available;
  }

  /** Inject entries directly for testing (bypasses journalctl). */
  async injectEntries(entries: JournalEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entriesRead++;
      this.cursor = entry.cursor;

      const opsSeverity = PRIORITY_TO_SEVERITY[entry.priority] ?? 'info';

      const payload: LogIngestedPayload = {
        source: this.config.source,
        line: entry.message,
        ingestedAt: new Date(),
        metadata: {
          collector: 'connector.journald',
          hostname: entry.hostname,
          unit: entry.unit,
          priority: entry.priority,
          opsSeverity,
          pid: entry.pid,
          cursor: entry.cursor,
        },
      };

      this.ctx.bus.publish<LogIngestedPayload>({
        type: 'log.ingested',
        source: this.manifest.id,
        timestamp: new Date(),
        payload,
      });

      this.entriesEmitted++;
    }
  }
}
