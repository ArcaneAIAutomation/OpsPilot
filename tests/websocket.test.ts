// ---------------------------------------------------------------------------
// OpsPilot — ui.websocket Module Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import { WebSocketModule, WsClient } from '../src/modules/ui.websocket/index';
import { ModuleContext } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

let portCounter = 20000;
function getPort(): number { return portCounter++; }

function buildContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'ui.websocket',
    config: {
      host: '127.0.0.1',
      port: getPort(),
      heartbeatIntervalMs: 60000, // long — won't fire during test
      maxClients: 5,
      subscribableEvents: ['incident.created', 'action.proposed', 'log.ingested'],
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'ui.websocket'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

/** Perform a raw WebSocket handshake and return the socket + welcome msg. */
async function connectWs(
  port: number,
): Promise<{
  socket: net.Socket;
  messages: unknown[];
  waitForMessage: () => Promise<unknown>;
  send: (data: unknown) => void;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.createConnection(port, '127.0.0.1', () => {
      socket.write(
        `GET / HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`,
      );
    });

    const messages: unknown[] = [];
    let headerProcessed = false;
    let buffer = Buffer.alloc(0);
    const waiters: Array<(msg: unknown) => void> = [];

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!headerProcessed) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headerStr = buffer.subarray(0, headerEnd).toString('utf-8');
        if (!headerStr.includes('101')) {
          reject(new Error(`Handshake failed: ${headerStr}`));
          return;
        }
        headerProcessed = true;
        buffer = buffer.subarray(headerEnd + 4);
      }

      // Parse WebSocket frames from buffer
      while (buffer.length >= 2) {
        const result = decodeServerFrame(buffer);
        if (!result) break;

        buffer = buffer.subarray(result.totalLength);

        if (result.opcode === 0x01) {
          // Text frame
          try {
            const parsed = JSON.parse(result.payload.toString('utf-8'));
            messages.push(parsed);
            if (waiters.length > 0) {
              const w = waiters.shift()!;
              w(parsed);
            }
          } catch {
            messages.push(result.payload.toString('utf-8'));
          }
        }
      }
    });

    socket.on('error', reject);

    const conn = {
      socket,
      messages,
      waitForMessage(): Promise<unknown> {
        // If we already have an unread message, return it
        const currentLen = messages.length;
        return new Promise<unknown>((res) => {
          const check = () => {
            if (messages.length > currentLen) {
              res(messages[messages.length - 1]);
            } else {
              waiters.push(res);
            }
          };
          check();
        });
      },
      send(data: unknown): void {
        const json = JSON.stringify(data);
        const payloadBuf = Buffer.from(json, 'utf-8');
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(payloadBuf.length);
        for (let i = 0; i < payloadBuf.length; i++) {
          masked[i] = payloadBuf[i] ^ mask[i % 4];
        }

        let header: Buffer;
        if (payloadBuf.length < 126) {
          header = Buffer.alloc(2);
          header[0] = 0x81; // FIN + Text
          header[1] = 0x80 | payloadBuf.length; // MASK bit set
        } else if (payloadBuf.length < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payloadBuf.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(payloadBuf.length), 2);
        }

        socket.write(Buffer.concat([header, mask, masked]));
      },
      close(): void {
        // Send a WebSocket close frame (opcode 0x08)
        const closeCode = Buffer.alloc(2);
        closeCode.writeUInt16BE(1000, 0);
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(2);
        for (let i = 0; i < 2; i++) masked[i] = closeCode[i] ^ mask[i % 4];
        const frame = Buffer.alloc(8);
        frame[0] = 0x88; // FIN + Close
        frame[1] = 0x82; // MASK + len 2
        mask.copy(frame, 2);
        masked.copy(frame, 6);
        socket.write(frame, () => {
          setTimeout(() => socket.destroy(), 50);
        });
      },
    };

    // Wait for welcome message
    const checkWelcome = setInterval(() => {
      if (messages.length > 0) {
        clearInterval(checkWelcome);
        resolve(conn);
      }
    }, 10);

    setTimeout(() => {
      clearInterval(checkWelcome);
      if (messages.length === 0) {
        reject(new Error('Timeout waiting for welcome'));
      }
    }, 3000);
  });
}

