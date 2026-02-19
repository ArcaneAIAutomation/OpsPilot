// ---------------------------------------------------------------------------
// OpsPilot — connector.syslog (Syslog Receiver)
// ---------------------------------------------------------------------------
// Opens a UDP or TCP listener for syslog messages (RFC 3164 / RFC 5424).
// Parses the syslog priority, facility, severity, timestamp, hostname
// and message. Emits `log.ingested` events for downstream detection.
//
// Features:
//   - UDP and TCP transport support
//   - RFC 3164 (BSD) and RFC 5424 (IETF) format parsing with auto-detect
//   - Syslog severity → OpsPilot severity mapping
//   - Per-message metadata (facility, severity, hostname, appName, PID)
//   - Configurable max message size
//   - Health reporting with message counts and error tracking
// ---------------------------------------------------------------------------

import * as dgram from 'node:dgram';
import * as net from 'node:net';
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

interface SyslogConfig {
  protocol: 'udp' | 'tcp';
  host: string;
  port: number;
  source: string;
  maxMessageSize: number;
  parseRfc: '3164' | '5424' | 'auto';
}

const DEFAULTS: SyslogConfig = {
  protocol: 'udp',
  host: '0.0.0.0',
  port: 1514,
  source: 'syslog',
  maxMessageSize: 8192,
  parseRfc: 'auto',
};

// Syslog facility names
const FACILITY_NAMES = [
  'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
  'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'security', 'console', 'solaris-cron',
  'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
];

// Syslog severity names
const SEVERITY_NAMES = [
  'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug',
];

// Map syslog severity → OpsPilot severity
const SYSLOG_TO_OPS_SEVERITY: Record<number, string> = {
  0: 'critical',   // emerg
  1: 'critical',   // alert
  2: 'critical',   // crit
  3: 'warning',    // err
  4: 'warning',    // warning
  5: 'info',       // notice
  6: 'info',       // info
  7: 'info',       // debug
};

/** Parsed syslog message structure. */
export interface ParsedSyslog {
  priority: number;
  facility: number;
  severity: number;
  facilityName: string;
  severityName: string;
  timestamp?: Date;
  hostname?: string;
  appName?: string;
  pid?: string;
  msgId?: string;
  message: string;
  rfc: '3164' | '5424';
}

// ── Module Implementation ──────────────────────────────────────────────────

