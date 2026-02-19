# OpsPilot

**Modular AI-powered Operations Agent**

OpsPilot monitors systems, detects incidents, explains problems clearly, and safely assists humans in resolving operational issues. It converts raw signals into actionable understanding through an event-driven pipeline:

```
RAW SIGNAL → INCIDENT → UNDERSTANDING → SAFE ACTION
```

## Key Principles

- **Modular First** — Everything outside the core is a self-contained module
- **Event-Driven** — Modules communicate exclusively through a typed event bus
- **Safety by Design** — AI never executes actions automatically; all actions require human approval
- **Observable** — Every action is audited and traceable

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          OpsPilot Core                              │
│  ┌────────────┐ ┌──────────┐ ┌─────────┐ ┌────────┐ ┌───────────┐ │
│  │  EventBus  │ │  Config  │ │ Storage │ │ Audit  │ │ Approval  │ │
│  │            │ │  Loader  │ │         │ │ Logger │ │   Gate    │ │
│  └────────────┘ └──────────┘ └─────────┘ └────────┘ └───────────┘ │
│  ┌────────────────────┐ ┌──────────────────┐ ┌──────────────────┐  │
│  │ Module Lifecycle    │ │ Dependency       │ │ Plugin Loader    │  │
│  │ Manager             │ │ Resolver (Kahn)  │ │                  │  │
│  └────────────────────┘ └──────────────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
        │            │             │             │            │
        ▼            ▼             ▼             ▼            ▼
  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │Connectors│ │Detectors │ │Enrichers │ │ Actions  │ │Notifiers │
  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
```

### Module Categories

| Category    | Purpose                                    | Event Flow         |
|-------------|--------------------------------------------|--------------------|
| Connector   | Ingest external data (logs, metrics, APIs)  | → `log.ingested`   |
| Detector    | Analyse data and create incidents           | → `incident.created` |
| Enricher    | Add context, correlation, deduplication     | → `incident.updated` |
| Action      | Propose or execute safe remediation         | → `action.proposed` / `action.executed` |
| Notifier    | Deliver alerts to external channels         | (consumes events)  |
| UI          | Dashboards, APIs, real-time streaming       | (consumes events)  |

## Modules (27)

### Connectors
| Module | Description |
|--------|-------------|
| `connector.fileTail` | Tails log files with configurable polling |
| `connector.metrics` | Collects system metrics (CPU, memory, load) |
| `connector.healthCheck` | HTTP/TCP health checks for services |
| `connector.syslog` | RFC 5424 / RFC 3164 syslog receiver (UDP/TCP) |
| `connector.journald` | systemd journal log ingestion |
| `connector.kubernetes` | Kubernetes pod/event log ingestion |
| `connector.cloudwatch` | AWS CloudWatch Logs connector |

### Detectors
| Module | Description |
|--------|-------------|
| `detector.regex` | Pattern-matching incident detection with regex rules |
| `detector.threshold` | Static threshold detection with sliding windows |
| `detector.anomaly` | Statistical anomaly detection (Z-Score, MAD, IQR, EWMA) |

### Enrichers
| Module | Description |
|--------|-------------|
| `enricher.incidentStore` | Persists and manages incident lifecycle |
| `enricher.aiSummary` | AI-generated incident summaries with runbook matching |
| `enricher.correlator` | Groups related incidents by time and content similarity |
| `enricher.dedup` | Deduplicates incidents within configurable windows |

### Actions
| Module | Description |
|--------|-------------|
| `action.safe` | Gated action execution with approval tokens |
| `action.escalation` | Multi-level escalation with configurable policies |
| `action.runbook` | Automated runbook execution with step tracking |

### Notifiers
| Module | Description |
|--------|-------------|
| `notifier.channels` | Multi-channel dispatch (console, webhook, file) |
| `notifier.slack` | Slack integration with rich message formatting |
| `notifier.pagerduty` | PagerDuty incident creation and management |
| `notifier.teams` | Microsoft Teams webhook notifications |
| `notifier.email` | SMTP email notifications with HTML templates |

### UI & Integration
| Module | Description |
|--------|-------------|
| `ui.api` | REST API with rate limiting, Prometheus metrics, health/liveness/readiness probes |
| `ui.websocket` | Real-time WebSocket event streaming |
| `ui.dashboard` | Self-contained HTML dashboard with auto-refresh |
| `openclaw.tools` | OpenClaw AI tool registry bridge |

## Safety Model

The safety model is **non-negotiable**. AI never executes actions automatically:

```
AI Proposal → Human Review → Approval Token (15-min TTL) → Gated Execution → Audit Log
```

- All actions must be proposed, explained, and approved before execution
- Approval tokens expire after 15 minutes
- Every action is recorded in an immutable audit log
- Allowlists control which action types are permitted

## Getting Started

### Prerequisites

- **Node.js** ≥ 20.0.0
- **npm** (included with Node.js)

### Installation

```bash
npm install
```

### Build

```bash
npm run build
```

### Run

```bash
# Development (with ts-node)
npm run dev

