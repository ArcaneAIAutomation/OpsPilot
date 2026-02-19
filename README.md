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
