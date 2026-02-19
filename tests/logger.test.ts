// ---------------------------------------------------------------------------
// OpsPilot — Structured Logger Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger, LoggerOptions } from '../src/shared/logger';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opspilot-logger-test-'));
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

function captureConsole(): { logs: string[]; errors: string[]; warns: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
  return { logs, errors, warns, restore: () => { console.log = origLog; console.error = origError; console.warn = origWarn; } };
}

// ── Console Output Tests ───────────────────────────────────────────────────

describe('Logger — Console Output', () => {

  it('should output text format to console', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'text' });
      logger.info('hello world');
      assert.equal(cap.logs.length, 1);
      assert.ok(cap.logs[0].includes('INFO'));
      assert.ok(cap.logs[0].includes('hello world'));
    } finally {
      cap.restore();
    }
  });

  it('should output JSON format to console', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'json' });
      logger.info('test message');
      assert.equal(cap.logs.length, 1);
      const entry = JSON.parse(cap.logs[0]);
      assert.equal(entry.level, 'info');
      assert.equal(entry.message, 'test message');
      assert.ok(entry.timestamp);
    } finally {
      cap.restore();
    }
  });

  it('should respect log level filtering', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'warn', format: 'text' });
      logger.debug('nope');
      logger.info('nope');
      logger.warn('yes-warn');
      logger.error('yes-error');
      assert.equal(cap.warns.length, 1);
      assert.equal(cap.errors.length, 1);
      assert.equal(cap.logs.length, 0);
    } finally {
      cap.restore();
    }
  });

  it('should route error level to console.error', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'text' });
      logger.error('bad thing', new Error('boom'));
      assert.equal(cap.errors.length, 1);
      assert.ok(cap.errors[0].includes('bad thing'));
      assert.ok(cap.errors[0].includes('boom'));
    } finally {
      cap.restore();
    }
  });

  it('should route warn level to console.warn', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'text' });
      logger.warn('caution');
      assert.equal(cap.warns.length, 1);
      assert.ok(cap.warns[0].includes('caution'));
    } finally {
      cap.restore();
    }
  });

  it('should include context in text format', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'text' });
      logger.info('start', { port: 3000 });
      assert.ok(cap.logs[0].includes('"port":3000'));
    } finally {
      cap.restore();
    }
  });

  it('should include context in JSON format', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'json' });
      logger.info('start', { port: 3000 });
      const entry = JSON.parse(cap.logs[0]);
      assert.deepEqual(entry.context, { port: 3000 });
    } finally {
      cap.restore();
    }
  });

  it('should not include empty context', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'json' });
      logger.info('clean');
      const entry = JSON.parse(cap.logs[0]);
      assert.equal(entry.context, undefined);
    } finally {
      cap.restore();
    }
  });
});

// ── JSON Structured Format ─────────────────────────────────────────────────

describe('Logger — JSON Structured Format', () => {

  it('should separate module from message in JSON', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'json', prefix: 'ui.api' });
      logger.info('request received');
      const entry = JSON.parse(cap.logs[0]);
      assert.equal(entry.module, 'ui.api');
      assert.equal(entry.message, 'request received');
    } finally {
      cap.restore();
    }
  });

  it('should omit module field when no prefix', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'json' });
      logger.info('no module');
      const entry = JSON.parse(cap.logs[0]);
      assert.equal(entry.module, undefined);
      assert.equal(entry.message, 'no module');
    } finally {
      cap.restore();
    }
  });

  it('should include error details in JSON', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'json' });
      const err = new Error('oops');
      logger.error('failed', err, { retries: 3 });
      const entry = JSON.parse(cap.errors[0]);
      assert.equal(entry.level, 'error');
      assert.equal(entry.error.name, 'Error');
      assert.equal(entry.error.message, 'oops');
      assert.ok(entry.error.stack);
      assert.deepEqual(entry.context, { retries: 3 });
    } finally {
      cap.restore();
    }
  });

  it('should produce valid JSON for every level', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'json' });
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      for (const line of [...cap.logs, ...cap.warns, ...cap.errors]) {
        const parsed = JSON.parse(line);
        assert.ok(parsed.timestamp);
        assert.ok(parsed.level);
        assert.ok(parsed.message);
      }
    } finally {
      cap.restore();
    }
  });
});

// ── Child Logger ───────────────────────────────────────────────────────────

describe('Logger — Child Logger', () => {

  it('should create child with combined prefix', () => {
    const cap = captureConsole();
    try {
      const parent = new Logger({ level: 'debug', format: 'json', prefix: 'core' });
      const child = parent.child('bus');
      child.info('event fired');
      const entry = JSON.parse(cap.logs[0]);
      assert.equal(entry.module, 'core:bus');
    } finally {
      cap.restore();
    }
  });

  it('should inherit format and level from parent', () => {
    const cap = captureConsole();
    try {
      const parent = new Logger({ level: 'warn', format: 'json' });
      const child = parent.child('mod');
      child.debug('no');
      child.info('no');
      child.warn('yes');
      assert.equal(cap.logs.length, 0);
      assert.equal(cap.warns.length, 1);
    } finally {
      cap.restore();
    }
  });

  it('should work with no parent prefix', () => {
    const cap = captureConsole();
    try {
      const parent = new Logger({ level: 'debug', format: 'json' });
      const child = parent.child('standalone');
      child.info('msg');
      const entry = JSON.parse(cap.logs[0]);
      assert.equal(entry.module, 'standalone');
    } finally {
      cap.restore();
    }
  });
});

// ── File Output ────────────────────────────────────────────────────────────