# Production
npm start

# With interactive approval CLI
npm start -- --cli --operator your-name
```

### Test

```bash
npm test
```

816 tests across 219 suites — all passing.

### Type Check

```bash
npm run build          # Full compile
npm run test:check     # Type-check including test files
```

## Project Status

> **This project is a working architecture with real detection logic but significant production gaps.** The table below is an honest assessment of what's real, what's stubbed, and what's missing.

### What's Real (works end-to-end)

| Area | Status | Details |
|------|--------|---------|
| Core architecture | **Complete** | EventBus, config loader, module lifecycle, dependency resolver, plugin loader |
| Safety model | **Complete** | Approval gate, token TTL, audit logging, allowlist validation |
| `connector.fileTail` | **Complete** | Real file tailing with fs.watch polling |
| `connector.syslog` | **Complete** | Real UDP/TCP syslog with RFC 5424/3164 parsing |
| `connector.metrics` | **Complete** | Real `os` module metrics (CPU, memory, load average) |
| `detector.regex` | **Complete** | Regex pattern matching with cooldown and rate limiting |
| `detector.threshold` | **Complete** | Static threshold detection with sliding windows |
| `detector.anomaly` | **Complete** | Z-Score, MAD, IQR, EWMA — real statistical algorithms |
| `enricher.correlator` | **Complete** | Time + content similarity correlation |
| `enricher.dedup` | **Complete** | Deduplication with configurable windows |
| `ui.api` | **Complete** | Real HTTP REST API with JWT + API key auth, rate limiting, Prometheus `/metrics`, `/livez`, `/readyz` |
| `ui.websocket` | **Complete** | Real WebSocket streaming |
| `ui.dashboard` | **Complete** | Self-contained HTML dashboard |
| SQLite storage | **Complete** | Persistent storage via `better-sqlite3` (WAL mode, ACID) |
| JWT + API key auth | **Complete** | `AuthService` with HS256 JWT, constant-time API key comparison |
| Structured logging | **Complete** | JSON/text format, file output, size-based log rotation |
| Rate limiting | **Complete** | Per-client sliding-window rate limiter, `X-RateLimit-*` headers |
| Circuit breaker | **Complete** | Circuit breaker + retry with exponential backoff for outbound calls |
| Prometheus metrics | **Complete** | `/api/metrics` endpoint with module health, process, and custom gauges |
| LLM resilience | **Complete** | Response cache, retry, circuit breaker, fallback for AI providers |
| Containerization | **Complete** | Multi-stage Dockerfile, docker-compose, `.dockerignore`, non-root user |
| CI pipeline | **Complete** | GitHub Actions: lint → build → test (Node 20+22) → Docker build |
| Test suite | **Complete** | 816 tests, 219 suites, 0 failures |

### What's Stubbed (interface exists, implementation simulated)

| Area | Current State | What's Needed |
|------|---------------|---------------|
| `connector.kubernetes` | Simulates K8s API responses | Real `@kubernetes/client-node` SDK integration |
| `connector.cloudwatch` | Simulates CloudWatch API | Real AWS SDK (`@aws-sdk/client-cloudwatch-logs`) |
| `connector.journald` | Simulates `journalctl` output | Real child process spawning of `journalctl --follow` |
| `connector.healthCheck` | Uses `fetch` — works but basic | Needs retry logic, circuit breaker, TLS cert validation |
| `notifier.slack` | Builds correct payload, calls `fetch` | Needs Slack SDK, OAuth flow, rate limit handling |
| `notifier.pagerduty` | Builds correct payload, calls `fetch` | Needs PagerDuty SDK, event deduplication keys |
| `notifier.teams` | Builds Adaptive Card, calls `fetch` | Works for simple webhooks; needs Graph API for richer integration |
| `notifier.email` | Builds HTML email, uses raw SMTP | Needs `nodemailer` or similar for real SMTP with TLS/auth |
| `enricher.aiSummary` | Template fallback + resilient wrapper | Needs real API keys; retry/cache/circuit-breaker already wired |

### What's Missing Entirely

| Gap | Priority | Implementation Guide |
|-----|----------|---------------------|
| ~~**Database**~~ | ~~**High**~~ | **DONE** — `SQLiteStorage` engine implemented via `better-sqlite3`. Supports all 7 `IStorageEngine` methods. Set `storage.engine: sqlite` in config with `options.dbPath`. WAL mode, prepared statements, zero-config. |
| ~~**LLM Integration**~~ | ~~**High**~~ | **DONE** — `ResilientSummarizer` wraps OpenAI/Anthropic providers with response caching (LRU+TTL), retry with exponential backoff, circuit breaker, and automatic fallback to `TemplateSummarizer`. Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` env vars. |
| ~~**Authentication**~~ | ~~**High**~~ | **DONE** — JWT bearer tokens (HS256) + static API keys. `AuthService` in `src/core/security/AuthService.ts`. Set `auth.enabled: true` in config or use `OPSPILOT_JWT_SECRET` / `OPSPILOT_API_KEY` env vars. Public paths exempt (e.g. `/api/health`). Both REST API and Dashboard API endpoints protected. |
| ~~**Containerization**~~ | ~~**Medium**~~ | **DONE** — Multi-stage `Dockerfile` (node:20-alpine, non-root user, layer caching), `docker-compose.yml` with SQLite volume and health checks, `.dockerignore`, GitHub Actions CI pipeline. |
| ~~**Prometheus Metrics**~~ | ~~**Medium**~~ | **DONE** — `MetricsCollector` in `src/shared/metrics.ts` exposes `/api/metrics` with module health gauges, process metrics (uptime, heap, RSS), and custom counters in Prometheus text exposition format. |
| ~~**Error Recovery**~~ | ~~**Medium**~~ | **DONE** — `CircuitBreaker` (closed→open→half-open), `retryWithBackoff()` with jitter, `isRetryableHttpError()`. All wired into AI providers and available for all outbound calls. |
| ~~**Structured Logging**~~ | ~~**Low**~~ | **DONE** — `Logger` supports JSON/text format, file output, size-based log rotation (`maxFileSize`, `maxFiles`), child loggers, and `close()` lifecycle. |
| ~~**Rate Limiting (API)**~~ | ~~**Low**~~ | **DONE** — `KeyedRateLimiter` on REST API with per-client sliding window, `X-RateLimit-Limit`/`Remaining`/`Reset` headers, 429 responses. |

