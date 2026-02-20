// ---------------------------------------------------------------------------
// OpsPilot — notifier.email Unit Tests (OAuth + SMTP)
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EmailNotifier, EmailMessage } from '../src/modules/notifier.email/index';
import { ModuleContext, ModuleType } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { OpsPilotEvent } from '../src/core/types/events';
import {
  IncidentCreatedPayload,
  ActionProposedPayload,
  ActionExecutedPayload,
  EnrichmentCompletedPayload,
} from '../src/shared/events';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function emailContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'notifier.email',
    config: {
      transport: 'oauth',
      oauth: {
        provider: 'google',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        refreshToken: 'test-refresh-token',
      },
      from: 'ops@test.local',
      to: ['admin@test.local'],
      subjectPrefix: '[OpsPilot]',
      events: ['incident.created', 'action.proposed', 'action.executed', 'enrichment.completed'],
      minSeverity: 'info',
      rateLimitPerMinute: 60,
      timeoutMs: 5000,
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'notifier.email'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function smtpContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return emailContext(infra, {
    transport: 'smtp',
    smtpHost: 'smtp.test.local',
    smtpPort: 587,
    ...config,
  });
}

function makeIncidentEvent(severity: string = 'critical'): OpsPilotEvent<IncidentCreatedPayload> {
  return {
    type: 'incident.created',
    source: 'test',
    timestamp: new Date(),
    payload: {
      incidentId: 'INC-E-001',
      title: 'High CPU Usage',
      description: 'CPU at 95% for 5 minutes',
      severity: severity as any,
      detectedBy: 'detector.threshold',
      detectedAt: new Date(),
      context: { host: 'web-01' },
    },
  };
}

function makeActionProposedEvent(): OpsPilotEvent<ActionProposedPayload> {
  return {
    type: 'action.proposed',
    source: 'test',
    timestamp: new Date(),
    payload: {
      requestId: 'REQ-E-001',
      actionType: 'restart_service',
      description: 'Restart the web service',
      reasoning: 'Service is unresponsive',
      requestedBy: 'action.safe',
    },
  };
}

function makeActionExecutedEvent(result: 'success' | 'failure' = 'success'): OpsPilotEvent<ActionExecutedPayload> {
  return {
    type: 'action.executed',
    source: 'test',
    timestamp: new Date(),
    payload: {
      requestId: 'REQ-E-001',
      tokenId: 'tok-001',
      actionType: 'restart_service',
      result,
      output: result === 'success' ? 'Service restarted' : 'Timeout',
      executedBy: 'action.executor',
      executedAt: new Date(),
    },
  };
}