describe('Logger — File Output', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('should write text logs to a file', () => {
    const logFile = path.join(tmpDir, 'app.log');
    const logger = new Logger({ level: 'debug', format: 'text', output: 'file', filePath: logFile });
    logger.info('line one');
    logger.warn('line two');
    logger.close();

    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('INFO'));
    assert.ok(lines[0].includes('line one'));
    assert.ok(lines[1].includes('WARN'));
  });

  it('should write JSON logs to a file', () => {
    const logFile = path.join(tmpDir, 'app.log');
    const logger = new Logger({ level: 'debug', format: 'json', output: 'file', filePath: logFile });
    logger.info('json line', { key: 'val' });
    logger.close();

    const content = fs.readFileSync(logFile, 'utf-8');
    const entry = JSON.parse(content.trim());
    assert.equal(entry.level, 'info');
    assert.equal(entry.message, 'json line');
    assert.deepEqual(entry.context, { key: 'val' });
  });

  it('should create parent directories for log file', () => {
    const logFile = path.join(tmpDir, 'nested', 'deep', 'app.log');
    const logger = new Logger({ level: 'debug', format: 'text', output: 'file', filePath: logFile });
    logger.info('created dirs');
    logger.close();

    assert.ok(fs.existsSync(logFile));
  });

  it('should append to existing log file', () => {
    const logFile = path.join(tmpDir, 'app.log');
    fs.writeFileSync(logFile, 'existing\n');

    const logger = new Logger({ level: 'debug', format: 'text', output: 'file', filePath: logFile });
    logger.info('appended');
    logger.close();

    const content = fs.readFileSync(logFile, 'utf-8');
    assert.ok(content.startsWith('existing\n'));
    assert.ok(content.includes('appended'));
  });

  it('should filter by log level in file output', () => {
    const logFile = path.join(tmpDir, 'app.log');
    const logger = new Logger({ level: 'error', format: 'text', output: 'file', filePath: logFile });
    logger.debug('no');
    logger.info('no');
    logger.warn('no');
    logger.error('yes');
    logger.close();

    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('ERROR'));
  });
});

// ── Log Rotation ───────────────────────────────────────────────────────────

describe('Logger — Log Rotation', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('should rotate when file exceeds maxFileSize', () => {
    const logFile = path.join(tmpDir, 'app.log');
    // Very small max size to trigger rotation
    const logger = new Logger({
      level: 'debug',
      format: 'text',
      output: 'file',
      filePath: logFile,
      maxFileSize: 100,
      maxFiles: 3,
    });

    // Write enough data to trigger rotation
    for (let i = 0; i < 10; i++) {
      logger.info(`Log line number ${i} with some padding data to exceed 100 bytes limit`);
    }
    logger.close();

    // Current log file should exist
    assert.ok(fs.existsSync(logFile));
    // At least one rotated file should exist
    assert.ok(fs.existsSync(`${logFile}.1`));
  });

  it('should respect maxFiles limit', () => {
    const logFile = path.join(tmpDir, 'app.log');
    const logger = new Logger({
      level: 'debug',
      format: 'text',
      output: 'file',
      filePath: logFile,
      maxFileSize: 50,
      maxFiles: 2,
    });

    // Write enough to trigger multiple rotations
    for (let i = 0; i < 30; i++) {
      logger.info(`Line ${i} with extra padding to fill up the buffer quickly`);
    }
    logger.close();

    assert.ok(fs.existsSync(logFile));
    assert.ok(fs.existsSync(`${logFile}.1`));
    assert.ok(fs.existsSync(`${logFile}.2`));
    // .3 should NOT exist (maxFiles = 2)
    assert.ok(!fs.existsSync(`${logFile}.3`));
  });

  it('should preserve older rotated files during rotation', () => {
    const logFile = path.join(tmpDir, 'app.log');
    const logger = new Logger({
      level: 'debug',
      format: 'text',
      output: 'file',
      filePath: logFile,
      maxFileSize: 80,
      maxFiles: 5,
    });

    // Write enough to trigger at least 2 rotations
    for (let i = 0; i < 20; i++) {
      logger.info(`Rotation test line ${i} with padding data for size testing purposes`);
    }
    logger.close();

    // Verify .1 file exists (most recently rotated)
    assert.ok(fs.existsSync(`${logFile}.1`));
    // .1 should have content
    const rotated = fs.readFileSync(`${logFile}.1`, 'utf-8');
    assert.ok(rotated.length > 0);
  });

  it('should handle close() gracefully when no file is open', () => {
    const logger = new Logger({ level: 'debug', format: 'text' });
    // Should not throw
    logger.close();
  });

  it('should handle close() being called multiple times', () => {
    const logFile = path.join(tmpDir, 'app.log');
    const logger = new Logger({ level: 'debug', format: 'text', output: 'file', filePath: logFile });
    logger.info('data');
    logger.close();
    logger.close(); // Should not throw
  });
});

// ── Text Format Details ────────────────────────────────────────────────────

describe('Logger — Text Format Details', () => {

  it('should include prefix in brackets for text format', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'text', prefix: 'MyModule' });
      logger.info('hello');
      assert.ok(cap.logs[0].includes('[MyModule]'));
      assert.ok(cap.logs[0].includes('hello'));
    } finally {
      cap.restore();
    }
  });

  it('should include ISO timestamp in text format', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'text' });
      logger.info('time check');
      // ISO 8601 pattern: YYYY-MM-DDTHH:MM:SS
      assert.ok(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(cap.logs[0]));
    } finally {
      cap.restore();
    }
  });

  it('should include error stack in text format', () => {
    const cap = captureConsole();
    try {
      const logger = new Logger({ level: 'debug', format: 'text' });
      const err = new Error('stack trace test');
      logger.error('failure', err);
      assert.ok(cap.errors[0].includes('stack trace test'));
      assert.ok(cap.errors[0].includes('Error:'));
    } finally {
      cap.restore();
    }
  });
});
