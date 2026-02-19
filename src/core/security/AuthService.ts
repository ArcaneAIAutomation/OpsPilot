// ---------------------------------------------------------------------------
// OpsPilot — Authentication Service
// ---------------------------------------------------------------------------
// Handles JWT verification/generation and static API key validation.
// Used by REST API and Dashboard modules to guard endpoints.
//
// When auth is disabled (`enabled: false`), all requests pass through.
// ---------------------------------------------------------------------------

import jwt from 'jsonwebtoken';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  IAuthService,
  AuthConfig,
  AuthIdentity,
  AuthRole,
  ApiKeyEntry,
} from '../types/auth';
import { ILogger } from '../types/module';

export class AuthService implements IAuthService {
  readonly enabled: boolean;

  private readonly jwtSecret: string | undefined;
  private readonly jwtExpiresIn: string;
  private readonly jwtIssuer: string;
  private readonly apiKeys: ReadonlyArray<ApiKeyEntry>;
  private readonly publicPaths: ReadonlySet<string>;
  private readonly logger: ILogger;

  constructor(config: AuthConfig, logger: ILogger) {
    this.enabled = config.enabled;
    this.jwtSecret = config.jwtSecret;
    this.jwtExpiresIn = config.jwtExpiresIn ?? '8h';
    this.jwtIssuer = config.jwtIssuer ?? 'opspilot';
    this.apiKeys = config.apiKeys ?? [];
    this.publicPaths = new Set(config.publicPaths ?? ['/api/health']);
    this.logger = logger;

    if (this.enabled) {
      if (!this.jwtSecret && this.apiKeys.length === 0) {
        this.logger.warn(
          'Auth is enabled but no jwtSecret or apiKeys configured — all requests will be rejected',
        );
      }
      this.logger.info('Authentication enabled', {
        hasJwtSecret: !!this.jwtSecret,
        apiKeyCount: this.apiKeys.length,
        publicPaths: [...this.publicPaths],
      });
    } else {
      this.logger.info('Authentication disabled — all requests pass through');
    }
  }

  // ── JWT ──────────────────────────────────────────────────────────────────

  verifyJwt(token: string): AuthIdentity | null {
    if (!this.jwtSecret) return null;

    try {
      const payload = jwt.verify(token, this.jwtSecret, {
        issuer: this.jwtIssuer,
        algorithms: ['HS256'],
      }) as jwt.JwtPayload;

      if (!payload.sub || !payload.role) {
        this.logger.warn('JWT missing required claims (sub, role)');
        return null;
      }

      const role = payload.role as string;
      if (!this.isValidRole(role)) {
        this.logger.warn('JWT contains invalid role', { role });
        return null;
      }

      return {
        sub: payload.sub,
        role: role as AuthRole,
        method: 'jwt',
        issuedAt: payload.iat ? new Date(payload.iat * 1000) : undefined,
      };
    } catch (err) {
      this.logger.debug('JWT verification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  issueJwt(sub: string, role: AuthRole): string | null {
    if (!this.jwtSecret) return null;

    return jwt.sign({ sub, role }, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn as jwt.SignOptions['expiresIn'],
      issuer: this.jwtIssuer,
      algorithm: 'HS256',
    });
  }

  // ── API Key ──────────────────────────────────────────────────────────────

  verifyApiKey(key: string): AuthIdentity | null {
    if (this.apiKeys.length === 0) return null;

    // Constant-time comparison to prevent timing attacks
    for (const entry of this.apiKeys) {
      if (this.safeEqual(key, entry.key)) {
        return {
          sub: entry.label,
          role: entry.role,
          method: 'apikey',
        };
      }
    }

    return null;
  }

  // ── Request Authentication ───────────────────────────────────────────────

  authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): AuthIdentity | null {
    // 1. Try Authorization: Bearer <jwt>
    const authHeader = headers['authorization'] ?? headers['Authorization'];
    if (authHeader) {
      const headerStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      if (headerStr?.startsWith('Bearer ')) {
        const token = headerStr.slice(7).trim();
        const identity = this.verifyJwt(token);
        if (identity) return identity;
      }
    }

    // 2. Try X-API-Key header
    const apiKey = headers['x-api-key'] ?? headers['X-API-Key'];
    if (apiKey) {
      const keyStr = Array.isArray(apiKey) ? apiKey[0] : apiKey;
      if (keyStr) {
        const identity = this.verifyApiKey(keyStr);
        if (identity) return identity;
      }
    }

    return null;
  }

  // ── Public Path Check ────────────────────────────────────────────────────

  /**
   * Returns `true` if the given path is exempt from auth.
   * Matches exact paths and also checks path-prefix patterns ending with `*`.
   */
  isPublicPath(pathname: string): boolean {
    if (this.publicPaths.has(pathname)) return true;

    for (const p of this.publicPaths) {
      if (p.endsWith('*') && pathname.startsWith(p.slice(0, -1))) {
        return true;
      }
    }

    return false;
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  private isValidRole(role: string): role is AuthRole {
    return role === 'admin' || role === 'operator' || role === 'viewer';
  }

  /**
   * Constant-time string comparison.
   * Uses HMAC to normalize lengths before comparison.
   */
  private safeEqual(a: string, b: string): boolean {
    const key = 'opspilot-key-compare';
    const hmacA = createHmac('sha256', key).update(a).digest();
    const hmacB = createHmac('sha256', key).update(b).digest();
    return timingSafeEqual(hmacA, hmacB);
  }
}
