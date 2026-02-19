// ---------------------------------------------------------------------------
// OpsPilot — ToolRegistry Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/core/openclaw/ToolRegistry';
import { OpenClawTool, ToolInvocation } from '../src/core/types/openclaw';
import { createTestInfra } from './helpers';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    const { approvalGate, audit, logger } = createTestInfra();
    registry = new ToolRegistry(approvalGate, audit, logger);
  });

  function readTool(): OpenClawTool {
    return {
      name: 'test.read',
      description: 'A read-only tool',
      registeredBy: 'test-module',
      requiresApproval: false,
      tags: ['read'],
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        additionalProperties: false,
      },
    };
  }

  function writeTool(): OpenClawTool {
    return {
      name: 'test.write',
      description: 'A write tool',
      registeredBy: 'test-module',
      requiresApproval: true,
      tags: ['write'],
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
        additionalProperties: false,
      },
    };
  }

  // ── Registration ─────────────────────────────────────────────────────

  it('should register and retrieve a tool', () => {
    registry.register(readTool(), async () => ({ success: true }));
    const tool = registry.getTool('test.read');
    assert.ok(tool);
    assert.strictEqual(tool.name, 'test.read');
  });

  it('should throw on duplicate registration', () => {
    registry.register(readTool(), async () => ({ success: true }));
    assert.throws(
      () => registry.register(readTool(), async () => ({ success: true })),
      /already registered/,
    );
  });

  it('should unregister a tool', () => {
    registry.register(readTool(), async () => ({ success: true }));
    const removed = registry.unregister('test.read');
    assert.strictEqual(removed, true);
    assert.strictEqual(registry.getTool('test.read'), undefined);
  });

  it('should return false when unregistering unknown tool', () => {
    assert.strictEqual(registry.unregister('nope'), false);
  });

  // ── Listing ──────────────────────────────────────────────────────────

  it('should list all tools', () => {
    registry.register(readTool(), async () => ({ success: true }));
    registry.register(writeTool(), async () => ({ success: true }));
    const tools = registry.listTools();
    assert.strictEqual(tools.length, 2);
  });

  it('should filter by tag', () => {
    registry.register(readTool(), async () => ({ success: true }));
    registry.register(writeTool(), async () => ({ success: true }));
    const readOnly = registry.listTools({ tag: 'read' });
    assert.strictEqual(readOnly.length, 1);
    assert.strictEqual(readOnly[0].name, 'test.read');
  });

  it('should filter by requiresApproval', () => {
    registry.register(readTool(), async () => ({ success: true }));
    registry.register(writeTool(), async () => ({ success: true }));
    const needsApproval = registry.listTools({ requiresApproval: true });
    assert.strictEqual(needsApproval.length, 1);
    assert.strictEqual(needsApproval[0].name, 'test.write');
  });

  // ── Invocation ───────────────────────────────────────────────────────

  it('should invoke a read-only tool successfully', async () => {
    registry.register(readTool(), async (inv) => ({
      success: true,
      data: `queried: ${inv.params.query}`,
    }));

    const result = await registry.invoke({
      toolName: 'test.read',
      params: { query: 'hello' },
      invokedBy: 'tester',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data, 'queried: hello');
  });

  it('should fail on unknown tool', async () => {
    const result = await registry.invoke({
      toolName: 'nope',
      params: {},
      invokedBy: 'tester',
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Unknown tool'));
  });

  it('should reject invalid input', async () => {
    registry.register(writeTool(), async () => ({ success: true }));

    const result = await registry.invoke({
      toolName: 'test.write',
      params: {},  // missing required 'target'
      invokedBy: 'tester',
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Invalid input'));
  });

  it('should reject write tool without approval token', async () => {
    registry.register(writeTool(), async () => ({ success: true }));

    const result = await registry.invoke({
      toolName: 'test.write',
      params: { target: 'something' },
      invokedBy: 'tester',
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('approval token'));
  });

  it('should reject write tool with invalid token', async () => {
    registry.register(writeTool(), async () => ({ success: true }));

    const result = await registry.invoke({
      toolName: 'test.write',
      params: { target: 'something' },
      invokedBy: 'tester',
      approvalToken: {
        id: 'fake',
        requestId: 'fake',
        approvedBy: 'hacker',
        approvedAt: new Date(),
      },
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('invalid or expired'));
  });

  it('should execute write tool with valid approval token', async () => {
    const { approvalGate, audit, logger } = createTestInfra();
    const reg = new ToolRegistry(approvalGate, audit, logger);

    reg.register(writeTool(), async () => ({ success: true, data: 'done' }));

    // Create and approve a request to get a valid token
    const request = await approvalGate.requestApproval({
      actionType: 'test.write',
      description: 'Write test',
      reasoning: 'Testing',
      requestedBy: 'tester',
    });
    const token = await approvalGate.approve(request.id, 'admin');

    const result = await reg.invoke({
      toolName: 'test.write',
      params: { target: 'something' },
      invokedBy: 'tester',
      approvalToken: token,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data, 'done');
  });

  it('should handle handler errors gracefully', async () => {
    registry.register(readTool(), async () => { throw new Error('handler crash'); });

    const result = await registry.invoke({
      toolName: 'test.read',
      params: {},
      invokedBy: 'tester',
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('handler crash'));
  });
});