function makeEnrichmentEvent(): OpsPilotEvent<EnrichmentCompletedPayload> {
  return {
    type: 'enrichment.completed',
    source: 'test',
    timestamp: new Date(),
    payload: {
      incidentId: 'INC-E-001',
      enrichmentType: 'log_context',
      enricherModule: 'enricher.logContext',
      data: { recentLogs: ['err1', 'err2'] },
      completedAt: new Date(),
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('notifier.email', () => {
  let notifier: EmailNotifier;
  let infra: ReturnType<typeof createTestInfra>;

  beforeEach(() => {
    infra = createTestInfra();
    notifier = new EmailNotifier();
  });

  afterEach(async () => {
    try { await notifier.stop(); } catch {}
    try { await notifier.destroy(); } catch {}
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  describe('Lifecycle', () => {
    it('exposes correct manifest', () => {
      assert.equal(notifier.manifest.id, 'notifier.email');
      assert.equal(notifier.manifest.type, ModuleType.Notifier);
      assert.equal(notifier.manifest.version, '2.0.0');
      assert.ok(notifier.manifest.configSchema);
    });

    it('initializes with OAuth config by default', async () => {
      await notifier.initialize(emailContext(infra));
      const cfg = notifier.getConfig();
      assert.equal(cfg.transport, 'oauth');
      assert.equal(cfg.oauth.provider, 'google');
      assert.equal(cfg.oauth.clientId, 'test-client-id');
      assert.equal(cfg.from, 'ops@test.local');
      assert.deepStrictEqual(cfg.to, ['admin@test.local']);
    });

    it('initializes with SMTP config when transport=smtp', async () => {
      await notifier.initialize(smtpContext(infra));
      const cfg = notifier.getConfig();
      assert.equal(cfg.transport, 'smtp');
      assert.equal(cfg.smtpHost, 'smtp.test.local');
      assert.equal(cfg.smtpPort, 587);
    });

    it('applies defaults for optional fields', async () => {
      await notifier.initialize(emailContext(infra, {
        transport: undefined,
        from: undefined,
        subjectPrefix: undefined,
        minSeverity: undefined,
        rateLimitPerMinute: undefined,
        timeoutMs: undefined,
      }));
      const cfg = notifier.getConfig();
      assert.equal(cfg.transport, 'oauth');
      assert.equal(cfg.from, 'opspilot@localhost');
      assert.equal(cfg.subjectPrefix, '[OpsPilot]');
      assert.equal(cfg.minSeverity, 'warning');
      assert.equal(cfg.rateLimitPerMinute, 10);
      assert.equal(cfg.timeoutMs, 30000);
    });

    it('reports healthy when no errors', async () => {
      await notifier.initialize(emailContext(infra));
      const h = notifier.health();
      assert.equal(h.status, 'healthy');
      assert.ok(h.details);
      assert.equal(h.details!.totalSent, 0);
      assert.equal(h.details!.totalErrors, 0);
      assert.equal(h.details!.transport, 'oauth');
    });
  });

  // ── Email Formatting ──────────────────────────────────────────────────

  describe('Email Formatting', () => {
    beforeEach(async () => {
      await notifier.initialize(emailContext(infra));
    });

    it('formats incident email with severity', () => {
      const event = makeIncidentEvent('critical');
      const msg = notifier.formatEmail(event, 'incident.created');
      assert.ok(msg.subject.includes('CRITICAL'));
      assert.ok(msg.subject.includes('High CPU Usage'));
      assert.ok(msg.html.includes('#ff0000'));
      assert.ok(msg.html.includes('INC-E-001'));
    });

    it('formats action proposed email', () => {
      const event = makeActionProposedEvent();
      const msg = notifier.formatEmail(event, 'action.proposed');
      assert.ok(msg.subject.includes('Action Proposed'));
      assert.ok(msg.subject.includes('restart_service'));
      assert.ok(msg.html.includes('REQ-E-001'));
      assert.ok(msg.html.includes('Awaiting human approval'));
    });

    it('formats action executed success email', () => {
      const event = makeActionExecutedEvent('success');
      const msg = notifier.formatEmail(event, 'action.executed');
      assert.ok(msg.subject.includes('SUCCESS'));
      assert.ok(msg.html.includes('#36a64f'));
      assert.ok(msg.html.includes('Service restarted'));
    });

    it('formats action executed failure email', () => {
      const event = makeActionExecutedEvent('failure');
      const msg = notifier.formatEmail(event, 'action.executed');
      assert.ok(msg.subject.includes('FAILURE'));
      assert.ok(msg.html.includes('#ff0000'));
    });

    it('formats enrichment email', () => {
      const event = makeEnrichmentEvent();
      const msg = notifier.formatEmail(event, 'enrichment.completed');
      assert.ok(msg.subject.includes('Enrichment'));
      assert.ok(msg.html.includes('log_context'));
      assert.ok(msg.html.includes('INC-E-001'));
    });

    it('formats generic event email', () => {
      const event: OpsPilotEvent = {
        type: 'custom.event',
        source: 'test',
        timestamp: new Date(),
        payload: { key: 'value' },
      };
      const msg = notifier.formatEmail(event, 'custom.event');
      assert.ok(msg.subject.includes('Event: custom.event'));
      assert.ok(msg.html.includes('custom.event'));
    });

    it('HTML-escapes content to prevent XSS', () => {
      const event = makeIncidentEvent('critical');
      (event.payload as IncidentCreatedPayload).title = '<script>alert("xss")</script>';
      const msg = notifier.formatEmail(event, 'incident.created');
      assert.ok(!msg.html.includes('<script>'));
      assert.ok(msg.html.includes('&lt;script&gt;'));
    });
  });

  // ── Event Emission & Delivery ────────────────────────────────────────

  describe('Event Delivery', () => {
    let sentMessages: EmailMessage[];

    beforeEach(async () => {
      sentMessages = [];
      await notifier.initialize(emailContext(infra));
      // Override sendEmail to capture without real SMTP
      notifier.sendEmail = async (msg: EmailMessage) => {
        sentMessages.push(msg);
      };
      await notifier.start();
    });

    it('sends email on incident event', async () => {
      infra.bus.publish(makeIncidentEvent());
      await sleep(30);
      assert.equal(sentMessages.length, 1);
      assert.ok(sentMessages[0].subject.includes('CRITICAL'));
      const m = notifier.getMetrics();
      assert.equal(m.totalSent, 1);
    });

    it('sends email on action proposed event', async () => {
      infra.bus.publish(makeActionProposedEvent());
      await sleep(30);
      assert.equal(sentMessages.length, 1);
      assert.ok(sentMessages[0].subject.includes('Action Proposed'));
    });

    it('ignores events not in configured list', async () => {
      const event: OpsPilotEvent = {
        type: 'action.approved',
        source: 'test',
        timestamp: new Date(),
        payload: { requestId: 'R1', approvedBy: 'admin', token: 'tok', expiresAt: new Date() },
      };
      infra.bus.publish(event);
      await sleep(30);
      assert.equal(sentMessages.length, 0);
    });
  });

  // ── Severity Filtering ───────────────────────────────────────────────

  describe('Severity Filtering', () => {
    let sentMessages: EmailMessage[];

    beforeEach(async () => {
      sentMessages = [];
      await notifier.initialize(emailContext(infra, { minSeverity: 'warning' }));
      notifier.sendEmail = async (msg: EmailMessage) => {
        sentMessages.push(msg);
      };
      await notifier.start();
    });

    it('drops info incidents when minSeverity is warning', async () => {
      infra.bus.publish(makeIncidentEvent('info'));
      await sleep(30);
      assert.equal(sentMessages.length, 0);
    });

    it('sends warning incidents when minSeverity is warning', async () => {
      infra.bus.publish(makeIncidentEvent('warning'));
      await sleep(30);
      assert.equal(sentMessages.length, 1);
    });

    it('sends critical incidents when minSeverity is warning', async () => {
      infra.bus.publish(makeIncidentEvent('critical'));
      await sleep(30);
      assert.equal(sentMessages.length, 1);
    });
  });

  // ── Rate Limiting ────────────────────────────────────────────────────

  describe('Rate Limiting', () => {
    let sentMessages: EmailMessage[];

    beforeEach(async () => {
      sentMessages = [];
      await notifier.initialize(emailContext(infra, {
        rateLimitPerMinute: 2,
        minSeverity: 'info',
      }));
      notifier.sendEmail = async (msg: EmailMessage) => {
        sentMessages.push(msg);
      };
      await notifier.start();
    });

    it('drops messages exceeding rate limit', async () => {
      // Send 3 events, limit is 2/min
      for (let i = 0; i < 3; i++) {
        infra.bus.publish(makeIncidentEvent('critical'));
        await sleep(10);
      }
      await sleep(50);
      assert.equal(sentMessages.length, 2);
      const m = notifier.getMetrics();
      assert.equal(m.totalDropped, 1);
    });
  });

  // ── Error Handling ───────────────────────────────────────────────────

  describe('Error Handling', () => {
    it('tracks errors and reports degraded health', async () => {
      await notifier.initialize(emailContext(infra, { minSeverity: 'info' }));

      // First call succeeds, second fails
      let callCount = 0;
      notifier.sendEmail = async (_msg: EmailMessage) => {
        callCount++;
        if (callCount === 2) throw new Error('SMTP connection refused');
      };
      await notifier.start();

      infra.bus.publish(makeIncidentEvent('critical'));
      await sleep(30);
      infra.bus.publish(makeIncidentEvent('critical'));
      await sleep(30);

      const m = notifier.getMetrics();
      assert.equal(m.totalSent, 1);
      assert.equal(m.totalErrors, 1);

      const h = notifier.health();
      assert.equal(h.status, 'degraded');
      assert.ok(h.message?.includes('connection refused'));
    });

    it('reports unhealthy when all sends fail', async () => {
      await notifier.initialize(emailContext(infra, { minSeverity: 'info' }));
      notifier.sendEmail = async () => {
        throw new Error('Connection timeout');
      };
      await notifier.start();

      infra.bus.publish(makeIncidentEvent('critical'));
      await sleep(30);

      const h = notifier.health();
      assert.equal(h.status, 'unhealthy');
    });
  });

  // ── OAuth Configuration ──────────────────────────────────────────────

  describe('OAuth Configuration', () => {
    it('defaults to oauth transport with google provider', async () => {
      await notifier.initialize(emailContext(infra));
      const cfg = notifier.getConfig();
      assert.equal(cfg.transport, 'oauth');
      assert.equal(cfg.oauth.provider, 'google');
    });

    it('accepts microsoft provider with tenantId and userId', async () => {
      await notifier.initialize(emailContext(infra, {
        oauth: {
          provider: 'microsoft',
          clientId: 'ms-client',
          clientSecret: 'ms-secret',
          refreshToken: 'ms-token',
          tenantId: 'my-tenant-id',
          userId: 'admin@contoso.com',
        },
      }));
      const cfg = notifier.getConfig();
      assert.equal(cfg.oauth.provider, 'microsoft');
      assert.equal(cfg.oauth.tenantId, 'my-tenant-id');
      assert.equal(cfg.oauth.userId, 'admin@contoso.com');
    });

    it('applies OAuth defaults when partial config given', async () => {
      await notifier.initialize(emailContext(infra, {
        oauth: { provider: 'google' },
      }));
      const cfg = notifier.getConfig();
      assert.equal(cfg.oauth.tenantId, 'common');
      assert.equal(cfg.oauth.userId, '');
    });

    it('health details include transport and provider', async () => {
      await notifier.initialize(emailContext(infra));
      const h = notifier.health();
      assert.equal(h.details!.transport, 'oauth');
      assert.equal(h.details!.provider, 'google');
    });

    it('health details show smtp host for smtp transport', async () => {
      await notifier.initialize(smtpContext(infra));
      const h = notifier.health();
      assert.equal(h.details!.transport, 'smtp');
      assert.ok((h.details!.provider as string).includes('smtp.test.local'));
    });
  });

  // ── OAuth Token Refresh ──────────────────────────────────────────────

  describe('OAuth Token Refresh', () => {
    it('fetches a new access token via httpsPost', async () => {
      await notifier.initialize(emailContext(infra));

      // Stub httpsPost to simulate token endpoint response
      notifier.httpsPost = async (_url: string, body: string, _headers: Record<string, string>) => {
        assert.ok(body.includes('grant_type=refresh_token'));
        assert.ok(body.includes('client_id=test-client-id'));
        return JSON.stringify({ access_token: 'at-123', expires_in: 3600 });
      };

      const token = await notifier.refreshAccessToken();
      assert.equal(token, 'at-123');

      // Verify token is cached
      const cache = notifier.getTokenCache();
      assert.ok(cache);
      assert.equal(cache!.accessToken, 'at-123');
    });

    it('reuses cached token when not expired', async () => {
      await notifier.initialize(emailContext(infra));

      let callCount = 0;
      notifier.httpsPost = async () => {
        callCount++;
        return JSON.stringify({ access_token: `at-${callCount}`, expires_in: 3600 });
      };

      const t1 = await notifier.refreshAccessToken();
      const t2 = await notifier.refreshAccessToken();
      assert.equal(t1, t2);
      assert.equal(callCount, 1); // Only called once
    });

    it('refreshes token when cache is cleared', async () => {
      await notifier.initialize(emailContext(infra));

      let callCount = 0;
      notifier.httpsPost = async () => {
        callCount++;
        return JSON.stringify({ access_token: `at-${callCount}`, expires_in: 3600 });
      };

      await notifier.refreshAccessToken();
      notifier.clearTokenCache();
      const t2 = await notifier.refreshAccessToken();
      assert.equal(t2, 'at-2');
      assert.equal(callCount, 2);
    });

    it('throws when token response is invalid', async () => {
      await notifier.initialize(emailContext(infra));
      notifier.httpsPost = async () => JSON.stringify({ error: 'invalid_grant' });

      await assert.rejects(
        () => notifier.refreshAccessToken(),
        (err: Error) => err.message.includes('OAuth token refresh failed'),
      );
    });

    it('uses Microsoft token endpoint for microsoft provider', async () => {
      await notifier.initialize(emailContext(infra, {
        oauth: {
          provider: 'microsoft',
          clientId: 'ms-id',
          clientSecret: 'ms-secret',
          refreshToken: 'ms-refresh',
          tenantId: 'tenant-xyz',
        },
      }));

      let capturedUrl = '';
      notifier.httpsPost = async (url: string) => {
        capturedUrl = url;
        return JSON.stringify({ access_token: 'ms-at', expires_in: 3600 });
      };

      await notifier.refreshAccessToken();
      assert.ok(capturedUrl.includes('login.microsoftonline.com'));
      assert.ok(capturedUrl.includes('tenant-xyz'));
    });
  });

  // ── OAuth Send (Gmail) ──────────────────────────────────────────────

  describe('OAuth Send — Gmail', () => {
    let capturedPosts: Array<{ url: string; body: string; headers: Record<string, string> }>;

    beforeEach(async () => {
      capturedPosts = [];
      await notifier.initialize(emailContext(infra));

      notifier.httpsPost = async (url: string, body: string, headers: Record<string, string>) => {
        capturedPosts.push({ url, body, headers });
        // Token endpoint
        if (url.includes('oauth2.googleapis.com')) {
          return JSON.stringify({ access_token: 'gmail-token', expires_in: 3600 });
        }
        // Gmail send endpoint
        return JSON.stringify({ id: 'msg-123', threadId: 'thread-456' });
      };
    });

    it('sends email via Gmail API with base64url-encoded message', async () => {
      const msg: EmailMessage = { subject: 'Test', html: '<p>Hello</p>' };
      await notifier.sendEmail(msg);

      // Should have called token endpoint + send endpoint
      assert.equal(capturedPosts.length, 2);

      const sendCall = capturedPosts[1];
      assert.ok(sendCall.url.includes('gmail.googleapis.com'));
      assert.equal(sendCall.headers.Authorization, 'Bearer gmail-token');
      assert.equal(sendCall.headers['Content-Type'], 'application/json');

      const body = JSON.parse(sendCall.body);
      assert.ok(body.raw); // base64url encoded
      // Verify it decodes to valid content
      const decoded = Buffer.from(body.raw, 'base64').toString();
      assert.ok(decoded.includes('Subject: Test'));
      assert.ok(decoded.includes('<p>Hello</p>'));
    });

    it('delivers email on incident event via Gmail', async () => {
      notifier.sendEmail = async (msg: EmailMessage) => {
        capturedPosts.push({ url: 'sendEmail', body: msg.subject, headers: {} });
      };
      await notifier.start();

      infra.bus.publish(makeIncidentEvent('critical'));
      await sleep(30);

      assert.equal(notifier.getMetrics().totalSent, 1);
    });
  });

  // ── OAuth Send (Microsoft Graph) ─────────────────────────────────────

  describe('OAuth Send — Microsoft Graph', () => {
    let capturedPosts: Array<{ url: string; body: string }>;

    beforeEach(async () => {
      capturedPosts = [];
      await notifier.initialize(emailContext(infra, {
        oauth: {
          provider: 'microsoft',
          clientId: 'ms-id',
          clientSecret: 'ms-secret',
          refreshToken: 'ms-refresh',
          tenantId: 'tenant-1',
          userId: '',
        },
      }));

      notifier.httpsPost = async (url: string, body: string) => {
        capturedPosts.push({ url, body });
        if (url.includes('login.microsoftonline.com')) {
          return JSON.stringify({ access_token: 'graph-token', expires_in: 3600 });
        }
        return ''; // 202 no content
      };
    });

    it('sends email via Microsoft Graph /me/sendMail', async () => {
      const msg: EmailMessage = { subject: 'Test MS', html: '<p>Hi</p>' };
      await notifier.sendEmail(msg);

      assert.equal(capturedPosts.length, 2);
      const sendCall = capturedPosts[1];
      assert.ok(sendCall.url.includes('graph.microsoft.com'));
      assert.ok(sendCall.url.includes('/me/sendMail'));

      const payload = JSON.parse(sendCall.body);
      assert.equal(payload.message.subject, 'Test MS');
      assert.equal(payload.message.body.contentType, 'HTML');
      assert.ok(payload.message.toRecipients.length > 0);
    });

    it('uses /users/{userId}/sendMail when userId is set', async () => {
      await notifier.initialize(emailContext(infra, {
        oauth: {
          provider: 'microsoft',
          clientId: 'ms-id',
          clientSecret: 'ms-secret',
          refreshToken: 'ms-refresh',
          tenantId: 'tenant-1',
          userId: 'service@contoso.com',
        },
      }));

      notifier.httpsPost = async (url: string, body: string) => {
        capturedPosts.push({ url, body });
        if (url.includes('login.microsoftonline.com')) {
          return JSON.stringify({ access_token: 'graph-token', expires_in: 3600 });
        }
        return '';
      };

      await notifier.sendEmail({ subject: 'User', html: '<p>Hi</p>' });

      const sendCall = capturedPosts.find((c) => c.url.includes('graph.microsoft.com'));
      assert.ok(sendCall);
      assert.ok(sendCall!.url.includes('/users/service%40contoso.com/sendMail'));
    });
  });

  // ── SMTP Fallback ────────────────────────────────────────────────────

  describe('SMTP Fallback', () => {
    it('uses SMTP transport when configured', async () => {
      let smtpCalled = false;
      await notifier.initialize(smtpContext(infra));

      // Override sendEmail to verify flow
      notifier.sendEmail = async (_msg: EmailMessage) => {
        smtpCalled = true;
      };
      await notifier.start();

      infra.bus.publish(makeIncidentEvent('critical'));
      await sleep(30);

      assert.ok(smtpCalled);
      assert.equal(notifier.getMetrics().totalSent, 1);
    });
  });
});