---

## Implementation Guides

### Storage Implementation Guide

> **Status: COMPLETE** — SQLite storage is fully implemented via `better-sqlite3`.

Three storage engines are available:

| Engine | Class | Use Case |
|--------|-------|----------|
| `memory` | `MemoryStorage` | Development/testing (volatile) |
| `file` | `FileStorage` | Simple persistence (JSON files) |
| `sqlite` | `SQLiteStorage` | **Production** (WAL mode, prepared statements, ACID) |

**To enable SQLite persistence:**

```yaml
# config/default.yaml
storage:
  engine: sqlite
  options:
    dbPath: ./data/opspilot.db
```

The `SQLiteStorage` engine:
- Implements all 7 `IStorageEngine` methods (`get`, `set`, `delete`, `list`, `has`, `count`, `clear`)
- Uses a single `opspilot_kv` table with `(collection, key)` composite primary key
- Values stored as JSON text, parsed on retrieval
- WAL journal mode for concurrent read performance
- Prepared statements for query efficiency
- Auto-creates parent directories for the DB file
- Supports `:memory:` mode for in-memory SQLite (testing)

**To add PostgreSQL** (future):

Follow the same `IStorageEngine` interface pattern. See `src/core/storage/SQLiteStorage.ts` for reference. Add a `case 'postgres'` to `Application.ts → createStorageEngine()`.

