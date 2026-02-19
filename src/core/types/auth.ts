// ---------------------------------------------------------------------------
// OpsPilot — Authentication Types
// ---------------------------------------------------------------------------
// Defines the contract for API authentication: JWT bearer tokens and
// static API keys. Both methods produce an AuthIdentity that downstream
// handlers can inspect for role-based decisions.
// ---------------------------------------------------------------------------

/**
 * The result of successfully authenticating an incoming request.
 */
export interface AuthIdentity {
  /** Unique subject identifier (user ID, service name, API key label). */
  readonly sub: string;

  /** Role for coarse-grained access control. */
  readonly role: AuthRole;

  /** How this identity was established. */
  readonly method: 'jwt' | 'apikey';

  /** JWT `iat` or key creation time. */
  readonly issuedAt?: Date;
}

/**
 * Roles define what an authenticated caller may do.
 *
 * - `admin`    — full access: read, write, approve actions, manage keys
 * - `operator` — read + approve/deny actions, but no key management
 * - `viewer`   — read-only access to incidents, health, audit
 */
export type AuthRole = 'admin' | 'operator' | 'viewer';

/**
 * A statically-configured API key entry.
 */
export interface ApiKeyEntry {
  /** Human-readable label for this key (e.g. "ci-pipeline"). */
  readonly label: string;

  /** The key string (stored in config or env, never in DB). */
  readonly key: string;

  /** Role this key confers. */
  readonly role: AuthRole;
}

/**
 * Authentication configuration.
 */
export interface AuthConfig {
  /** Master switch — when false, all requests pass through unauthenticated. */
  enabled: boolean;

  /**
   * JWT configuration.
   * If `jwtSecret` is set, `Authorization: Bearer <token>` headers are
   * verified with this secret (HS256).
   */
  jwtSecret?: string;

  /** JWT token expiry duration (default `'8h'`). */
  jwtExpiresIn?: string;

  /** JWT issuer claim for validation. */
  jwtIssuer?: string;

  /** Static API keys (for service-to-service auth or CI pipelines). */
  apiKeys?: ApiKeyEntry[];

  /**
   * Paths that are exempt from authentication even when auth is enabled.
   * Useful for health-check endpoints consumed by load balancers.
   * Default: `['/api/health']`
   */
  publicPaths?: string[];
}

/**
 * The auth service contract.
 */
export interface IAuthService {
  /** Whether authentication is enabled. */
  readonly enabled: boolean;

  /** Verify a JWT bearer token. Returns the identity or `null`. */
  verifyJwt(token: string): AuthIdentity | null;

  /** Verify a static API key. Returns the identity or `null`. */
  verifyApiKey(key: string): AuthIdentity | null;

  /**
   * Issue a new JWT for a subject with a given role.
   * Only available when `jwtSecret` is configured.
   */
  issueJwt(sub: string, role: AuthRole): string | null;

  /**
   * Authenticate an incoming HTTP request.
   * Checks `Authorization: Bearer <jwt>` first, then `X-API-Key: <key>`.
   * Returns the identity on success or `null` on failure.
   */
  authenticate(headers: Record<string, string | string[] | undefined>): AuthIdentity | null;

  /**
   * Check whether a path is exempt from authentication.
   */
  isPublicPath(pathname: string): boolean;
}