export class SyslogConnector implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'connector.syslog',
    name: 'Syslog Receiver',
    version: '0.1.0',
    type: ModuleType.Connector,
    description: 'Receives syslog messages via UDP/TCP and emits log.ingested events.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: SyslogConfig;

  // Network handles
  private udpSocket: dgram.Socket | null = null;
  private tcpServer: net.Server | null = null;
  private tcpConnections: Set<net.Socket> = new Set();

  // Metrics
  private messagesReceived = 0;
  private messagesEmitted = 0;
  private parseErrors = 0;
  private healthy = true;
  private lastError?: string;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    const raw = context.config as Partial<SyslogConfig>;

    this.config = {
      protocol: raw.protocol ?? DEFAULTS.protocol,
      host: raw.host ?? DEFAULTS.host,
      port: raw.port ?? DEFAULTS.port,
      source: raw.source ?? DEFAULTS.source,
      maxMessageSize: raw.maxMessageSize ?? DEFAULTS.maxMessageSize,
      parseRfc: raw.parseRfc ?? DEFAULTS.parseRfc,
    };

    this.ctx.logger.info('Initialized', {
      protocol: this.config.protocol,
      host: this.config.host,
      port: this.config.port,
      parseRfc: this.config.parseRfc,
    });
  }

  async start(): Promise<void> {
    if (this.config.protocol === 'udp') {
      await this.startUdp();
    } else {
      await this.startTcp();
    }

    this.ctx.logger.info('Syslog listener started', {
      protocol: this.config.protocol,
      port: this.config.port,
    });
  }

  async stop(): Promise<void> {
    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }

    if (this.tcpServer) {
      for (const conn of this.tcpConnections) {
        conn.destroy();
      }
      this.tcpConnections.clear();

      await new Promise<void>((resolve) => {
        this.tcpServer!.close(() => resolve());
      });
      this.tcpServer = null;
    }

    this.ctx.logger.info('Stopped', {
      messagesReceived: this.messagesReceived,
      messagesEmitted: this.messagesEmitted,
    });
  }

  async destroy(): Promise<void> {
    this.udpSocket = null;
    this.tcpServer = null;
    this.tcpConnections.clear();
  }

  health(): ModuleHealth {
    return {
      status: this.healthy ? 'healthy' : 'degraded',
      message: this.lastError,
      details: {
        protocol: this.config?.protocol,
        port: this.config?.port,
        messagesReceived: this.messagesReceived,
        messagesEmitted: this.messagesEmitted,
        parseErrors: this.parseErrors,
      },
      lastCheck: new Date(),
    };
  }

  // ── UDP Listener ─────────────────────────────────────────────────────────

  private startUdp(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.udpSocket = dgram.createSocket('udp4');

      this.udpSocket.on('message', (msg, rinfo) => {
        this.handleMessage(msg.toString('utf-8', 0, this.config.maxMessageSize), rinfo.address);
      });

      this.udpSocket.on('error', (err) => {
        this.healthy = false;
        this.lastError = err.message;
        this.ctx.logger.error('UDP socket error', err);
      });

      this.udpSocket.bind(this.config.port, this.config.host, () => {
        resolve();
      });

      // Timeout for bind — if it hasn't resolved in 5s, reject
      setTimeout(() => reject(new Error('UDP bind timeout')), 5000);
    });
  }

  // ── TCP Listener ─────────────────────────────────────────────────────────

  private startTcp(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.tcpServer = net.createServer((socket) => {
        this.tcpConnections.add(socket);
        let buffer = '';

        socket.on('data', (data) => {
          buffer += data.toString('utf-8');
          // Split on newlines — syslog over TCP typically uses newline framing
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.trim().length > 0) {
              this.handleMessage(
                line.slice(0, this.config.maxMessageSize),
                socket.remoteAddress ?? 'unknown',
              );
            }
          }
        });

        socket.on('close', () => {
          this.tcpConnections.delete(socket);
        });

        socket.on('error', (err) => {
          this.ctx.logger.warn('TCP connection error', { error: err.message });
          this.tcpConnections.delete(socket);
        });
      });

      this.tcpServer.on('error', (err) => {
        this.healthy = false;
        this.lastError = err.message;
        reject(err);
      });

      this.tcpServer.listen(this.config.port, this.config.host, () => {
        resolve();
      });
    });
  }

  // ── Message Handling ─────────────────────────────────────────────────────

  private handleMessage(raw: string, remoteAddress: string): void {
    this.messagesReceived++;

    try {
      const parsed = this.parse(raw);
      const opsSeverity = SYSLOG_TO_OPS_SEVERITY[parsed.severity] ?? 'info';

      const payload: LogIngestedPayload = {
        source: this.config.source,
        line: parsed.message,
        ingestedAt: new Date(),
        metadata: {
          collector: 'connector.syslog',
          protocol: this.config.protocol,
          remoteAddress,
          priority: parsed.priority,
          facility: parsed.facilityName,
          severity: parsed.severityName,
          opsSeverity,
          hostname: parsed.hostname,
          appName: parsed.appName,
          pid: parsed.pid,
          msgId: parsed.msgId,
          rfc: parsed.rfc,
          originalTimestamp: parsed.timestamp?.toISOString(),
        },
      };

      this.ctx.bus.publish<LogIngestedPayload>({
        type: 'log.ingested',
        source: this.manifest.id,
        timestamp: new Date(),
        payload,
      });

      this.messagesEmitted++;
      this.healthy = true;
    } catch (err) {
      this.parseErrors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.ctx.logger.warn('Syslog parse error', {
        error: this.lastError,
        raw: raw.slice(0, 200),
      });
    }
  }

  // ── Syslog Parsing ──────────────────────────────────────────────────────

  /** Parse a syslog message. Public for testing. */
  parse(raw: string): ParsedSyslog {
    const trimmed = raw.trim();

    if (this.config.parseRfc === '5424') return this.parseRfc5424(trimmed);
    if (this.config.parseRfc === '3164') return this.parseRfc3164(trimmed);

    // Auto-detect: RFC 5424 starts with <PRI>VERSION (e.g. <165>1 ...)
    if (/^<\d{1,3}>\d+ /.test(trimmed)) {
      return this.parseRfc5424(trimmed);
    }
    return this.parseRfc3164(trimmed);
  }

  /** Parse RFC 3164 (BSD) syslog message. */
  private parseRfc3164(raw: string): ParsedSyslog {
    // Format: <PRI>TIMESTAMP HOSTNAME APP[PID]: MSG
    const priMatch = raw.match(/^<(\d{1,3})>(.*)/);
    if (!priMatch) {
      throw new Error('Invalid syslog format: missing priority');
    }

    const priority = parseInt(priMatch[1], 10);
    const facility = priority >> 3;
    const severity = priority & 0x07;
    let rest = priMatch[2];

    // Try to parse BSD timestamp: "Jan  1 12:00:00"
    let timestamp: Date | undefined;
    const tsMatch = rest.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(.*)/);
    let hostname: string | undefined;
    let afterHostname = rest;

    if (tsMatch) {
      const year = new Date().getFullYear();
      timestamp = new Date(`${tsMatch[1]} ${year}`);
      afterHostname = tsMatch[2];
    }

    // Next token is hostname
    const hostMatch = afterHostname.match(/^(\S+)\s+(.*)/);
    let appMsg = afterHostname;
    if (hostMatch) {
      hostname = hostMatch[1];
      appMsg = hostMatch[2];
    }

    // App name and PID
    let appName: string | undefined;
    let pid: string | undefined;
    const appMatch = appMsg.match(/^(\S+?)(\[(\d+)\])?:\s*(.*)/);
    let message = appMsg;
    if (appMatch) {
      appName = appMatch[1];
      pid = appMatch[3];
      message = appMatch[4];
    }

    return {
      priority,
      facility,
      severity,
      facilityName: FACILITY_NAMES[facility] ?? `facility${facility}`,
      severityName: SEVERITY_NAMES[severity] ?? `severity${severity}`,
      timestamp,
      hostname,
      appName,
      pid,
      message,
      rfc: '3164',
    };
  }

  /** Parse RFC 5424 (IETF) syslog message. */
  private parseRfc5424(raw: string): ParsedSyslog {
    // Format: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [SD] MSG
    const match = raw.match(
      /^<(\d{1,3})>(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)/,
    );

    if (!match) {
      throw new Error('Invalid RFC 5424 format');
    }

    const priority = parseInt(match[1], 10);
    const facility = priority >> 3;
    const severity = priority & 0x07;
    const timestampStr = match[3];
    const hostname = match[4] === '-' ? undefined : match[4];
    const appName = match[5] === '-' ? undefined : match[5];
    const pid = match[6] === '-' ? undefined : match[6];
    const msgId = match[7] === '-' ? undefined : match[7];
    let message = match[8] ?? '';

    // Strip structured data block if present
    if (message.startsWith('[')) {
      const sdEnd = message.indexOf('] ');
      if (sdEnd !== -1) {
        message = message.slice(sdEnd + 2);
      }
    } else if (message.startsWith('- ')) {
      // Nil structured data (SD = "-")
      message = message.slice(2);
    } else if (message === '-') {
      message = '';
    }

    // BOM prefix
    if (message.startsWith('\uFEFF')) {
      message = message.slice(1);
    }

    let timestamp: Date | undefined;
    if (timestampStr !== '-') {
      timestamp = new Date(timestampStr);
    }

    return {
      priority,
      facility,
      severity,
      facilityName: FACILITY_NAMES[facility] ?? `facility${facility}`,
      severityName: SEVERITY_NAMES[severity] ?? `severity${severity}`,
      timestamp,
      hostname,
      appName,
      pid,
      msgId,
      message: message.trim(),
      rfc: '5424',
    };
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getConfig(): SyslogConfig { return this.config; }

  getMetrics() {
    return {
      messagesReceived: this.messagesReceived,
      messagesEmitted: this.messagesEmitted,
      parseErrors: this.parseErrors,
    };
  }

  /** Inject a raw syslog message for testing (bypasses network). */
  injectMessage(raw: string, remoteAddress: string = '127.0.0.1'): void {
    this.handleMessage(raw, remoteAddress);
  }
}