---

### LLM Integration Guide

The provider interface already exists in `src/modules/enricher.aiSummary/providers.ts`. The `OpenAISummarizer` and `AnthropicSummarizer` classes make real `fetch` calls but need:

1. **API key configuration** — Add to `config/default.yaml`:
   ```yaml
   enricher.aiSummary:
     provider: openai          # or 'anthropic'
     model: gpt-4o
     apiKey: ${OPENAI_API_KEY}  # Use env var, never commit keys
     maxTokens: 500
   ```

2. **Environment variable** — Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

3. **What's already implemented**: prompt construction, JSON response parsing, runbook matching, confidence scoring.

4. **What's already implemented (Phase 29)**:
   - `ResilientSummarizer` wraps providers with cache → circuit breaker → retry → fallback
   - Response caching (LRU with configurable TTL) to avoid duplicate API calls
   - Retry with exponential backoff on 429/5xx errors
   - Circuit breaker (threshold + reset timeout) with automatic fallback to template
   - Resilience event callbacks for observability

5. **What's still needed**:
   - Streaming support for large responses
   - Token counting / cost tracking
   - Embedding-based runbook matching (currently keyword-only)

---

### Auth Implementation Guide

> **Status: COMPLETE** — JWT + API key authentication is fully implemented.

**Quick start (environment variables):**
```bash
# Set a JWT secret to enable token-based auth
export OPSPILOT_JWT_SECRET="your-256-bit-secret-here"

# Or use a static API key
export OPSPILOT_API_KEY="sk-your-api-key-here"
```

Then enable auth in config:
```yaml
# config/default.yaml
auth:
  enabled: true
  # jwtSecret: "..."           # or set OPSPILOT_JWT_SECRET env var
  # jwtExpiresIn: "8h"         # token lifetime
  # jwtIssuer: "opspilot"      # JWT issuer claim
  publicPaths:
    - /api/health              # exempt from auth (load balancer probes)
  apiKeys:
    - label: ci-pipeline
      key: sk-your-key-here
      role: operator           # admin | operator | viewer
```

**Authentication methods (checked in order):**
1. `Authorization: Bearer <jwt>` — JWT with `sub` and `role` claims (HS256)
2. `X-API-Key: <key>` — static API key from config

**Roles:** `admin` (full access), `operator` (read + approve/deny), `viewer` (read-only)

**Architecture:**
- `AuthService` → `src/core/security/AuthService.ts` — core auth logic
- Auth types → `src/core/types/auth.ts` — `IAuthService`, `AuthIdentity`, `AuthConfig`
- Middleware integrated into both `ui.api` and `ui.dashboard` `handleRequest()`
- Constant-time API key comparison (HMAC-based) to prevent timing attacks
- `AuditLogger` can record auth events

---

### Container Guide

> **Status: COMPLETE** — Real `Dockerfile` and `docker-compose.yml` are in the project root.

```bash
# Build and run with Docker Compose
docker compose up -d --build

# Follow logs
docker compose logs -f

# Check health
curl http://localhost:3000/api/health
curl http://localhost:3000/api/livez
curl http://localhost:3000/api/readyz

# Prometheus metrics
curl http://localhost:3000/api/metrics

# Stop
docker compose down
```

The Dockerfile uses a multi-stage build (builder → production), runs as a non-root `opspilot` user, prunes dev dependencies, and includes a `HEALTHCHECK` directive. SQLite data is persisted via the `opspilot-data` Docker volume.

---

### Observability Guide

> **Status: COMPLETE** — Prometheus metrics are exposed at `GET /api/metrics`.

