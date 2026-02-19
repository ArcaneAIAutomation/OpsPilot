// ---------------------------------------------------------------------------
// OpsPilot — ApprovalGate & AuditLogger Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate } from '../src/core/security/ApprovalGate';
import { AuditLogger } from '../src/core/security/AuditLogger';
import { ApprovalStatus } from '../src/core/types/security';
import { createTestInfra, sleep } from './helpers';

describe('AuditLogger', () => {
  it('should log and query audit entries', async () => {
    const { audit } = createTestInfra();

    await audit.log({ action: 'test.action', actor: 'unit-test', target: 'something' });
    await audit.log({ action: 'test.action', actor: 'unit-test', target: 'else' });
    await audit.log({ action: 'other.action', actor: 'admin' });

    const all = await audit.query({});
    assert.strictEqual(all.length, 3);

    const filtered = await audit.query({ action: 'test.action' });
    assert.strictEqual(filtered.length, 2);

    const byActor = await audit.query({ actor: 'admin' });
    assert.strictEqual(byActor.length, 1);
    assert.strictEqual(byActor[0].action, 'other.action');
  });

  it('should assign unique IDs and timestamps', async () => {
    const { audit } = createTestInfra();

    await audit.log({ action: 'a', actor: 'test' });
    await audit.log({ action: 'b', actor: 'test' });

    const entries = await audit.query({});
    assert.notStrictEqual(entries[0].id, entries[1].id);
    assert.ok(entries[0].timestamp instanceof Date);
  });

  it('should respect limit filter', async () => {
    const { audit } = createTestInfra();

    for (let i = 0; i < 10; i++) {
      await audit.log({ action: 'bulk', actor: 'test' });
    }

    const limited = await audit.query({ limit: 3 });
    assert.strictEqual(limited.length, 3);
  });
});

describe('ApprovalGate', () => {
  let gate: ApprovalGate;

  beforeEach(() => {
    const infra = createTestInfra();
    gate = infra.approvalGate as ApprovalGate;
  });

  it('should create a pending approval request', async () => {
    const request = await gate.requestApproval({
      actionType: 'restart.service',
      description: 'Restart nginx',
      reasoning: 'Service is unresponsive',
      requestedBy: 'test-module',
    });

    assert.ok(request.id);
    assert.strictEqual(request.actionType, 'restart.service');
    assert.strictEqual(request.requestedBy, 'test-module');

    const status = await gate.getStatus(request.id);
    assert.strictEqual(status, ApprovalStatus.Pending);
  });

  it('should approve a request and create a token', async () => {
    const request = await gate.requestApproval({
      actionType: 'restart.service',
      description: 'Restart nginx',
      reasoning: 'Down',
      requestedBy: 'test',
    });

    const token = await gate.approve(request.id, 'admin');
    assert.ok(token.id);
    assert.strictEqual(token.requestId, request.id);
    assert.strictEqual(token.approvedBy, 'admin');
    assert.ok(token.expiresAt);

    const status = await gate.getStatus(request.id);
    assert.strictEqual(status, ApprovalStatus.Approved);
  });

  it('should validate a valid token', async () => {
    const request = await gate.requestApproval({
      actionType: 'test',
      description: 'test',
      reasoning: 'test',
      requestedBy: 'test',
    });
    const token = await gate.approve(request.id, 'admin');

    const valid = await gate.validateToken(token);
    assert.strictEqual(valid, true);
  });

  it('should reject a forged token', async () => {
    const valid = await gate.validateToken({
      id: 'fake-id',
      requestId: 'fake-request',
      approvedBy: 'hacker',
      approvedAt: new Date(),
    });
    assert.strictEqual(valid, false);
  });

  it('should deny a request', async () => {
    const request = await gate.requestApproval({
      actionType: 'test',
      description: 'test',
      reasoning: 'test',
      requestedBy: 'test',
    });

    await gate.deny(request.id, 'admin', 'Not appropriate');
    const status = await gate.getStatus(request.id);
    assert.strictEqual(status, ApprovalStatus.Denied);
  });

  it('should not approve an already denied request', async () => {
    const request = await gate.requestApproval({
      actionType: 'test',
      description: 'test',
      reasoning: 'test',
      requestedBy: 'test',
    });

    await gate.deny(request.id, 'admin', 'no');

    await assert.rejects(
      () => gate.approve(request.id, 'admin'),
      /Cannot approve/,
    );
  });

  it('should not deny an already approved request', async () => {
    const request = await gate.requestApproval({
      actionType: 'test',
      description: 'test',
      reasoning: 'test',
      requestedBy: 'test',
    });

    await gate.approve(request.id, 'admin');

    await assert.rejects(
      () => gate.deny(request.id, 'admin'),
      /Cannot deny/,
    );
  });

  it('should throw on non-existent request', async () => {
    await assert.rejects(
      () => gate.getStatus('nonexistent'),
      /not found/,
    );
  });
});
