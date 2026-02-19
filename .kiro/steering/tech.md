# OpsPilot Tech Stack

## Language & Runtime

- **TypeScript 5.7+** with strict mode enabled
- **Node.js ≥20.0.0** required
- **Target**: ES2022, CommonJS modules

## Core Dependencies

Minimal production dependencies by design:

- `ajv ^8.17.1` - JSON Schema validation
- `yaml ^2.7.0` - YAML config parsing
- `better-sqlite3 ^12.6.2` - SQLite persistent storage (WAL mode, prepared statements)
- `jsonwebtoken` - JWT token signing and verification (HS256)

## Development Dependencies

- `typescript ^5.7.0` - TypeScript compiler
- `ts-node ^10.9.2` - Development runtime
- `@types/node ^22.13.0` - Node.js type definitions
- `@types/better-sqlite3` - SQLite type definitions
- `@types/jsonwebtoken` - JWT type definitions
- `rimraf ^6.0.1` - Cross-platform file cleanup

## Testing

- **Framework**: Node.js built-in test runner (`node:test`)
- **Assertions**: `node:assert/strict`
- **Coverage**: 816 tests across 219 suites, all passing
- **Test helpers**: `tests/helpers.ts` provides shared utilities

## Build System

Standard TypeScript compilation:

```bash
# Build
npm run build          # Compiles src/ → dist/

# Clean
npm run clean          # Removes dist/

# Type check tests
npm run test:check     # Validates test files without running
```

## Common Commands

```bash
# Development
npm run dev            # Run with ts-node (no build required)

# Production
npm start              # Run compiled code from dist/

# Testing
npm test               # Run full test suite

# With CLI approval interface
npm start -- --cli --operator your-name
```

## Configuration

- **Format**: YAML with JSON Schema validation
- **Location**: `config/default.yaml`, `config/test.yaml`
- **Overrides**: Environment variables with `OPSPILOT_*` prefix
- **Validation**: Per-module schemas in `src/modules/*/schema.json`

## Path Aliases

Configured in `tsconfig.json`:

```typescript
import { EventBus } from '@core/bus';
import { IModule } from '@core/types';
import { createSilentLogger } from '@shared/logger';
```

## Architecture Patterns

- **Dependency Injection**: ModuleContext injected at initialization
- **Factory Pattern**: ModuleLoader uses factory functions
- **Event-Driven**: All inter-module communication via EventBus
- **Lifecycle Management**: Strict state machine (Registered → Initialized → Running → Stopped → Destroyed)
- **Namespaced Storage**: Modules cannot access each other's data

## Zero External Runtime Dependencies

Core modules use only Node.js built-ins:

- `http` / `https` - REST API, webhooks
- `crypto` - WebSocket handshake, UUID generation, HMAC-based API key comparison
- `fs` / `fs/promises` - File operations
- `os` - System metrics
- `dgram` / `net` - Syslog UDP/TCP
- `child_process` - journald integration

The only non-stdlib production dependencies are `ajv` (schema validation), `yaml` (config parsing), `better-sqlite3` (persistent storage), and `jsonwebtoken` (JWT auth). This ensures minimal attack surface and easy deployment.

## Containerization & CI

- **Dockerfile**: Multi-stage build (builder → production), `node:20-alpine`, non-root `opspilot` user, dev dependency pruning, `HEALTHCHECK` directive
- **docker-compose.yml**: Single service with SQLite volume mount, port mapping (3000/3001/3002), health check
- **GitHub Actions**: CI pipeline at `.github/workflows/ci.yml` — build → test on Node 20+22, Docker build on main branch push
- **Probes**: `/api/livez` (liveness, always 200), `/api/readyz` (readiness, 200/503 based on module health)

## Resilience Patterns

- **Rate Limiting**: `KeyedRateLimiter` (sliding window) on REST API — per-client with `X-RateLimit-*` headers
- **Circuit Breaker**: `CircuitBreaker` (closed → open → half-open) for outbound calls
- **Retry**: `retryWithBackoff()` with jitter, configurable max delay, `isRetryableHttpError()` predicate
- **Response Cache**: LRU cache with TTL for AI provider responses
- **Structured Logging**: JSON/text format, file output, size-based rotation (`maxFileSize`, `maxFiles`)
- **Prometheus Metrics**: `MetricsCollector` at `/api/metrics` — module health gauges, process metrics, custom counters