The `MetricsCollector` class (`src/shared/metrics.ts`) automatically collects:
- Module health status as Prometheus gauges
- Process metrics: uptime, heap used/total, RSS, external memory
- Custom counters (e.g. HTTP request counts by method + status)

```bash
# Scrape metrics
curl http://localhost:3000/api/metrics

# Example output:
# HELP opspilot_module_healthy Module health status (1=healthy, 0=unhealthy)
# TYPE opspilot_module_healthy gauge
opspilot_module_healthy{module="detector.regex"} 1
opspilot_module_healthy{module="enricher.aiSummary"} 1
# HELP opspilot_process_uptime_seconds Process uptime
# TYPE opspilot_process_uptime_seconds gauge
opspilot_process_uptime_seconds 3842.71
```

## Configuration

All behaviour is controlled via `config/default.yaml`. Modules are enabled/disabled individually:

```yaml
system:
  name: OpsPilot
  environment: development

modules:
  connector.fileTail:
    enabled: true
    path: ./logs/sample.log
    pollIntervalMs: 1000

  detector.regex:
    enabled: true
    maxIncidentsPerMinute: 30
    rules:
      - id: error-generic
        pattern: "\\bERROR\\b"
        severity: critical
        title: "Error detected in logs"
        cooldownMs: 5000

  detector.anomaly:
    enabled: false
    metrics:
      - id: cpu-anomaly
        name: "CPU Usage Anomaly"
        pattern: "cpu_usage"
        valuePattern: "cpu_usage[=:](\\d+\\.?\\d*)"
        method: zscore          # zscore | mad | iqr | ewma
        sensitivity: 3.0
        direction: both         # both | high | low
        trainingWindowSize: 100
        minTrainingSamples: 20
```

Environment variables override config values using the `OPSPILOT_*` prefix.

## Project Structure

```
├── .github/
│   └── workflows/
│       └── ci.yml             # GitHub Actions CI pipeline
├── config/
│   └── default.yaml          # Default configuration
├── Dockerfile                 # Multi-stage container build
├── docker-compose.yml         # Container orchestration
├── .dockerignore              # Docker build exclusions
├── src/
│   ├── core/                  # Core subsystems (bus, config, storage, security)
│   │   ├── bus/               # EventBus implementation
│   │   ├── config/            # YAML config loader + JSON Schema validation
│   │   ├── modules/           # Module lifecycle manager + dependency resolver
│   │   ├── security/          # Approval gate + audit logger + AuthService
│   │   ├── storage/           # Memory, file, and SQLite storage engines
│   │   ├── openclaw/          # OpenClaw tool registry
│   │   ├── plugins/           # Dynamic plugin loader
│   │   ├── types/             # Core type definitions
│   │   └── Application.ts     # Application bootstrap
│   ├── modules/               # All feature modules (27)
│   │   ├── connector.*/       # Data ingestion modules
│   │   ├── detector.*/        # Incident detection modules
│   │   ├── enricher.*/        # Context enrichment modules
│   │   ├── action.*/          # Remediation action modules
│   │   ├── notifier.*/        # Alert notification modules
│   │   ├── ui.*/              # UI and API modules
│   │   └── openclaw.tools/    # OpenClaw bridge
│   ├── shared/                # Shared types and utilities
│   ├── cli/                   # Interactive approval CLI
│   └── main.ts                # Entry point
├── tests/                     # Test suites (45 test files, 816 tests)
└── .docs/                     # Architecture documentation
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript 5.7+ (strict mode) |
| Runtime | Node.js ≥ 20 |
| Config | YAML with JSON Schema validation (ajv) |
| Testing | Node.js built-in test runner (`node:test` + `node:assert/strict`) |
| Build | `tsc` (target ES2022, CommonJS) |
| Dependencies | 4 production deps (`ajv`, `yaml`, `better-sqlite3`, `jsonwebtoken`) |
| Containerization | Multi-stage Dockerfile, docker-compose, non-root |
| CI/CD | GitHub Actions (Node 20+22, Docker build on main) |

## License

MIT
