// ---------------------------------------------------------------------------
// OpsPilot — connector.fileTail
// ---------------------------------------------------------------------------
// Tails a log file on disk and emits `log.ingested` events for each new
// line. Uses `fs.watch` for change notifications with a polling fallback.
// Handles log rotation (file truncation) gracefully.
//
// This is the first module in OpsPilot and serves as the reference
// implementation for the IModule contract.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { Readable } from 'node:stream';
import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { OpsPilotEvent } from '../../core/types/events';
import { LogIngestedPayload } from '../../shared/events';
import configSchema from './schema.json';

// ── Config shape (mirrors schema.json) ─────────────────────────────────────

interface FileTailConfig {
  path: string;
  encoding: BufferEncoding;
  pollIntervalMs: number;
  fromBeginning: boolean;
  maxLineLength: number;
}

const DEFAULTS: Omit<FileTailConfig, 'path'> = {
  encoding: 'utf-8',
  pollIntervalMs: 1000,
  fromBeginning: false,
  maxLineLength: 65536,
};

// ── Module Implementation ──────────────────────────────────────────────────

export class FileTailConnector implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'connector.fileTail',
    name: 'File Tail Connector',
    version: '0.1.0',
    type: ModuleType.Connector,
    description: 'Tails a log file and emits log.ingested events for each new line.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: FileTailConfig;

  /** Current byte offset in the file — we start reading from here. */
  private byteOffset = 0;

  /** Total lines ingested since start. */
  private linesIngested = 0;

  /** fs.watch handle. */
  private watcher: fs.FSWatcher | null = null;

  /** Polling interval handle (fallback). */
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Prevents concurrent reads from overlapping. */
  private reading = false;

  /** Tracks health status. */
  private healthy = true;
  private lastError: string | undefined;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    // Merge config with defaults
    this.config = {
      ...DEFAULTS,
      ...context.config,
    } as FileTailConfig;

    // Warn (don't fail) if the file doesn't exist yet — it may be created later
    if (!fs.existsSync(this.config.path)) {
      this.ctx.logger.warn('Log file does not exist yet — will wait for creation', {
        path: this.config.path,
      });
    }

    this.ctx.logger.info('Initialized', {
      path: this.config.path,
      encoding: this.config.encoding,
      fromBeginning: this.config.fromBeginning,
    });
  }

  async start(): Promise<void> {
    // Determine starting offset
    if (this.config.fromBeginning) {
      this.byteOffset = 0;
    } else if (fs.existsSync(this.config.path)) {
      const stat = fs.statSync(this.config.path);
      this.byteOffset = stat.size;
      this.ctx.logger.info('Starting from end of file', { byteOffset: this.byteOffset });
    } else {
      this.byteOffset = 0;
    }

    // Start watching for changes
    this.startWatching();

    // If reading from beginning, do an initial read of existing content.
    // Deferred via setImmediate so that all modules complete start() first —
    // this ensures subscribers (e.g. detectors) are active before events flow.
    if (this.config.fromBeginning && fs.existsSync(this.config.path)) {
      setImmediate(() => this.onFileChange());
    }

    this.ctx.logger.info('Started tailing', { path: this.config.path });
  }

  async stop(): Promise<void> {
    this.stopWatching();
    this.ctx.logger.info('Stopped tailing', {
      path: this.config.path,
      linesIngested: this.linesIngested,
    });
  }

  async destroy(): Promise<void> {
    this.stopWatching();
    this.ctx = undefined!;
    this.config = undefined!;
  }

  health(): ModuleHealth {
    return {
      status: this.healthy ? 'healthy' : 'degraded',
      message: this.lastError,
      details: {
        path: this.config?.path,
        byteOffset: this.byteOffset,
        linesIngested: this.linesIngested,
      },
      lastCheck: new Date(),
    };
  }

  // ── File Watching ────────────────────────────────────────────────────────

  private startWatching(): void {
    try {
      // Use fs.watch for efficient OS-level notifications
      this.watcher = fs.watch(this.config.path, (eventType) => {
        if (eventType === 'change') {
          this.onFileChange();
        } else if (eventType === 'rename') {
          // File was rotated or deleted — reset and re-attach
          this.ctx.logger.warn('File renamed or rotated, resetting offset', {
            path: this.config.path,
          });
          this.byteOffset = 0;
          // Re-establish the watcher after a brief delay (file may be recreated)
          this.restartWatcher();
        }
      });

      this.watcher.on('error', (err) => {
        this.ctx.logger.error('Watcher error, falling back to polling', err);
        this.healthy = false;
        this.lastError = err.message;
        this.startPolling();
      });

      this.ctx.logger.debug('fs.watch established', { path: this.config.path });
    } catch {
      // fs.watch not available (network drives, some containers) — use polling
      this.ctx.logger.info('fs.watch unavailable, using polling fallback');
      this.startPolling();
    }
  }

  private stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startPolling(): void {
    // Clear existing watcher first
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) return; // already polling

    this.pollTimer = setInterval(() => {
      this.onFileChange();
    }, this.config.pollIntervalMs);

    this.ctx.logger.debug('Polling started', {
      intervalMs: this.config.pollIntervalMs,
    });
  }

  private restartWatcher(): void {
    this.stopWatching();
    // Wait a bit for the file to be recreated (log rotation)
    setTimeout(() => {
      if (fs.existsSync(this.config.path)) {
        this.startWatching();
      } else {
        // File still doesn't exist — poll until it appears
        this.pollTimer = setInterval(() => {
          if (fs.existsSync(this.config.path)) {
            clearInterval(this.pollTimer!);
            this.pollTimer = null;
            this.startWatching();
          }
        }, this.config.pollIntervalMs);
      }
    }, 500);
  }

  // ── Reading New Lines ────────────────────────────────────────────────────

  private onFileChange(): void {
    // Guard against concurrent reads
    if (this.reading) return;
    this.readNewLines().catch((err) => {
      this.ctx.logger.error('Error reading new lines', err instanceof Error ? err : new Error(String(err)));
      this.healthy = false;
      this.lastError = err instanceof Error ? err.message : String(err);
    });
  }

  private async readNewLines(): Promise<void> {
    if (!fs.existsSync(this.config.path)) return;

    this.reading = true;

    try {
      const stat = fs.statSync(this.config.path);

      // Handle file truncation (log rotation)
      if (stat.size < this.byteOffset) {
        this.ctx.logger.info('File truncated (log rotation detected), resetting offset', {
          previousOffset: this.byteOffset,
          newSize: stat.size,
        });
        this.byteOffset = 0;
      }

      // No new data
      if (stat.size === this.byteOffset) return;

      // Read the new bytes
      const stream = fs.createReadStream(this.config.path, {
        start: this.byteOffset,
        encoding: this.config.encoding,
      });

      const rl = readline.createInterface({
        input: stream as Readable,
        crlfDelay: Infinity,
      });

      let bytesRead = 0;

      for await (const rawLine of rl) {
        // Track bytes (line + newline character)
        bytesRead += Buffer.byteLength(rawLine, this.config.encoding) + 1;

        // Truncate excessively long lines
        const line =
          rawLine.length > this.config.maxLineLength
            ? rawLine.slice(0, this.config.maxLineLength)
            : rawLine;

        // Skip empty lines
        if (line.trim().length === 0) continue;

        this.linesIngested++;

        const payload: LogIngestedPayload = {
          source: this.config.path,
          line,
          lineNumber: this.linesIngested,
          ingestedAt: new Date(),
          encoding: this.config.encoding,
        };

        const event: OpsPilotEvent<LogIngestedPayload> = {
          type: 'log.ingested',
          source: this.manifest.id,
          timestamp: new Date(),
          payload,
        };

        await this.ctx.bus.publish(event);
      }

      this.byteOffset += bytesRead;
      this.healthy = true;
      this.lastError = undefined;
    } finally {
      this.reading = false;
    }
  }
}
