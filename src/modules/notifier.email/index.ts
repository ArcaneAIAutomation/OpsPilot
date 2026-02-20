// ---------------------------------------------------------------------------
// OpsPilot — notifier.email (Email Notifier — OAuth + SMTP)
// ---------------------------------------------------------------------------
// Sends formatted email notifications via OAuth 2.0 APIs (Google Gmail,
// Microsoft Graph) or legacy SMTP. Zero external dependencies — uses
// Node.js built-in https/net/tls modules.
//
// Features:
//   - OAuth 2.0 with automatic token refresh (Google & Microsoft)
//   - Google Gmail API (users.messages.send)
//   - Microsoft Graph API (/me/sendMail or /users/{userId}/sendMail)
//   - Legacy SMTP fallback (EHLO → AUTH PLAIN → MAIL FROM → RCPT TO → DATA)
//   - Severity-based subject tags and HTML body colour coding
//   - Minimum severity filter for incident events
//   - Per-minute rate limiting
//   - Timeout and error handling with health reporting
// ---------------------------------------------------------------------------

import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { OpsPilotEvent, EventSubscription } from '../../core/types/events';
import {
  IncidentCreatedPayload,
  ActionProposedPayload,
  ActionApprovedPayload,
  ActionExecutedPayload,
  EnrichmentCompletedPayload,
  IncidentSeverity,
} from '../../shared/events';
import configSchema from './schema.json';

// ── Config ─────────────────────────────────────────────────────────────────

type TransportMode = 'oauth' | 'smtp';
type OAuthProvider = 'google' | 'microsoft';

interface OAuthConfig {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Microsoft only — Azure AD tenant ID (default: "common") */
  tenantId: string;
  /** Microsoft Graph — send as a specific user (e.g. "user@domain.com").
   *  If omitted, sends as /me (requires delegated permission). */
  userId: string;
}

interface EmailConfig {
  transport: TransportMode;
  oauth: OAuthConfig;
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  to: string[];
  subjectPrefix: string;
  events: string[];
  minSeverity: IncidentSeverity;
  rateLimitPerMinute: number;
  timeoutMs: number;
}

const OAUTH_DEFAULTS: OAuthConfig = {
  provider: 'google',
  clientId: '',
  clientSecret: '',
  refreshToken: '',
  tenantId: 'common',
  userId: '',
};

const DEFAULTS: Omit<EmailConfig, 'smtpHost' | 'to'> = {
  transport: 'oauth',
  oauth: { ...OAUTH_DEFAULTS },
  smtpPort: 587,
  secure: false,
  username: '',
  password: '',
  from: 'opspilot@localhost',
  subjectPrefix: '[OpsPilot]',
  events: [
    'incident.created',
    'action.proposed',
    'action.executed',
    'enrichment.completed',
  ],
  minSeverity: 'warning',
  rateLimitPerMinute: 10,
  timeoutMs: 30_000,
};

// ── Severity helpers ───────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

const SEVERITY_COLOR: Record<string, string> = {
  info: '#36a64f',
  warning: '#ff9900',
  critical: '#ff0000',
};

const SEVERITY_TAG: Record<string, string> = {
  info: 'INFO',
  warning: 'WARNING',
  critical: 'CRITICAL',
};

// ── Email body type ────────────────────────────────────────────────────────

export interface EmailMessage {
  subject: string;
  html: string;
}

// ── OAuth token cache ──────────────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// ── Module Implementation ──────────────────────────────────────────────────

