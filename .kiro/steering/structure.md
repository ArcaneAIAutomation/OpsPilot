# OpsPilot Project Structure

## Top-Level Layout

```
├── .github/
│   └── workflows/
│       └── ci.yml      # GitHub Actions CI pipeline
├── config/              # YAML configuration files
├── Dockerfile           # Multi-stage container build
├── docker-compose.yml   # Container orchestration
├── .dockerignore        # Docker build exclusions
├── src/                 # All TypeScript source code
│   ├── core/           # Core framework (never contains business logic)
│   ├── modules/        # All feature modules (27 modules)
│   ├── shared/         # Shared utilities and types
│   ├── cli/            # Interactive approval CLI
│   ├── main.ts         # Application entry point
│   └── index.ts        # Public API exports
├── tests/              # Test suites (816 tests, 219 suites, 45 test files)
├── dist/               # Compiled JavaScript output (gitignored)
├── logs/               # Runtime log files
└── .docs/              # Architecture documentation
```

## Core Framework (`src/core/`)

The core is small, stable, and contains zero business logic:

```
core/
├── types/              # Type definitions and interfaces
│   ├── events.ts       # Event bus types
│   ├── module.ts       # IModule interface, lifecycle enums
│   ├── config.ts       # Configuration types
│   ├── storage.ts      # Storage engine interfaces
│   ├── security.ts     # Approval gate, audit logger types
│   ├── auth.ts         # Authentication types (IAuthService, AuthIdentity, AuthConfig)
│   ├── openclaw.ts     # OpenClaw tool registry types
│   └── index.ts        # Barrel export
├── bus/                # Event bus implementation
├── config/             # Config loader + JSON Schema validator
├── modules/            # Module lifecycle manager + dependency resolver
├── storage/            # Storage engines (Memory, File, SQLite, Namespaced)
├── security/           # Approval gate + audit logger + AuthService (JWT + API key)
├── openclaw/           # Tool registry for AI agent integration
├── plugins/            # Dynamic plugin loader
└── Application.ts      # Composition root, wires everything together
```

## Module Organization (`src/modules/`)

Every module follows this structure:

```
modules/
└── <category>.<name>/
    ├── index.ts        # IModule implementation
    ├── schema.json     # JSON Schema for config validation
    └── README.md       # Documentation (optional)
```

Module naming convention: `<category>.<name>`

- `connector.*` - Data ingestion (7 modules)
- `detector.*` - Incident detection (3 modules)
- `enricher.*` - Context enrichment (4 modules)
- `action.*` - Remediation actions (3 modules)
- `notifier.*` - Alert delivery (5 modules)
- `ui.*` - User interfaces (3 modules)
- `openclaw.*` - AI tool bridges (1 module)

## Shared Utilities (`src/shared/`)

```
shared/
├── errors.ts           # Typed error hierarchy
├── events.ts           # Event payload types
├── logger.ts           # Structured logger (JSON/text, file output, rotation)
├── rate-limiter.ts     # Sliding-window rate limiter (single + keyed)
├── circuit-breaker.ts  # Circuit breaker (closed → open → half-open)
├── retry.ts            # Retry with exponential backoff + jitter
├── metrics.ts          # Prometheus metrics collector
├── utils.ts            # generateId, sleep, deepFreeze
└── index.ts            # Barrel export
```

## Test Organization (`tests/`)

Tests mirror the source structure:

```
tests/
├── helpers.ts                  # Shared test utilities
├── eventbus.test.ts            # Core event bus tests
├── storage.test.ts             # Storage engine tests (Memory, File, Namespaced)
├── sqlite-storage.test.ts      # SQLite storage engine tests
├── auth.test.ts                # AuthService unit tests (JWT + API key)
├── auth-integration.test.ts    # Auth integration tests (REST API + Dashboard)
├── module-*.test.ts            # Module-specific tests
├── integration.test.ts         # End-to-end pipeline tests
└── ... (45 test files total)
```

Test naming: `<feature>.test.ts`

## Configuration Files (`config/`)

```
config/
├── default.yaml        # Default configuration for all modules
└── test.yaml           # Test-specific overrides
```

Configuration structure mirrors module IDs:

```yaml
system:
  name: OpsPilot
  environment: development

modules:
  connector.fileTail:
    enabled: true
    path: ./logs/sample.log
  
  detector.regex:
    enabled: true
    rules: [...]
```

## Module Implementation Pattern

Every module must:

1. Export a class implementing `IModule`
2. Provide a static `manifest` property
3. Implement 5 lifecycle methods: `initialize()`, `start()`, `stop()`, `destroy()`, `health()`
4. Include a `schema.json` for config validation
5. Never import other modules directly - use EventBus only

Example minimal module:

```typescript
import { IModule, ModuleManifest, ModuleContext, ModuleHealth, ModuleType } from '@core/types';

export class MyModule implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'category.mymodule',
    name: 'My Module',
    version: '1.0.0',
    type: ModuleType.Connector,
    dependencies: [],
  };

  async initialize(context: ModuleContext): Promise<void> { /* ... */ }
  async start(): Promise<void> { /* ... */ }
  async stop(): Promise<void> { /* ... */ }
  async destroy(): Promise<void> { /* ... */ }
  health(): ModuleHealth { /* ... */ }
}
```

## Critical Rules

- **Core never imports modules**: Dependency flow is always core → modules
- **Modules never import each other**: Use EventBus for all inter-module communication
- **One module per directory**: Each module is self-contained
- **Config validation required**: Every module must have schema.json
- **Tests are mandatory**: New modules require corresponding test files
