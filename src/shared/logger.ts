// ---------------------------------------------------------------------------
// OpsPilot — Structured Logger
// ---------------------------------------------------------------------------
// A structured logger supporting JSON and human-readable output, with
// file output and size-based log rotation. Modules receive a child logger
// prefixed with their module ID.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { ILogger } from '../core/types/module';
import { LogLevel } from '../core/types/config';

const LOG_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerOptions {
  level: LogLevel;
  format: 'json' | 'text';
  prefix?: string;
  /** Output destination. Defaults to 'console'. */
  output?: 'console' | 'file';
  /** File path when output is 'file'. */
  filePath?: string;
  /** Max file size in bytes before rotation. Default: 10 MB. */
  maxFileSize?: number;
  /** Max number of rotated files to keep. Default: 5. */
  maxFiles?: number;
}

export class Logger implements ILogger {
  private readonly level: number;
  private readonly format: 'json' | 'text';
  private readonly prefix: string;
  private readonly output: 'console' | 'file';
  private readonly filePath: string | undefined;
  private readonly maxFileSize: number;
  private readonly maxFiles: number;

  /** File descriptor for the current log file (lazy-opened). */
  private fd: number | undefined;
  /** Current size of the log file in bytes. */
  private currentFileSize: number = 0;
  /** Whether file writing has failed (prevents cascading errors). */
  private fileError: boolean = false;

  constructor(options: LoggerOptions) {
    this.level = LOG_PRIORITY[options.level];
    this.format = options.format;
    this.prefix = options.prefix ?? '';
    this.output = options.output ?? 'console';
    this.filePath = options.filePath;
    this.maxFileSize = options.maxFileSize ?? 10 * 1024 * 1024; // 10 MB
    this.maxFiles = options.maxFiles ?? 5;

    if (this.output === 'file' && this.filePath) {
      this.openFile();
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.emit('debug', message, undefined, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.emit('info', message, undefined, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.emit('warn', message, undefined, context);
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.emit('error', message, error, context);
  }

  child(prefix: string): ILogger {
    const childPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
    // Children share the same file descriptor and rotation settings
    const child = new Logger({
      level: this.levelName(),
      format: this.format,
      prefix: childPrefix,
      output: this.output,
      filePath: this.filePath,
      maxFileSize: this.maxFileSize,
      maxFiles: this.maxFiles,
    });
    // Share file descriptor with parent so all output goes to the same file
    if (this.fd !== undefined) {
      child.fd = this.fd;
      child.currentFileSize = this.currentFileSize;
    }
    return child;
  }

  /**
   * Flush and close the log file. Call during graceful shutdown.
   */
  close(): void {
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Ignore close errors
      }
      this.fd = undefined;
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private levelName(): LogLevel {
    const entry = Object.entries(LOG_PRIORITY).find(([, v]) => v === this.level);
    return (entry?.[0] as LogLevel) ?? 'info';
  }

  private emit(
    level: LogLevel,
    message: string,
    error?: Error,
    context?: Record<string, unknown>,
  ): void {
    if (LOG_PRIORITY[level] < this.level) return;

    const timestamp = new Date().toISOString();

    if (this.format === 'json') {
      const entry: Record<string, unknown> = {
        timestamp,
        level,
      };
      // Separate module field from message for structured filtering
      if (this.prefix) {
        entry.module = this.prefix;
      }
      entry.message = message;
      if (context && Object.keys(context).length > 0) entry.context = context;
      if (error) {
        entry.error = {
          name: error.name,
          message: error.message,
          stack: error.stack,
        };
      }
      this.write(level, JSON.stringify(entry));
    } else {
      const tag = level.toUpperCase().padEnd(5);
      const modulePart = this.prefix ? `[${this.prefix}] ` : '';
      let line = `${timestamp} ${tag} ${modulePart}${message}`;
      if (context && Object.keys(context).length > 0) {
        line += ` ${JSON.stringify(context)}`;
      }
      if (error) {
        line += `\n  Error: ${error.message}`;
        if (error.stack) line += `\n  ${error.stack}`;
      }
      this.write(level, line);
    }
  }

  private write(level: LogLevel, line: string): void {
    if (this.output === 'file' && this.filePath && !this.fileError) {
      this.writeToFile(line + '\n');
    } else {
      switch (level) {
        case 'error':
          console.error(line);
          break;
        case 'warn':
          console.warn(line);
          break;
        default:
          console.log(line);
      }
    }
  }

  // ── File Output & Rotation ─────────────────────────────────────────────

  private openFile(): void {
    try {
      const dir = path.dirname(this.filePath!);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.fd = fs.openSync(this.filePath!, 'a');
      try {
        const stat = fs.fstatSync(this.fd);
        this.currentFileSize = stat.size;
      } catch {
        this.currentFileSize = 0;
      }
    } catch (err) {
      this.fileError = true;
      console.error(`[Logger] Failed to open log file "${this.filePath}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private writeToFile(data: string): void {
    if (this.fd === undefined) {
      this.openFile();
      if (this.fd === undefined) return;
    }

    const bytes = Buffer.byteLength(data, 'utf-8');

    // Check if rotation is needed before writing
    if (this.currentFileSize + bytes > this.maxFileSize) {
      this.rotate();
    }

    try {
      fs.writeSync(this.fd!, data);
      this.currentFileSize += bytes;
    } catch (err) {
      this.fileError = true;
      console.error(`[Logger] Failed to write to log file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Size-based log rotation.
   *
   * Rotates files: app.log → app.log.1 → app.log.2 → ... → app.log.N
   * The oldest file beyond maxFiles is deleted.
   */
  private rotate(): void {
    const filePath = this.filePath!;

    // Close current file
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = undefined;
    }

    // Delete the oldest rotated file if it exceeds maxFiles
    const oldest = `${filePath}.${this.maxFiles}`;
    try { if (fs.existsSync(oldest)) fs.unlinkSync(oldest); } catch { /* ignore */ }

    // Shift existing rotated files: .4 → .5, .3 → .4, etc.
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch { /* ignore */ }
    }

    // Move current log file to .1
    try { if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`); } catch { /* ignore */ }

    // Open a fresh file
    this.currentFileSize = 0;
    this.openFile();
  }
}