export class EmailNotifier implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'notifier.email',
    name: 'Email Notifier',
    version: '2.0.0',
    type: ModuleType.Notifier,
    description: 'Sends email notifications via OAuth 2.0 (Gmail / Microsoft Graph) or SMTP.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: EmailConfig;
  private subscriptions: EventSubscription[] = [];

  // OAuth token cache
  private tokenCache: CachedToken | null = null;

  // Rate limiter
  private timestamps: number[] = [];

  // Metrics
  private totalSent = 0;
  private totalDropped = 0;
  private totalErrors = 0;
  private lastError?: string;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    const raw = context.config as Partial<EmailConfig> & { oauth?: Partial<OAuthConfig> };

    const rawOAuth: Partial<OAuthConfig> = raw.oauth ?? {};
    const oauth: OAuthConfig = {
      provider: rawOAuth.provider ?? OAUTH_DEFAULTS.provider,
      clientId: rawOAuth.clientId ?? OAUTH_DEFAULTS.clientId,
      clientSecret: rawOAuth.clientSecret ?? OAUTH_DEFAULTS.clientSecret,
      refreshToken: rawOAuth.refreshToken ?? OAUTH_DEFAULTS.refreshToken,
      tenantId: rawOAuth.tenantId ?? OAUTH_DEFAULTS.tenantId,
      userId: rawOAuth.userId ?? OAUTH_DEFAULTS.userId,
    };

    this.config = {
      transport: raw.transport ?? DEFAULTS.transport,
      oauth,
      smtpHost: raw.smtpHost ?? '',
      smtpPort: raw.smtpPort ?? DEFAULTS.smtpPort,
      secure: raw.secure ?? DEFAULTS.secure,
      username: raw.username ?? DEFAULTS.username,
      password: raw.password ?? DEFAULTS.password,
      from: raw.from ?? DEFAULTS.from,
      to: raw.to ?? [],
      subjectPrefix: raw.subjectPrefix ?? DEFAULTS.subjectPrefix,
      events: raw.events ?? [...DEFAULTS.events],
      minSeverity: raw.minSeverity ?? DEFAULTS.minSeverity,
      rateLimitPerMinute: raw.rateLimitPerMinute ?? DEFAULTS.rateLimitPerMinute,
      timeoutMs: raw.timeoutMs ?? DEFAULTS.timeoutMs,
    };

    this.ctx.logger.info('Email notifier initialized', {
      transport: this.config.transport,
      provider: this.config.transport === 'oauth' ? this.config.oauth.provider : 'smtp',
      events: this.config.events,
      to: this.config.to,
    });
  }

  async start(): Promise<void> {
    for (const eventType of this.config.events) {
      const sub = this.ctx.bus.subscribe(eventType, (event) => {
        this.onEvent(event, eventType).catch((err) => {
          this.totalErrors++;
          this.lastError = err instanceof Error ? err.message : String(err);
          this.ctx.logger.error('Email notification error', err instanceof Error ? err : undefined);
        });
      });
      this.subscriptions.push(sub);
    }

    this.ctx.logger.info('Email notifier started', {
      subscribedTo: this.config.events,
    });
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions = [];
    this.ctx.logger.info('Email notifier stopped', {
      totalSent: this.totalSent,
      totalDropped: this.totalDropped,
      totalErrors: this.totalErrors,
    });
  }

  async destroy(): Promise<void> {
    this.timestamps = [];
    this.tokenCache = null;
  }

  health(): ModuleHealth {
    const status =
      this.totalErrors > 0 && this.totalSent === 0
        ? 'unhealthy'
        : this.totalErrors > 0
          ? 'degraded'
          : 'healthy';

    return {
      status,
      message: this.lastError,
      details: {
        totalSent: this.totalSent,
        totalDropped: this.totalDropped,
        totalErrors: this.totalErrors,
        transport: this.config?.transport ?? 'unknown',
        provider: this.config?.transport === 'oauth'
          ? this.config.oauth.provider
          : `smtp://${this.config?.smtpHost ?? 'missing'}`,
        recipients: this.config?.to?.length ?? 0,
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Handling ───────────────────────────────────────────────────────

  private async onEvent(event: OpsPilotEvent, eventType: string): Promise<void> {
    // Severity filter for incidents
    if (eventType === 'incident.created') {
      const payload = event.payload as IncidentCreatedPayload;
      if (SEVERITY_ORDER[payload.severity] < SEVERITY_ORDER[this.config.minSeverity]) {
        return;
      }
    }

    // Rate limit
    if (!this.checkRateLimit()) {
      this.totalDropped++;
      this.ctx.logger.warn('Email rate limit exceeded, dropping', { eventType });
      return;
    }

    const message = this.formatEmail(event, eventType);
    await this.sendEmail(message);
    this.totalSent++;
  }

  // ── Email Formatting ─────────────────────────────────────────────────────

  /** Build an EmailMessage for the given event. Public for test access. */
  formatEmail(event: OpsPilotEvent, eventType: string): EmailMessage {
    switch (eventType) {
      case 'incident.created':
        return this.formatIncident(event.payload as IncidentCreatedPayload);
      case 'action.proposed':
        return this.formatActionProposed(event.payload as ActionProposedPayload);
      case 'action.approved':
        return this.formatActionApproved(event.payload as ActionApprovedPayload);
      case 'action.executed':
        return this.formatActionExecuted(event.payload as ActionExecutedPayload);
      case 'enrichment.completed':
        return this.formatEnrichment(event.payload as EnrichmentCompletedPayload);
      default:
        return this.formatGeneric(event, eventType);
    }
  }

  private formatIncident(p: IncidentCreatedPayload): EmailMessage {
    const tag = SEVERITY_TAG[p.severity] ?? p.severity.toUpperCase();
    const color = SEVERITY_COLOR[p.severity] ?? '#cccccc';

    return {
      subject: `${this.config.subjectPrefix} ${tag}: ${p.title}`,
      html: this.wrapHtml(`
        <h2 style="color:${color};">${this.esc(tag)} — ${this.esc(p.title)}</h2>
        <p>${this.esc(p.description)}</p>
        <table>
          <tr><td><strong>Severity</strong></td><td>${this.esc(p.severity.toUpperCase())}</td></tr>
          <tr><td><strong>Detected By</strong></td><td>${this.esc(p.detectedBy)}</td></tr>
          <tr><td><strong>Incident ID</strong></td><td>${this.esc(p.incidentId)}</td></tr>
          <tr><td><strong>Time</strong></td><td>${new Date(p.detectedAt).toISOString()}</td></tr>
        </table>
      `),
    };
  }

  private formatActionProposed(p: ActionProposedPayload): EmailMessage {
    return {
      subject: `${this.config.subjectPrefix} Action Proposed: ${p.actionType}`,
      html: this.wrapHtml(`
        <h2 style="color:#ff9900;">⚡ Action Proposed: ${this.esc(p.actionType)}</h2>
        <p><strong>${this.esc(p.description)}</strong></p>
        <p><em>Reasoning:</em> ${this.esc(p.reasoning)}</p>
        <table>
          <tr><td><strong>Request ID</strong></td><td>${this.esc(p.requestId)}</td></tr>
          <tr><td><strong>Requested By</strong></td><td>${this.esc(p.requestedBy)}</td></tr>
        </table>
        <p>⏳ <em>Awaiting human approval</em></p>
      `),
    };
  }

  private formatActionApproved(p: ActionApprovedPayload): EmailMessage {
    return {
      subject: `${this.config.subjectPrefix} Action Approved: ${p.requestId}`,
      html: this.wrapHtml(`
        <h2 style="color:#36a64f;">✅ Action Approved</h2>
        <table>
          <tr><td><strong>Request ID</strong></td><td>${this.esc(p.requestId)}</td></tr>
          <tr><td><strong>Approved By</strong></td><td>${this.esc(p.approvedBy)}</td></tr>
        </table>
      `),
    };
  }

  private formatActionExecuted(p: ActionExecutedPayload): EmailMessage {
    const isSuccess = p.result === 'success';
    const color = isSuccess ? '#36a64f' : '#ff0000';
    const icon = isSuccess ? '✅' : '❌';

    return {
      subject: `${this.config.subjectPrefix} Action ${p.result.toUpperCase()}: ${p.actionType}`,
      html: this.wrapHtml(`
        <h2 style="color:${color};">${icon} Action Executed [${this.esc(p.result.toUpperCase())}]</h2>
        <table>
          <tr><td><strong>Type</strong></td><td>${this.esc(p.actionType)}</td></tr>
          <tr><td><strong>Result</strong></td><td>${this.esc(p.result.toUpperCase())}</td></tr>
          <tr><td><strong>Request ID</strong></td><td>${this.esc(p.requestId)}</td></tr>
          <tr><td><strong>Executed By</strong></td><td>${this.esc(p.executedBy)}</td></tr>
        </table>
        ${p.output ? `<pre>${this.esc(p.output)}</pre>` : ''}
      `),
    };
  }

  private formatEnrichment(p: EnrichmentCompletedPayload): EmailMessage {
    return {
      subject: `${this.config.subjectPrefix} Enrichment: ${p.enrichmentType}`,
      html: this.wrapHtml(`
        <h2 style="color:#36a64f;">🔍 Enrichment Completed</h2>
        <table>
          <tr><td><strong>Type</strong></td><td>${this.esc(p.enrichmentType)}</td></tr>
          <tr><td><strong>Incident</strong></td><td>${this.esc(p.incidentId)}</td></tr>
          <tr><td><strong>Module</strong></td><td>${this.esc(p.enricherModule)}</td></tr>
        </table>
      `),
    };
  }

  private formatGeneric(event: OpsPilotEvent, eventType: string): EmailMessage {
    return {
      subject: `${this.config.subjectPrefix} Event: ${eventType}`,
      html: this.wrapHtml(`
        <h2>🔔 ${this.esc(eventType)}</h2>
        <p>Source: ${this.esc(event.source)}</p>
        <pre>${this.esc(JSON.stringify(event.payload, null, 2).slice(0, 2000))}</pre>
      `),
    };
  }

  // ── HTML helpers ─────────────────────────────────────────────────────────

  private wrapHtml(body: string): string {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: Arial, sans-serif; margin: 20px; color: #333; }
  table { border-collapse: collapse; margin: 12px 0; }
  td { padding: 4px 12px 4px 0; }
  pre { background: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; }
  h2 { margin-top: 0; }
</style></head>
<body>${body}
<hr><p style="font-size:11px;color:#999;">Sent by OpsPilot notifier.email</p>
</body></html>`;
  }

  /** HTML-escape a string. */
  private esc(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Email Delivery ─────────────────────────────────────────────────────

  /**
   * Send an email via the configured transport (OAuth or SMTP).
   * Public so tests can override without real network access.
   */
  async sendEmail(message: EmailMessage): Promise<void> {
    if (this.config.transport === 'oauth') {
      await this.oauthSend(message);
    } else {
      await this.smtpSendMessage(message);
    }
  }

  // ── OAuth Delivery ───────────────────────────────────────────────────────

  /**
   * Refresh the OAuth 2.0 access token using the stored refresh token.
   * Caches the token and reuses it until ~60 s before expiry.
   */
  async refreshAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.accessToken;
    }

    const { provider, clientId, clientSecret, refreshToken, tenantId } = this.config.oauth;

    let tokenUrl: string;
    let body: string;

    if (provider === 'google') {
      tokenUrl = 'https://oauth2.googleapis.com/token';
      body = [
        `client_id=${encodeURIComponent(clientId)}`,
        `client_secret=${encodeURIComponent(clientSecret)}`,
        `refresh_token=${encodeURIComponent(refreshToken)}`,
        'grant_type=refresh_token',
      ].join('&');
    } else {
      // Microsoft
      const tid = tenantId || 'common';
      tokenUrl = `https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`;
      body = [
        `client_id=${encodeURIComponent(clientId)}`,
        `client_secret=${encodeURIComponent(clientSecret)}`,
        `refresh_token=${encodeURIComponent(refreshToken)}`,
        'grant_type=refresh_token',
        'scope=https%3A%2F%2Fgraph.microsoft.com%2F.default+offline_access',
      ].join('&');
    }

    const resp = await this.httpsPost(tokenUrl, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    const data = JSON.parse(resp) as { access_token: string; expires_in: number };
    if (!data.access_token) {
      throw new Error(`OAuth token refresh failed: ${resp.slice(0, 300)}`);
    }

    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    this.ctx.logger.info('OAuth access token refreshed', {
      provider,
      expiresInSec: data.expires_in,
    });

    return data.access_token;
  }

  /**
   * Send an email via the provider's REST API.
   */
  private async oauthSend(message: EmailMessage): Promise<void> {
    const token = await this.refreshAccessToken();

    if (this.config.oauth.provider === 'google') {
      await this.sendViaGmail(token, message);
    } else {
      await this.sendViaMicrosoftGraph(token, message);
    }
  }

  /**
   * Gmail API — POST /gmail/v1/users/me/messages/send
   * Accepts a base64url-encoded RFC 5322 message.
   */
  private async sendViaGmail(token: string, message: EmailMessage): Promise<void> {
    const rfc5322 = this.buildRfc5322(message);
    // base64url encode
    const encoded = Buffer.from(rfc5322)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const payload = JSON.stringify({ raw: encoded });

    const resp = await this.httpsPost(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      payload,
      {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    );

    const result = JSON.parse(resp);
    if (!result.id) {
      throw new Error(`Gmail API error: ${resp.slice(0, 300)}`);
    }
  }

  /**
   * Microsoft Graph API — POST /v1.0/me/sendMail  or /users/{userId}/sendMail
   * Accepts a JSON message body.
   */
  private async sendViaMicrosoftGraph(token: string, message: EmailMessage): Promise<void> {
    const userId = this.config.oauth.userId;
    const endpoint = userId
      ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/sendMail`
      : 'https://graph.microsoft.com/v1.0/me/sendMail';

    const payload = JSON.stringify({
      message: {
        subject: message.subject,
        body: {
          contentType: 'HTML',
          content: message.html,
        },
        toRecipients: this.config.to.map((addr) => ({
          emailAddress: { address: addr },
        })),
        from: {
          emailAddress: { address: this.config.from },
        },
      },
      saveToSentItems: false,
    });

    const resp = await this.httpsPost(endpoint, payload, {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });

    // Graph returns 202 with empty body on success
    if (resp && resp.trim().length > 0) {
      try {
        const result = JSON.parse(resp);
        if (result.error) {
          throw new Error(`Graph API error: ${result.error.message ?? resp.slice(0, 300)}`);
        }
      } catch (e) {
        if (e instanceof SyntaxError) {
          // Non-JSON response is OK (202 no content)
        } else {
          throw e;
        }
      }
    }
  }

  /**
   * Build an RFC 5322 message string (used by both SMTP and Gmail API).
   */
  private buildRfc5322(message: EmailMessage): string {
    const boundary = `----=_Part_${Date.now().toString(36)}`;
    const toHeader = this.config.to.join(', ');
    return [
      `From: ${this.config.from}`,
      `To: ${toHeader}`,
      `Subject: ${message.subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      `Date: ${new Date().toUTCString()}`,
      `X-Mailer: OpsPilot/2.0`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      message.html,
      '',
      `--${boundary}--`,
    ].join('\r\n');
  }

  /**
   * Minimal HTTPS POST helper using Node.js built-in https module.
   * Returns the response body as a string.
   */
  async httpsPost(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<string> {
    const https = await import('node:https');
    const { URL } = await import('node:url');
    const parsed = new URL(url);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`HTTPS request timeout: ${url}`));
      }, this.config.timeoutMs);

      const req = https.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: {
            ...headers,
            'Content-Length': Buffer.byteLength(body).toString(),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            clearTimeout(timer);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
            } else {
              resolve(data);
            }
          });
        },
      );

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  // ── SMTP Delivery (legacy fallback) ──────────────────────────────────────

  /**
   * Send an email via SMTP (legacy transport).
   */
  private async smtpSendMessage(message: EmailMessage): Promise<void> {
    const raw = this.buildRfc5322(message);
    await this.smtpSend(raw);
  }

  /**
   * Low-level SMTP transmission. Separated for testability.
   * Connects, authenticates (optional), and delivers the raw RFC 5322 message.
   */
  private async smtpSend(rawMessage: string): Promise<void> {
    /* istanbul ignore next — real SMTP is integration-tested; unit tests override sendEmail() */
    const net = await import('node:net');
    const tls = await import('node:tls');

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket?.destroy();
        reject(new Error('SMTP timeout'));
      }, this.config.timeoutMs);

      let socket: import('node:net').Socket;

      const cleanup = () => {
        clearTimeout(timer);
        socket?.destroy();
      };

      const fail = (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      // Accumulate lines and drive state machine
      let phase = 0;
      let buffer = '';

      const onData = (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\r\n');
        buffer = lines.pop()!; // keep incomplete line

        for (const line of lines) {
          if (line.length < 3) continue;
          const code = parseInt(line.slice(0, 3), 10);
          drive(code, line);
        }
      };

      const drive = (code: number, _line: string) => {
        if (code >= 400) {
          fail(new Error(`SMTP error ${code}: ${_line}`));
          return;
        }

        switch (phase) {
          case 0: // greeting
            phase = 1;
            send(`EHLO ${this.config.from.split('@')[1] ?? 'localhost'}`);
            break;
          case 1: // EHLO response (may be multi-line; proceed when code 250 without dash)
            if (_line[3] === ' ') {
              if (this.config.username) {
                phase = 2;
                const credentials = Buffer.from(
                  `\0${this.config.username}\0${this.config.password}`,
                ).toString('base64');
                send(`AUTH PLAIN ${credentials}`);
              } else {
                phase = 3;
                send(`MAIL FROM:<${this.config.from}>`);
              }
            }
            break;
          case 2: // AUTH response
            phase = 3;
            send(`MAIL FROM:<${this.config.from}>`);
            break;
          case 3: // MAIL FROM response
            phase = 4;
            this.rcptIndex = 0;
            send(`RCPT TO:<${this.config.to[this.rcptIndex]}>`);
            break;
          case 4: // RCPT TO response(s)
            this.rcptIndex++;
            if (this.rcptIndex < this.config.to.length) {
              send(`RCPT TO:<${this.config.to[this.rcptIndex]}>`);
            } else {
              phase = 5;
              send('DATA');
            }
            break;
          case 5: // DATA ready (354)
            phase = 6;
            // Dot-stuffing per RFC 5321
            const stuffed = rawMessage.replace(/^\./gm, '..');
            send(`${stuffed}\r\n.`);
            break;
          case 6: // Message accepted
            phase = 7;
            send('QUIT');
            break;
          case 7: // QUIT ack
            cleanup();
            resolve();
            break;
        }
      };

      const send = (cmd: string) => {
        socket.write(cmd + '\r\n');
      };

      // Connect
      if (this.config.secure) {
        socket = tls.connect(
          { host: this.config.smtpHost, port: this.config.smtpPort, rejectUnauthorized: true },
          () => {},
        );
      } else {
        socket = net.createConnection(this.config.smtpPort, this.config.smtpHost);
      }

      socket.on('data', onData);
      socket.on('error', fail);
      socket.on('close', () => {
        clearTimeout(timer);
      });
    });
  }

  /** Tracks which RCPT TO we've sent during smtpSend(). */
  private rcptIndex = 0;

  // ── Rate Limiter ─────────────────────────────────────────────────────────

  private checkRateLimit(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((ts) => ts > now - 60_000);
    if (this.timestamps.length >= this.config.rateLimitPerMinute) return false;
    this.timestamps.push(now);
    return true;
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getConfig(): EmailConfig {
    return this.config;
  }

  getMetrics(): { totalSent: number; totalDropped: number; totalErrors: number } {
    return {
      totalSent: this.totalSent,
      totalDropped: this.totalDropped,
      totalErrors: this.totalErrors,
    };
  }

  getTokenCache(): CachedToken | null {
    return this.tokenCache;
  }

  clearTokenCache(): void {
    this.tokenCache = null;
  }
}