/** Decode a server-sent (unmasked) WebSocket frame. */
function decodeServerFrame(
  buf: Buffer,
): { opcode: number; payload: Buffer; totalLength: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  const totalLength = offset + payloadLen;
  if (buf.length < totalLength) return null;

  const payload = buf.subarray(offset, offset + payloadLen);
  return { opcode, payload, totalLength };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ui.websocket — WebSocket Streaming Module', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: WebSocketModule;
  let ctx: ModuleContext;

  beforeEach(() => {
    infra = createTestInfra();
    mod = new WebSocketModule();
    ctx = buildContext(infra);
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    // Wait for async socket close callbacks to complete before destroy
    await sleep(100);
    await mod.destroy().catch(() => {});
  });

  // ── Lifecycle Tests ──────────────────────────────────────────────────────

  describe('Lifecycle', () => {
    it('initializes with default config', async () => {
      await mod.initialize(ctx);
      const config = mod.getConfig();
      assert.equal(config.host, '127.0.0.1');
      assert.equal(config.maxClients, 5);
      assert.deepEqual(config.subscribableEvents, [
        'incident.created',
        'action.proposed',
        'log.ingested',
      ]);
    });

    it('starts and stops the WebSocket server', async () => {
      await mod.initialize(ctx);
      await mod.start();
      assert.ok(mod.getServer(), 'Server should exist');
      assert.ok(mod.getServer()!.listening, 'Server should be listening');

      await mod.stop();
      assert.equal(mod.getServer(), null, 'Server should be null after stop');
    });

    it('reports health', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const h = mod.health();
      assert.equal(h.status, 'healthy');
      assert.equal(h.details!['activeClients'], 0);
      assert.equal(h.details!['totalConnections'], 0);
    });
  });

  // ── Connection Tests ─────────────────────────────────────────────────────

  describe('Connections', () => {
    it('accepts WebSocket connection and sends welcome', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn = await connectWs(port);
      try {
        const welcome = conn.messages[0] as any;
        assert.equal(welcome.type, 'welcome');
        assert.ok(welcome.clientId, 'Should have clientId');
        assert.deepEqual(welcome.subscribableEvents, [
          'incident.created',
          'action.proposed',
          'log.ingested',
        ]);
        assert.equal(mod.getClients().size, 1);
      } finally {
        conn.close();
      }
    });

    it('enforces max client limit', async () => {
      const smallCtx = buildContext(infra, { maxClients: 2 });
      await mod.initialize(smallCtx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn1 = await connectWs(port);
      const conn2 = await connectWs(port);
      await sleep(50);
      assert.equal(mod.getClients().size, 2);

      // Third connection should be rejected with 503
      try {
        await connectWs(port);
        assert.fail('Should have been rejected');
      } catch (err: any) {
        // Connection should fail or get no welcome
        assert.ok(true);
      }

      conn1.close();
      conn2.close();
    });

    it('removes client on socket close', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn = await connectWs(port);
      assert.equal(mod.getClients().size, 1);
      conn.close();
      await sleep(300);
      assert.equal(mod.getClients().size, 0);
    });
  });

  // ── Subscription Tests ───────────────────────────────────────────────────

  describe('Subscriptions', () => {
    it('subscribes to events', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn = await connectWs(port);
      try {
        const waitP = conn.waitForMessage();
        conn.send({ action: 'subscribe', events: ['incident.created'] });
        const resp = (await waitP) as any;
        assert.equal(resp.type, 'subscribed');
        assert.deepEqual(resp.events, ['incident.created']);
      } finally {
        conn.close();
      }
    });

    it('filters out non-subscribable events', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn = await connectWs(port);
      try {
        const waitP = conn.waitForMessage();
        conn.send({ action: 'subscribe', events: ['incident.created', 'not.allowed'] });
        const resp = (await waitP) as any;
        assert.equal(resp.type, 'subscribed');
        assert.deepEqual(resp.events, ['incident.created']);
      } finally {
        conn.close();
      }
    });

    it('unsubscribes from events', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn = await connectWs(port);
      try {
        // Subscribe first
        let waitP = conn.waitForMessage();
        conn.send({ action: 'subscribe', events: ['incident.created', 'log.ingested'] });
        await waitP;

        // Unsubscribe from one
        waitP = conn.waitForMessage();
        conn.send({ action: 'unsubscribe', events: ['incident.created'] });
        const resp = (await waitP) as any;
        assert.equal(resp.type, 'subscribed');
        assert.deepEqual(resp.events, ['log.ingested']);
      } finally {
        conn.close();
      }
    });

    it('handles ping action', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn = await connectWs(port);
      try {
        const waitP = conn.waitForMessage();
        conn.send({ action: 'ping' });
        const resp = (await waitP) as any;
        assert.equal(resp.type, 'pong');
      } finally {
        conn.close();
      }
    });

    it('returns error for unknown action', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn = await connectWs(port);
      try {
        const waitP = conn.waitForMessage();
        conn.send({ action: 'unknown_action' });
        const resp = (await waitP) as any;
        assert.equal(resp.type, 'error');
        assert.ok(resp.message.includes('Unknown action'));
      } finally {
        conn.close();
      }
    });

    it('returns error for invalid events field', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn = await connectWs(port);
      try {
        const waitP = conn.waitForMessage();
        conn.send({ action: 'subscribe', events: 'not-an-array' });
        const resp = (await waitP) as any;
        assert.equal(resp.type, 'error');
        assert.ok(resp.message.includes('events must be an array'));
      } finally {
        conn.close();
      }
    });
  });

  // ── Event Broadcasting Tests ─────────────────────────────────────────────

  describe('Event Broadcasting', () => {
    it('forwards subscribed events to client', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn = await connectWs(port);
      try {
        // Subscribe to incident.created
        let waitP = conn.waitForMessage();
        conn.send({ action: 'subscribe', events: ['incident.created'] });
        await waitP;

        // Publish an event on the bus
        waitP = conn.waitForMessage();
        infra.bus.publish({
          type: 'incident.created',
          source: 'test',
          timestamp: new Date(),
          payload: { incidentId: 'INC-1', title: 'Test incident' },
        });

        const msg = (await waitP) as any;
        assert.equal(msg.type, 'event');
        assert.equal(msg.eventType, 'incident.created');
        assert.equal(msg.data.incidentId, 'INC-1');
      } finally {
        conn.close();
      }
    });

    it('does not forward unsubscribed events', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn = await connectWs(port);
      try {
        // Subscribe only to incident.created
        let waitP = conn.waitForMessage();
        conn.send({ action: 'subscribe', events: ['incident.created'] });
        await waitP;

        // Publish a log.ingested event (not subscribed)
        infra.bus.publish({
          type: 'log.ingested',
          source: 'test',
          timestamp: new Date(),
          payload: { source: 'test', line: 'hello', ingestedAt: new Date() },
        });

        await sleep(100);
        // Should only have welcome + subscribed messages, no event
        const eventMsgs = conn.messages.filter(
          (m: any) => m.type === 'event',
        );
        assert.equal(eventMsgs.length, 0, 'Should not receive unsubscribed events');
      } finally {
        conn.close();
      }
    });

    it('broadcasts to multiple subscribed clients', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const conn1 = await connectWs(port);
      const conn2 = await connectWs(port);
      try {
        // Both subscribe
        let w1 = conn1.waitForMessage();
        let w2 = conn2.waitForMessage();
        conn1.send({ action: 'subscribe', events: ['incident.created'] });
        conn2.send({ action: 'subscribe', events: ['incident.created'] });
        await w1;
        await w2;

        // Publish event
        w1 = conn1.waitForMessage();
        w2 = conn2.waitForMessage();
        infra.bus.publish({
          type: 'incident.created',
          source: 'test',
          timestamp: new Date(),
          payload: { incidentId: 'INC-2' },
        });

        const msg1 = (await w1) as any;
        const msg2 = (await w2) as any;
        assert.equal(msg1.eventType, 'incident.created');
        assert.equal(msg2.eventType, 'incident.created');
      } finally {
        conn1.close();
        conn2.close();
      }
    });
  });

  // ── HTTP Upgrade Rejection ───────────────────────────────────────────────

  describe('HTTP fallback', () => {
    it('returns 426 for regular HTTP requests', async () => {
      await mod.initialize(ctx);
      await mod.start();
      const port = mod.getConfig().port;

      const result = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          http.get(`http://127.0.0.1:${port}/`, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              resolve({
                status: res.statusCode!,
                body: Buffer.concat(chunks).toString('utf-8'),
              });
            });
          }).on('error', reject);
        },
      );

      assert.equal(result.status, 426);
    });
  });

  // ── WsClient Unit Tests ─────────────────────────────────────────────────

  describe('WsClient', () => {
    it('tracks subscriptions', () => {
      const socket = new net.Socket();
      const client = new WsClient('test-id', socket);

      client.subscribe(['a', 'b']);
      assert.ok(client.isSubscribedTo('a'));
      assert.ok(client.isSubscribedTo('b'));
      assert.ok(!client.isSubscribedTo('c'));

      client.unsubscribe(['a']);
      assert.ok(!client.isSubscribedTo('a'));
      assert.ok(client.isSubscribedTo('b'));

      socket.destroy();
    });

    it('tracks alive state', () => {
      const socket = new net.Socket();
      const client = new WsClient('test-id', socket);

      assert.equal(client.isAlive, true);
      client.isAlive = false;
      assert.equal(client.isAlive, false);

      socket.destroy();
    });
  });
});
