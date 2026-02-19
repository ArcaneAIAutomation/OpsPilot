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
| `ui.api` | REST API for incidents, approvals, and health |
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

573 tests across 171 suites — all passing.

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
| `ui.api` | **Complete** | Real HTTP REST API (no auth — see below) |
| `ui.websocket` | **Complete** | Real WebSocket streaming |
| `ui.dashboard` | **Complete** | Self-contained HTML dashboard |
| Test suite | **Complete** | 573 tests, 171 suites, 0 failures |

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
| `enricher.aiSummary` | Template engine fallback only | Needs real LLM integration (see below) |

### What's Missing Entirely

| Gap | Priority | Implementation Guide |
|-----|----------|---------------------|
| **Database** | **High** | Storage interface (`IStorageEngine`) is ready. Implement `PostgresStorage` or `SQLiteStorage` conforming to `get/set/delete/list/has`. See [Storage Implementation Guide](#storage-implementation-guide). |
| **LLM Integration** | **High** | Provider interface (`ISummarizer`) exists with `openai` and `anthropic` providers stubbed in `enricher.aiSummary/providers.ts`. Needs real API key handling, streaming, error recovery. See [LLM Integration Guide](#llm-integration-guide). |
| **Authentication** | **High** | REST API (`ui.api`) has zero auth. Needs JWT or API key middleware on all endpoints. See [Auth Implementation Guide](#auth-implementation-guide). |
| **Containerization** | **Medium** | No Dockerfile, docker-compose, or Helm chart. See [Container Guide](#container-guide). |
| **Prometheus Metrics** | **Medium** | No `/metrics` endpoint. Modules track internal counters but don't export them. See [Observability Guide](#observability-guide). |
| **Error Recovery** | **Medium** | No circuit breakers, retry-with-backoff, or dead letter queues for failed deliveries. |
| **Structured Logging** | **Low** | Logger exists but outputs human-readable text. Needs JSON structured output for production. |
| **Rate Limiting (API)** | **Low** | EventBus-level rate limits exist but the HTTP API has none. |

---

## Implementation Guides

### Storage Implementation Guide

The `IStorageEngine` interface in `src/core/types/storage.ts` defines 5 methods: `get`, `set`, `delete`, `list`, `has`. Currently only `MemoryStorage` (volatile) and `FileStorage` (JSON files) exist.

**To add PostgreSQL:**

```bash
npm install pg
```

```typescript
// src/core/storage/PostgresStorage.ts
import { Pool } from 'pg';
import { IStorageEngine, StorageFilter } from '../types/storage';

export class PostgresStorage implements IStorageEngine {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    const { rows } = await this.pool.query(
      'SELECT value FROM opspilot_kv WHERE collection = $1 AND key = $2',
      [collection, key],
    );
    return rows[0]?.value as T | undefined;
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    await this.pool.query(
      `INSERT INTO opspilot_kv (collection, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (collection, key) DO UPDATE SET value = $3, updated_at = NOW()`,
      [collection, key, JSON.stringify(value)],
    );
  }

  // ... implement delete, list, has
}
```

**Required table:**
```sql
CREATE TABLE opspilot_kv (
  collection VARCHAR(255) NOT NULL,
  key VARCHAR(255) NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (collection, key)
);
CREATE INDEX idx_opspilot_kv_collection ON opspilot_kv (collection);
```

**Wire it in** `src/core/Application.ts` — replace `new MemoryStorage()` with `new PostgresStorage(config.database.url)`.

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

4. **What's needed**:
   - Streaming support for large responses
   - Token counting / cost tracking
   - Retry with exponential backoff on 429/500
   - Response caching to avoid duplicate API calls
   - Embedding-based runbook matching (currently keyword-only)

---

### Auth Implementation Guide

The REST API in `src/modules/ui.api/index.ts` has no authentication. To add JWT auth:

1. **Install**: `npm install jsonwebtoken`
2. **Add middleware** in the `handleRequest` method before routing:
   ```typescript
   private authenticate(req: http.IncomingMessage): boolean {
     const auth = req.headers.authorization;
     if (!auth?.startsWith('Bearer ')) return false;
     try {
       jwt.verify(auth.slice(7), this.config.jwtSecret);
       return true;
     } catch { return false; }
   }
   ```
3. **Add config**: `jwtSecret`, `authEnabled` to the `ui.api` schema
4. **Skip auth** for health endpoints if desired

---

### Container Guide

```dockerfile
# Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json config/ ./config/
EXPOSE 3000 3001
CMD ["node", "dist/main.js"]
```

```yaml
# docker-compose.yml
services:
  opspilot:
    build: .
    ports:
      - "3000:3000"   # REST API
      - "3001:3001"   # Dashboard
    environment:
      - OPSPILOT_SYSTEM_ENVIRONMENT=production
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    volumes:
      - ./config:/app/config
      - ./logs:/app/logs

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: opspilot
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

---

### Observability Guide

To export Prometheus metrics, add a `/metrics` endpoint to `ui.api`:

```typescript
// Each module already tracks internal counters via health().details
// Collect them and format as Prometheus text exposition:
private serveMetrics(res: http.ServerResponse): void {
  const lines: string[] = [];
  const healths = this.deps.getModuleHealths();
  for (const [id, h] of Object.entries(healths)) {
    const prefix = id.replace(/\./g, '_');
    if (h.details) {
      for (const [k, v] of Object.entries(h.details)) {
        if (typeof v === 'number') {
          lines.push(`opspilot_${prefix}_${k} ${v}`);
        }
      }
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(lines.join('\n') + '\n');
}
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
├── config/
│   └── default.yaml          # Default configuration
├── src/
│   ├── core/                  # Core subsystems (bus, config, storage, security)
│   │   ├── bus/               # EventBus implementation
│   │   ├── config/            # YAML config loader + JSON Schema validation
│   │   ├── modules/           # Module lifecycle manager + dependency resolver
│   │   ├── security/          # Approval gate + audit logger
│   │   ├── storage/           # In-memory + file-based storage
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
├── tests/                     # Test suites (35 test files)
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
| Dependencies | 2 production deps (`ajv`, `yaml`) |

## License

MIT
