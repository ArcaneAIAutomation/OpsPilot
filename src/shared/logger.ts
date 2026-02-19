// ---------------------------------------------------------------------------
// OpsPilot — Structured Logger
// ---------------------------------------------------------------------------
// A minimal structured logger that prints JSON or human-readable lines.
// Modules receive a child logger prefixed with their module ID.
// ---------------------------------------------------------------------------

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
}

export class Logger implements ILogger {
  private readonly level: number;
  private readonly format: 'json' | 'text';
  private readonly prefix: string;

  constructor(options: LoggerOptions) {
    this.level = LOG_PRIORITY[options.level];
    this.format = options.format;
    this.prefix = options.prefix ?? '';
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
    return new Logger({
      level: this.levelName(),
      format: this.format,
      prefix: childPrefix,
    });
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
    const prefixedMessage = this.prefix ? `[${this.prefix}] ${message}` : message;

    if (this.format === 'json') {
      const entry: Record<string, unknown> = {
        timestamp,
        level,
        message: prefixedMessage,
      };
      if (context) entry.context = context;
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
      let line = `${timestamp} ${tag} ${prefixedMessage}`;
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
