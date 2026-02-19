// ---------------------------------------------------------------------------
// OpsPilot — ui.websocket (WebSocket Real-Time Streaming Module)
// ---------------------------------------------------------------------------
// Provides real-time event streaming to dashboards and external tools via
// WebSocket protocol. Built on Node.js built-in modules — zero dependencies.
//
// Protocol:
//   Client → Server messages (JSON):
//     { "action": "subscribe",   "events": ["incident.created", ...] }
//     { "action": "unsubscribe", "events": ["incident.created", ...] }
//     { "action": "ping" }
//
//   Server → Client messages (JSON):
//     { "type": "event",      "eventType": "incident.created", "data": {...} }
//     { "type": "subscribed", "events": [...] }
//     { "type": "pong" }
//     { "type": "error",      "message": "..." }
//     { "type": "welcome",    "subscribableEvents": [...], "clientId": "..." }
//
// WebSocket handshake is done manually using Node.js http + crypto.
// This avoids any external dependency like `ws`.
// ---------------------------------------------------------------------------

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { EventSubscription, OpsPilotEvent } from '../../core/types/events';
import configSchema from './schema.json';

// ── Types ──────────────────────────────────────────────────────────────────

interface WebSocketConfig {
  port: number;
  host: string;
  heartbeatIntervalMs: number;
  maxClients: number;
  subscribableEvents: string[];
}

/** Minimal WebSocket frame opcodes */
const enum WsOpcode {
  Text = 0x01,
  Close = 0x08,
  Ping = 0x09,
  Pong = 0x0a,
}

// ── WebSocket Client ───────────────────────────────────────────────────────

export class WsClient {
  readonly id: string;
  private readonly socket: import('node:net').Socket;
  private subscribedEvents = new Set<string>();
  private alive = true;

  constructor(id: string, socket: import('node:net').Socket) {
    this.id = id;
    this.socket = socket;
  }

  get isAlive(): boolean { return this.alive; }
  set isAlive(v: boolean) { this.alive = v; }

  get subscriptions(): ReadonlySet<string> { return this.subscribedEvents; }

  subscribe(events: string[]): void {
    for (const e of events) this.subscribedEvents.add(e);
  }

  unsubscribe(events: string[]): void {
    for (const e of events) this.subscribedEvents.delete(e);
  }

  isSubscribedTo(eventType: string): boolean {
    return this.subscribedEvents.has(eventType);
  }

  send(data: unknown): void {
    if (this.socket.writable) {
      const json = JSON.stringify(data);
      const frame = encodeFrame(json, WsOpcode.Text);
      this.socket.write(frame);
    }
  }

  sendPing(): void {
    if (this.socket.writable) {
      this.socket.write(encodeFrame('', WsOpcode.Ping));
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.socket.writable) {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      if (reason) payload.write(reason, 2);
      this.socket.write(encodeFrame(payload, WsOpcode.Close));
      this.socket.end();
    }
  }

  destroy(): void {
    this.socket.destroy();
  }

  onData(handler: (opcode: number, payload: Buffer) => void): void {
    let buffer = Buffer.alloc(0);

    this.socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Parse frames from buffer
      while (buffer.length >= 2) {
        const result = decodeFrame(buffer);
        if (!result) break; // incomplete frame

        buffer = buffer.subarray(result.totalLength);
        handler(result.opcode, result.payload);
      }
    });
  }

  onClose(handler: () => void): void {
    let called = false;
    const once = () => {
      if (!called) {
        called = true;
        handler();
      }
    };
    this.socket.on('close', once);
    this.socket.on('end', once);
    this.socket.on('error', once);
  }
}

// ── WebSocket Frame Encoding/Decoding ──────────────────────────────────────

function encodeFrame(data: string | Buffer, opcode: number): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const len = payload.length;

  let headerLen: number;
  if (len < 126) {
    headerLen = 2;
  } else if (len < 65536) {
    headerLen = 4;
  } else {
    headerLen = 10;
  }

  const frame = Buffer.alloc(headerLen + len);
  frame[0] = 0x80 | opcode; // FIN + opcode

  if (len < 126) {
    frame[1] = len;
  } else if (len < 65536) {
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }

  payload.copy(frame, headerLen);
  return frame;
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  totalLength: number;
}

function decodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) return null;

  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  const maskLen = masked ? 4 : 0;
  const totalLength = offset + maskLen + payloadLen;
  if (buffer.length < totalLength) return null;

  let payload: Buffer;
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buffer[offset + 4 + i] ^ mask[i % 4];
    }
  } else {
    payload = buffer.subarray(offset, offset + payloadLen);
  }

  return { opcode, payload, totalLength };
}

// ── Module Implementation ──────────────────────────────────────────────────

export class WebSocketModule implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'ui.websocket',
    name: 'WebSocket Streaming',
    version: '0.1.0',
    type: ModuleType.UIExtension,
    description: 'Real-time event streaming via WebSocket protocol.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: WebSocketConfig;
  private server: http.Server | null = null;
  private clients = new Map<string, WsClient>();
  private eventSubscriptions: EventSubscription[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Metrics
  private totalConnections = 0;
  private totalMessages = 0;
  private totalBroadcasts = 0;
  private healthy = true;
  private lastError: string | undefined;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    const DEFAULTS: WebSocketConfig = {
      port: 3001,
      host: '0.0.0.0',
      heartbeatIntervalMs: 30000,
      maxClients: 100,
      subscribableEvents: [
        'incident.created',
        'incident.updated',
        'enrichment.completed',
        'action.proposed',
        'action.approved',
        'action.executed',
        'log.ingested',
      ],
    };

    this.config = {
      ...DEFAULTS,
      ...context.config,
    } as WebSocketConfig;

    this.ctx.logger.info('Initialized', {
      port: this.config.port,
      host: this.config.host,
      maxClients: this.config.maxClients,
      subscribableEvents: this.config.subscribableEvents,
    });
  }

  async start(): Promise<void> {
    // Subscribe to all subscribable events on the bus
    for (const eventType of this.config.subscribableEvents) {
      const sub = this.ctx.bus.subscribe(eventType, (event) => {
        this.broadcastEvent(event);
      });
      this.eventSubscriptions.push(sub);
    }

    // Start the WebSocket server
    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((_req, res) => {
        // Regular HTTP requests get a 426 Upgrade Required
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('Upgrade to WebSocket required');
      });

      this.server.on('upgrade', (req, socket, head) => {
        this.handleUpgrade(req, socket as import('node:net').Socket, head);
      });

      this.server.on('error', (err) => {
        this.healthy = false;
        this.lastError = err.message;
        this.ctx.logger.error('WebSocket server error', err);
        reject(err);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        this.ctx.logger.info('WebSocket server started', {
          url: `ws://${this.config.host}:${this.config.port}`,
        });

        // Start heartbeat monitor
        this.heartbeatTimer = setInterval(
          () => this.heartbeat(),
          this.config.heartbeatIntervalMs,
        );

        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Unsubscribe from bus events
    for (const sub of this.eventSubscriptions) {
      sub.unsubscribe();
    }
    this.eventSubscriptions = [];

    // Close all client connections
    for (const client of this.clients.values()) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();

    // Close the server
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.ctx.logger.info('WebSocket server stopped', {
            totalConnections: this.totalConnections,
            totalMessages: this.totalMessages,
            totalBroadcasts: this.totalBroadcasts,
          });
          this.server = null;
          resolve();
        });
      });
    }
  }

  async destroy(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.clients.clear();
    this.eventSubscriptions = [];
    this.ctx = undefined!;
    this.config = undefined!;
  }

  health(): ModuleHealth {
    return {
      status: this.healthy ? 'healthy' : 'degraded',
      message: this.lastError,
      details: {
        port: this.config?.port,
        activeClients: this.clients.size,
        totalConnections: this.totalConnections,
        totalMessages: this.totalMessages,
        totalBroadcasts: this.totalBroadcasts,
      },
      lastCheck: new Date(),
    };
  }

  // ── WebSocket Handshake ──────────────────────────────────────────────────

  private handleUpgrade(
    req: http.IncomingMessage,
    socket: import('node:net').Socket,
    _head: Buffer,
  ): void {
    // Enforce max clients
    if (this.clients.size >= this.config.maxClients) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // WebSocket accept key computation (RFC 6455)
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n');

    socket.write(headers);

    // Create client
    const clientId = crypto.randomUUID();
    const client = new WsClient(clientId, socket);
    this.clients.set(clientId, client);
    this.totalConnections++;

    this.ctx.logger.debug('Client connected', {
      clientId,
      activeClients: this.clients.size,
    });

    // Send welcome message
    client.send({
      type: 'welcome',
      clientId,
      subscribableEvents: this.config.subscribableEvents,
    });

    // Handle incoming messages
    client.onData((opcode, payload) => {
      this.handleClientMessage(client, opcode, payload);
    });

    // Handle disconnection
    client.onClose(() => {
      this.clients.delete(clientId);
      this.ctx?.logger?.debug('Client disconnected', {
        clientId,
        activeClients: this.clients.size,
      });
    });
  }

  // ── Client Message Handling ──────────────────────────────────────────────

  private handleClientMessage(
    client: WsClient,
    opcode: number,
    payload: Buffer,
  ): void {
    switch (opcode) {
      case WsOpcode.Text: {
        this.totalMessages++;
        try {
          const msg = JSON.parse(payload.toString('utf-8'));
          this.processClientAction(client, msg);
        } catch {
          client.send({ type: 'error', message: 'Invalid JSON' });
        }
        break;
      }
      case WsOpcode.Pong: {
        client.isAlive = true;
        break;
      }
      case WsOpcode.Close: {
        client.close();
        this.clients.delete(client.id);
        break;
      }
      case WsOpcode.Ping: {
        // Respond with pong (same payload)
        if (client['socket']?.writable) {
          const frame = encodeFrame(payload, WsOpcode.Pong);
          client['socket'].write(frame);
        }
        break;
      }
    }
  }

  private processClientAction(
    client: WsClient,
    msg: { action?: string; events?: string[] },
  ): void {
    switch (msg.action) {
      case 'subscribe': {
        if (!Array.isArray(msg.events)) {
          client.send({ type: 'error', message: 'events must be an array' });
          return;
        }
        // Only allow subscribable events
        const validEvents = msg.events.filter((e) =>
          this.config.subscribableEvents.includes(e),
        );
        client.subscribe(validEvents);
        client.send({
          type: 'subscribed',
          events: [...client.subscriptions],
        });
        break;
      }

      case 'unsubscribe': {
        if (!Array.isArray(msg.events)) {
          client.send({ type: 'error', message: 'events must be an array' });
          return;
        }
        client.unsubscribe(msg.events);
        client.send({
          type: 'subscribed',
          events: [...client.subscriptions],
        });
        break;
      }

      case 'ping': {
        client.send({ type: 'pong' });
        break;
      }

      default: {
        client.send({
          type: 'error',
          message: `Unknown action: ${msg.action}`,
        });
      }
    }
  }

  // ── Event Broadcasting ───────────────────────────────────────────────────

  private broadcastEvent(event: OpsPilotEvent): void {
    const message = {
      type: 'event',
      eventType: event.type,
      source: event.source,
      timestamp: event.timestamp,
      correlationId: event.correlationId,
      data: event.payload,
    };

    let sent = 0;
    for (const client of this.clients.values()) {
      if (client.isSubscribedTo(event.type)) {
        client.send(message);
        sent++;
      }
    }

    if (sent > 0) {
      this.totalBroadcasts++;
    }
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  private heartbeat(): void {
    for (const [id, client] of this.clients) {
      if (!client.isAlive) {
        // Dead connection — terminate
        this.ctx.logger.debug('Removing dead client', { clientId: id });
        client.destroy();
        this.clients.delete(id);
        continue;
      }

      client.isAlive = false;
      client.sendPing();
    }
  }

  // ── Getters for testing ──────────────────────────────────────────────────

  getServer(): http.Server | null {
    return this.server;
  }

  getClients(): Map<string, WsClient> {
    return this.clients;
  }

  getConfig(): WebSocketConfig {
    return this.config;
  }
}
