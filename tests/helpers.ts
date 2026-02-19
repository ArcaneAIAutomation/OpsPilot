// ---------------------------------------------------------------------------
// OpsPilot — Test Helpers
// ---------------------------------------------------------------------------
// Shared utilities for unit and integration tests.
// ---------------------------------------------------------------------------

import { ILogger } from '../src/core/types/module';
import { EventBus } from '../src/core/bus/EventBus';
import { MemoryStorage } from '../src/core/storage/MemoryStorage';
import { AuditLogger } from '../src/core/security/AuditLogger';
import { ApprovalGate } from '../src/core/security/ApprovalGate';

/** A silent logger that swallows all output. */
export function createSilentLogger(): ILogger {
  const noop = () => {};
  const logger: ILogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

/** A logger that records all calls for assertions. */
export function createCapturingLogger(): ILogger & {
  entries: Array<{ level: string; message: string; context?: unknown }>;
} {
  const entries: Array<{ level: string; message: string; context?: unknown }> = [];
  const logger = {
    entries,
    debug(msg: string, ctx?: Record<string, unknown>) { entries.push({ level: 'debug', message: msg, context: ctx }); },
    info(msg: string, ctx?: Record<string, unknown>) { entries.push({ level: 'info', message: msg, context: ctx }); },
    warn(msg: string, ctx?: Record<string, unknown>) { entries.push({ level: 'warn', message: msg, context: ctx }); },
    error(msg: string, _err?: Error, ctx?: Record<string, unknown>) { entries.push({ level: 'error', message: msg, context: ctx }); },
    child() { return logger; },
  };
  return logger;
}

/** Create the standard test infrastructure bundle. */
export function createTestInfra() {
  const logger = createSilentLogger();
  const bus = new EventBus(logger);
  const storage = new MemoryStorage();
  const audit = new AuditLogger(storage, logger);
  const approvalGate = new ApprovalGate(storage, bus, audit, logger);

  return { logger, bus, storage, audit, approvalGate };
}

/** Sleep helper for async tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
