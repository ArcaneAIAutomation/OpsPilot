// ---------------------------------------------------------------------------
// OpsPilot — AuthService Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { AuthService } from '../src/core/security/AuthService';
import { AuthConfig, AuthIdentity } from '../src/core/types/auth';
import { createSilentLogger } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-secret-key-for-opspilot-auth';
const logger = createSilentLogger();

function makeConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    enabled: true,
    jwtSecret: TEST_SECRET,
    jwtExpiresIn: '1h',
    jwtIssuer: 'opspilot',
    apiKeys: [],
    publicPaths: ['/api/health'],
    ...overrides,
  };
}

function makeAuth(overrides: Partial<AuthConfig> = {}): AuthService {
  return new AuthService(makeConfig(overrides), logger);
}

function signJwt(
  payload: Record<string, unknown>,
  secret: string = TEST_SECRET,
  options: jwt.SignOptions = {},
): string {
  return jwt.sign(payload, secret, {
    issuer: 'opspilot',
    algorithm: 'HS256',
    expiresIn: '1h',
    ...options,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  describe('construction', () => {
    it('should create with auth enabled', () => {
      const auth = makeAuth();
      assert.strictEqual(auth.enabled, true);
    });

    it('should create with auth disabled', () => {
      const auth = makeAuth({ enabled: false });
      assert.strictEqual(auth.enabled, false);
    });
  });

  // ── JWT Verification ─────────────────────────────────────────────────────

  describe('verifyJwt', () => {
    let auth: AuthService;

    beforeEach(() => {
      auth = makeAuth();
    });

    it('should verify a valid JWT', () => {
      const token = signJwt({ sub: 'user-1', role: 'admin' });
      const identity = auth.verifyJwt(token);
      assert.ok(identity);
      assert.strictEqual(identity.sub, 'user-1');
      assert.strictEqual(identity.role, 'admin');
      assert.strictEqual(identity.method, 'jwt');
      assert.ok(identity.issuedAt instanceof Date);
    });

    it('should accept operator role', () => {
      const token = signJwt({ sub: 'ops-1', role: 'operator' });
      const identity = auth.verifyJwt(token);
      assert.ok(identity);
      assert.strictEqual(identity.role, 'operator');
    });

    it('should accept viewer role', () => {
      const token = signJwt({ sub: 'viewer-1', role: 'viewer' });
      const identity = auth.verifyJwt(token);
      assert.ok(identity);
      assert.strictEqual(identity.role, 'viewer');
    });

    it('should reject token with wrong secret', () => {
      const token = signJwt({ sub: 'user-1', role: 'admin' }, 'wrong-secret');
      const identity = auth.verifyJwt(token);
      assert.strictEqual(identity, null);
    });

    it('should reject expired token', () => {
      const token = signJwt(
        { sub: 'user-1', role: 'admin' },
        TEST_SECRET,
        { expiresIn: '0s' },
      );
      // Token is already expired
      const identity = auth.verifyJwt(token);
      assert.strictEqual(identity, null);
    });

    it('should reject token with wrong issuer', () => {
      const token = jwt.sign(
        { sub: 'user-1', role: 'admin' },
        TEST_SECRET,
        { issuer: 'wrong-issuer', algorithm: 'HS256' },
      );
      const identity = auth.verifyJwt(token);
      assert.strictEqual(identity, null);
    });

    it('should reject token missing sub claim', () => {
      const token = signJwt({ role: 'admin' });
      const identity = auth.verifyJwt(token);
      assert.strictEqual(identity, null);
    });

    it('should reject token missing role claim', () => {
      const token = signJwt({ sub: 'user-1' });
      const identity = auth.verifyJwt(token);
      assert.strictEqual(identity, null);
    });

    it('should reject token with invalid role', () => {
      const token = signJwt({ sub: 'user-1', role: 'superadmin' });
      const identity = auth.verifyJwt(token);
      assert.strictEqual(identity, null);
    });

    it('should reject malformed token', () => {
      const identity = auth.verifyJwt('not.a.real.jwt');
      assert.strictEqual(identity, null);
    });

    it('should reject empty token', () => {
      const identity = auth.verifyJwt('');
      assert.strictEqual(identity, null);
    });

    it('should return null when no jwtSecret configured', () => {
      const noJwtAuth = makeAuth({ jwtSecret: undefined });
      const token = signJwt({ sub: 'user-1', role: 'admin' });
      assert.strictEqual(noJwtAuth.verifyJwt(token), null);
    });
  });

  // ── JWT Issuance ─────────────────────────────────────────────────────────

  describe('issueJwt', () => {
    it('should issue a valid JWT', () => {
      const auth = makeAuth();
      const token = auth.issueJwt('user-1', 'admin');
      assert.ok(token);

      // Verify the issued token round-trips
      const identity = auth.verifyJwt(token);
      assert.ok(identity);
      assert.strictEqual(identity.sub, 'user-1');
      assert.strictEqual(identity.role, 'admin');
    });

    it('should return null when no jwtSecret configured', () => {
      const auth = makeAuth({ jwtSecret: undefined });
      assert.strictEqual(auth.issueJwt('user-1', 'admin'), null);
    });

    it('should use configured jwtIssuer', () => {
      const auth = makeAuth({ jwtIssuer: 'custom-issuer' });
      const token = auth.issueJwt('user-1', 'admin');
      assert.ok(token);

      const decoded = jwt.decode(token) as jwt.JwtPayload;
      assert.strictEqual(decoded.iss, 'custom-issuer');
    });

    it('should use configured jwtExpiresIn', () => {
      const auth = makeAuth({ jwtExpiresIn: '30m' });
      const token = auth.issueJwt('user-1', 'viewer');
      assert.ok(token);

      const decoded = jwt.decode(token) as jwt.JwtPayload;
      assert.ok(decoded.exp);
      assert.ok(decoded.iat);
      // 30 minutes = 1800 seconds
      assert.strictEqual(decoded.exp! - decoded.iat!, 1800);
    });
  });

  // ── API Key Verification ─────────────────────────────────────────────────

  describe('verifyApiKey', () => {
    it('should verify a valid API key', () => {
      const auth = makeAuth({
        apiKeys: [
          { label: 'ci-pipeline', key: 'sk-test-key-12345', role: 'operator' },
        ],
      });

      const identity = auth.verifyApiKey('sk-test-key-12345');
      assert.ok(identity);
      assert.strictEqual(identity.sub, 'ci-pipeline');
      assert.strictEqual(identity.role, 'operator');
      assert.strictEqual(identity.method, 'apikey');
    });

    it('should reject unknown API key', () => {
      const auth = makeAuth({
        apiKeys: [
          { label: 'ci', key: 'sk-real-key', role: 'operator' },
        ],
      });

      const identity = auth.verifyApiKey('sk-wrong-key');
      assert.strictEqual(identity, null);
    });

    it('should match correct key among multiple keys', () => {
      const auth = makeAuth({
        apiKeys: [
          { label: 'ci', key: 'sk-ci-key', role: 'operator' },
          { label: 'monitoring', key: 'sk-mon-key', role: 'viewer' },
          { label: 'admin-tool', key: 'sk-admin-key', role: 'admin' },
        ],
      });

      const id1 = auth.verifyApiKey('sk-mon-key');
      assert.ok(id1);
      assert.strictEqual(id1.sub, 'monitoring');
      assert.strictEqual(id1.role, 'viewer');

      const id2 = auth.verifyApiKey('sk-admin-key');
      assert.ok(id2);
      assert.strictEqual(id2.sub, 'admin-tool');
      assert.strictEqual(id2.role, 'admin');
    });

    it('should return null when no API keys configured', () => {
      const auth = makeAuth({ apiKeys: [] });
      assert.strictEqual(auth.verifyApiKey('any-key'), null);
    });
  });

  // ── Request Authentication ───────────────────────────────────────────────

  describe('authenticate', () => {
    it('should authenticate via Bearer token', () => {
      const auth = makeAuth();
      const token = signJwt({ sub: 'user-1', role: 'admin' });

      const identity = auth.authenticate({
        authorization: `Bearer ${token}`,
      });
      assert.ok(identity);
      assert.strictEqual(identity.sub, 'user-1');
      assert.strictEqual(identity.method, 'jwt');
    });

    it('should authenticate via X-API-Key header', () => {
      const auth = makeAuth({
        apiKeys: [{ label: 'svc', key: 'sk-svc-key', role: 'operator' }],
      });

      const identity = auth.authenticate({
        'x-api-key': 'sk-svc-key',
      });
      assert.ok(identity);
      assert.strictEqual(identity.sub, 'svc');
      assert.strictEqual(identity.method, 'apikey');
    });

    it('should prefer JWT over API key when both present', () => {
      const auth = makeAuth({
        apiKeys: [{ label: 'svc', key: 'sk-svc-key', role: 'viewer' }],
      });
      const token = signJwt({ sub: 'jwt-user', role: 'admin' });

      const identity = auth.authenticate({
        authorization: `Bearer ${token}`,
        'x-api-key': 'sk-svc-key',
      });
      assert.ok(identity);
      assert.strictEqual(identity.sub, 'jwt-user');
      assert.strictEqual(identity.method, 'jwt');
    });

    it('should fall back to API key if JWT is invalid', () => {
      const auth = makeAuth({
        apiKeys: [{ label: 'svc', key: 'sk-svc-key', role: 'operator' }],
      });

      const identity = auth.authenticate({
        authorization: 'Bearer invalid.token.here',
        'x-api-key': 'sk-svc-key',
      });
      assert.ok(identity);
      assert.strictEqual(identity.sub, 'svc');
      assert.strictEqual(identity.method, 'apikey');
    });

    it('should return null when no credentials provided', () => {
      const auth = makeAuth();
      assert.strictEqual(auth.authenticate({}), null);
    });

    it('should return null with empty authorization header', () => {
      const auth = makeAuth();
      assert.strictEqual(auth.authenticate({ authorization: '' }), null);
    });

    it('should not match non-Bearer authorization schemes', () => {
      const auth = makeAuth();
      assert.strictEqual(
        auth.authenticate({ authorization: 'Basic dXNlcjpwYXNz' }),
        null,
      );
    });

    it('should handle Authorization header with capital A', () => {
      const auth = makeAuth();
      const token = signJwt({ sub: 'user-1', role: 'admin' });

      const identity = auth.authenticate({
        Authorization: `Bearer ${token}`,
      });
      assert.ok(identity);
      assert.strictEqual(identity.sub, 'user-1');
    });

    it('should handle X-API-Key with different casing', () => {
      const auth = makeAuth({
        apiKeys: [{ label: 'svc', key: 'sk-key', role: 'viewer' }],
      });

      const identity = auth.authenticate({ 'X-API-Key': 'sk-key' });
      assert.ok(identity);
      assert.strictEqual(identity.sub, 'svc');
    });
  });

  // ── Public Paths ─────────────────────────────────────────────────────────

  describe('isPublicPath', () => {
    it('should match exact public paths', () => {
      const auth = makeAuth({ publicPaths: ['/api/health', '/api/version'] });
      assert.strictEqual(auth.isPublicPath('/api/health'), true);
      assert.strictEqual(auth.isPublicPath('/api/version'), true);
      assert.strictEqual(auth.isPublicPath('/api/incidents'), false);
    });

    it('should support wildcard suffix', () => {
      const auth = makeAuth({ publicPaths: ['/public/*'] });
      assert.strictEqual(auth.isPublicPath('/public/status'), true);
      assert.strictEqual(auth.isPublicPath('/public/info/deep'), true);
      assert.strictEqual(auth.isPublicPath('/api/health'), false);
    });

    it('should default to /api/health', () => {
      const auth = makeAuth({ publicPaths: undefined });
      assert.strictEqual(auth.isPublicPath('/api/health'), true);
      assert.strictEqual(auth.isPublicPath('/api/incidents'), false);
    });
  });

  // ── Disabled Auth ────────────────────────────────────────────────────────

  describe('disabled auth', () => {
    it('should report enabled=false', () => {
      const auth = makeAuth({ enabled: false });
      assert.strictEqual(auth.enabled, false);
    });

    it('should still verify JWT when called directly (method-level)', () => {
      const auth = makeAuth({ enabled: false });
      const token = signJwt({ sub: 'x', role: 'admin' });
      // verifyJwt still works — it's the middleware that skips when disabled
      const identity = auth.verifyJwt(token);
      assert.ok(identity);
    });
  });

  // ── Edge Cases ───────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle array-valued headers', () => {
      const auth = makeAuth({
        apiKeys: [{ label: 'svc', key: 'sk-key', role: 'viewer' }],
      });

      const identity = auth.authenticate({
        'x-api-key': ['sk-key', 'sk-other'],
      });
      assert.ok(identity);
      assert.strictEqual(identity.sub, 'svc');
    });

    it('should handle undefined header values gracefully', () => {
      const auth = makeAuth();
      const identity = auth.authenticate({
        authorization: undefined,
        'x-api-key': undefined,
      });
      assert.strictEqual(identity, null);
    });
  });
});
