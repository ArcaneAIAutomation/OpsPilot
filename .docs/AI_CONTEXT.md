OpsPilot — AI Development Context



You are assisting in the development of OpsPilot, a modular AI-powered Operations Agent designed to monitor systems, detect incidents, explain problems clearly, and safely assist humans in resolving operational issues.



Your role is to act as a senior systems engineer and architecture guardian, not a rapid prototype generator.



CORE PROJECT PURPOSE



OpsPilot exists to solve a real problem:



Modern systems produce overwhelming logs and alerts.

Humans struggle to understand what is actually wrong.



OpsPilot converts:



RAW SIGNAL → INCIDENT → UNDERSTANDING → SAFE ACTION



The system must always prioritize:



clarity



safety



modularity



observability



human approval



This is NOT an experimental AI toy.

This is production-grade operational software.



PRIMARY DESIGN PRINCIPLES

1\. Modular First Architecture



Everything outside the core MUST be a module.



Modules must:



be independently enabled/disabled



never tightly couple to other modules



communicate only through the core event bus



fail safely without crashing the system



The core must remain small and stable.



2\. Core Responsibilities ONLY



The core system handles:



configuration loading \& validation



module lifecycle management



dependency resolution



internal event bus



storage abstraction



audit logging



security \& approval gates



OpenClaw integration bridge



The core NEVER contains business logic.



3\. Module Categories



Modules may implement one or more capabilities:



Connector → ingest external data



Detector → create incidents



Enricher → add context/intelligence



Notifier → communicate results



Action → propose or execute safe actions



OpenClaw Tool → expose agent functions



UI Extension → extend dashboard



Modules MUST NOT call each other directly.



All communication happens via events.



4\. Event Driven System



Modules interact through events such as:



log.ingested



incident.created



incident.updated



action.proposed



action.approved



action.executed



Events must be strongly typed.



No direct imports between modules.



5\. Safety Model (CRITICAL)



AI NEVER executes actions automatically.



All actions must:



be proposed



be explained



require approval



pass allowlist validation



be audited



Security and auditability are first-class concerns.



6\. OpenClaw Compatibility



OpsPilot runs as an OpenClaw plugin.



Requirements:



tools register dynamically from enabled modules



disabling a module removes its tools



tools must be deterministic and safe



actions require approval tokens



OpenClaw is treated as an interface layer, not core logic.



7\. Configuration Philosophy



Users control behavior via configuration.



Example:



modules:

&nbsp; connector.fileTail:

&nbsp;   enabled: true



Modules must validate configuration using JSON Schema.



Invalid configuration must NOT crash OpsPilot.



8\. Code Quality Expectations



Always prefer:



small composable files



explicit typing



dependency injection



predictable lifecycle methods



Avoid:



global state



hidden side effects



circular dependencies



monolithic services



9\. Performance Philosophy



OpsPilot is long-running infrastructure software.



Therefore:



streaming over batching



async event handling



backpressure awareness



graceful degradation



System stability is more important than speed.



10\. AI Usage Rules



AI components are used ONLY for:



summarization



reasoning



classification



explanation



AI must NEVER:



control execution directly



bypass approval gates



modify configuration automatically



EXPECTED REPOSITORY STRUCTURE

src/

&nbsp; core/

&nbsp; modules/

&nbsp; shared/

skills/

docs/



Each module contains:



index.ts



schema.json



README.md



tests/



HOW YOU SHOULD ASSIST



When generating code:



Respect modular boundaries.



Prefer extending via modules instead of modifying core.



Ask: “Should this be a module?”



Maintain OpenClaw compatibility.



Preserve safety and auditability.



If a request violates architecture, suggest a modular alternative.



ENGINEERING MINDSET



Assume this project will become:



a real operations platform



used by schools, developers, and infrastructure teams



extended by third-party modules



Design for longevity, not shortcuts.



---



BUILD STATUS & IMPLEMENTATION LOG



Phase 1 — Core Framework ✅ COMPLETE



Date: February 18, 2026



What was built:



Core Type System (src/core/types/)

- events.ts — OpsPilotEvent<T>, EventHandler, EventSubscription, IEventBus

- module.ts — IModule, ModuleManifest, ModuleContext, ModuleState enum, ModuleType enum, ILogger

- config.ts — OpsPilotConfig, SystemConfig, ModuleConfig, LoggingConfig, StorageConfig

- storage.ts — IStorageEngine, INamespacedStorage, StorageFilter

- security.ts — IApprovalGate, IAuditLogger, ApprovalRequest, ApprovalToken, ApprovalStatus, AuditEntry



EventBus (src/core/bus/)

- EventBus.ts — Async pub/sub with Promise.allSettled, concurrent handler execution, one-shot subscriptions, per-type listener maps. Errors in handlers are logged but never crash the bus.



Configuration (src/core/config/)

- ConfigLoader.ts — YAML file loading, deep-merge with defaults, OPSPILOT_* env overrides

- ConfigValidator.ts — Root schema validation + per-module JSON Schema validation via Ajv



Module System (src/core/modules/)

- DependencyResolver.ts — Topological sort (Kahn's algorithm), cycle detection, missing-dep detection

- ModuleLoader.ts — Factory-based module registration and instantiation

- ModuleRegistry.ts — Full lifecycle management (register → init → start → stop → destroy), state machine, scoped ModuleContext creation, lifecycle event emission



Storage (src/core/storage/)

- MemoryStorage.ts — In-memory Map-based storage engine (dev/test backend)

- NamespacedStorage.ts — Module-scoped storage wrapper (prefixes collections with moduleId)



Security (src/core/security/)

- AuditLogger.ts — Append-only audit trail with query/filter support

- ApprovalGate.ts — Full safety workflow: request → approve/deny → token generation → validation. 15-minute TTL on tokens. All decisions audit-logged.



Shared Utilities (src/shared/)

- errors.ts — Typed error hierarchy: OpsPilotError, ConfigError, ModuleError, DependencyError, SecurityError, StorageError

- logger.ts — Structured logger with JSON/text output, log levels, child logger prefixing

- utils.ts — generateId (crypto UUID), sleep, deepFreeze



Application Bootstrap (src/core/Application.ts)

- Composition root wiring all subsystems together

- Full startup sequence: config → validate → bus → storage → audit → approval → loader → registry → init → start

- Graceful shutdown via SIGINT/SIGTERM with reverse-order teardown

- ApplicationState enum for lifecycle tracking



Entry Point & Config

- src/main.ts — CLI entry point

- config/default.yaml — Default YAML configuration



Key architectural decisions:

- Modules receive a ModuleContext (bus, storage, logger, approval gate) — never import core directly

- NamespacedStorage prevents cross-module data access by design

- EventBus uses Promise.allSettled — a failing handler never blocks other handlers

- DependencyResolver uses Kahn's algorithm for deterministic startup ordering

- All approval decisions generate audit entries automatically

- Lifecycle state transitions emit module.lifecycle events on the bus



Dependencies:

- ajv ^8.17.1 — JSON Schema validation

- yaml ^2.7.0 — YAML config parsing

- TypeScript ^5.7.0, Node.js ≥20



What is NOT built yet:

- Phase 2: First connector module (file log ingestion) ✅ DONE
- Phase 3: First detector module (regex incident detection) ✅ DONE
- Phase 4: Incident storage + audit trail queries ✅ DONE
- Phase 5: OpenClaw tool exposure ✅ DONE
- Phase 6: Safe action approval workflow (end-to-end) ✅ DONE
- Phase 7: AI summarization (RAG + runbooks) ✅ DONE
- No test suite yet
- OpenClaw bridge implementation ✅ DONE



Phase 2 — File Tail Connector ✅ COMPLETE



Date: February 18, 2026



What was built:



Shared Event Payload Types (src/shared/events.ts)

- LogIngestedPayload — canonical shape for log.ingested events

- IncidentCreatedPayload, IncidentUpdatedPayload — for detector modules

- ActionProposedPayload, ActionApprovedPayload, ActionExecutedPayload — for action safety flow

- EnrichmentCompletedPayload — for enricher modules

- All payload types live in shared/ so modules can import them without depending on each other



connector.fileTail Module (src/modules/connector.fileTail/)

- index.ts — Full IModule implementation: reference module for the project

- schema.json — JSON Schema for config validation (path, encoding, pollIntervalMs, fromBeginning, maxLineLength)

- README.md — Documentation with config reference, events produced, lifecycle, design notes



How it works:

- Uses fs.watch for OS-level file change notifications

- Falls back to configurable polling interval if fs.watch is unavailable

- Tracks byte offset across reads — only reads new data

- Handles log rotation: detects file truncation, resets offset to 0, re-establishes watcher

- Emits log.ingested event per non-empty line via the event bus

- Lines exceeding maxLineLength are truncated (not dropped)

- Health reporting includes path, byteOffset, linesIngested

- File not existing at start is a warning, not a failure (file may be created later)



Smoke test results:

- Full lifecycle confirmed: registered → initializing → initialized → starting → running

- Graceful shutdown confirmed: SIGINT → stopping → stopped → destroyed

- Config validation via JSON Schema working

- Module appears in dependency order resolution



What is NOT built yet:

- Phase 3: First detector module (regex incident detection) ✅ DONE
- Phase 4-7: All complete ✅ DONE
- No test suite yet
- OpenClaw bridge implementation ✅ DONE



Phase 3 — Regex Incident Detector ✅ COMPLETE



Date: February 18, 2026



What was built:



detector.regex Module (src/modules/detector.regex/)

- index.ts — Subscribes to log.ingested, runs regex rules, emits incident.created

- schema.json — JSON Schema for rules array, severity, cooldown, rate limit

- README.md — Full documentation with config reference and design notes



Key features:

- Regex patterns compiled once at initialization (not per-line)

- Per-rule cooldown prevents alert storms from repeated matching

- Global rate limit (maxIncidentsPerMinute) as safety valve

- Description templates with $0-$9 capture group interpolation

- Disabled rules skipped at zero runtime cost

- Invalid regex patterns fail at init, not at runtime

- Incidents include full context: ruleId, pattern, matchedLine, captureGroups, logSource



Connector → Detector pipeline fix:

- Added setImmediate deferral in connector.fileTail start() for fromBeginning mode

- Ensures all modules complete start() before events flow

- Without this, the connector would emit events before the detector subscribes



End-to-end smoke test verified:

- 5 log lines ingested from sample.log

- 3 incidents created: 1 warning (high memory 87%), 2 critical (ERROR lines)

- Correct rules matched with correct severity

- Cooldown and rate limiting functional



Current module registry:

- connector.fileTail v0.1.0 (Connector)

- detector.regex v0.1.0 (Detector)



What is NOT built yet:

- No test suite yet (unit tests / integration tests)

- No CLI interface for approving/denying actions
- No persistent storage engine (file/DB) — memory only
- No real AI API integration (template provider only)
- No UI extension modules



Phase 4 — Incident Store ✅ COMPLETE



Date: February 18, 2026



What was built:



enricher.incidentStore Module (src/modules/enricher.incidentStore/)

- index.ts — Central incident persistence and query engine

- schema.json — JSON Schema for maxIncidents, retentionMs



How it works:

- Subscribes to incident.created events from any detector

- Persists incidents into namespaced storage with full structure:

  - StoredIncident: id, title, description, severity, detectedBy, sourceEvent,

    detectedAt, createdAt, status, context, enrichments, timeline

  - TimelineEntry: timestamp, action, actor, details

- Subscribes to enrichment.completed events to attach enrichment data to existing incidents

- Emits incident.updated when enrichments are attached or status changes

- Provides public query API: getIncident(), listIncidents(), updateStatus(), getSummary()

- Enforces retention (configurable maxIncidents + retentionMs)

- Sorts by createdAt descending for listings, supports severity/status/limit filters



Phase 5 — OpenClaw Tool Exposure ✅ COMPLETE



Date: February 18, 2026



What was built:



Core OpenClaw Types (src/core/types/openclaw.ts)

- OpenClawTool — tool definition (name, description, registeredBy, inputSchema, requiresApproval, tags)

- ToolResult — execution result (success, data, error)

- ToolInvocation — invocation request (toolName, params, invokedBy, approvalToken)

- ToolHandler — handler function type

- IToolRegistry — registry interface (register, unregister, getTool, listTools, invoke)



ToolRegistry (src/core/openclaw/ToolRegistry.ts)

- Central registry for all module-registered tools

- JSON Schema input validation via Ajv before execution

- Approval token enforcement: tools with requiresApproval=true MUST have a valid token

- Full audit logging of every invocation (invoked, succeeded, failed, error)

- Injected into Application as a core subsystem



openclaw.tools Module (src/modules/openclaw.tools/)

- index.ts — Registers 6 core operational tools:

  1. incidents.list — List incidents (read-only, no approval)

  2. incidents.get — Get single incident by ID (read-only)

  3. incidents.summary — Aggregate statistics (read-only)

  4. incidents.updateStatus — Change incident status (REQUIRES APPROVAL)

  5. actions.propose — Propose an action for human approval

  6. audit.query — Query the audit trail (read-only)

- schema.json — Module config schema

- Uses dependency injection: ToolRegistry + IncidentStore injected before init



Application changes:

- Added ToolRegistry construction (after ApprovalGate)

- Added getToolRegistry() accessor

- Added onPreInit() hook system for dependency injection before module init

- Renumbered boot phases: 1-Config, 2-Logger, 3-Core, 4-ModuleLoader, 5-PreInitHooks, 6-Registry, 7-Init+Start, 8-Shutdown



Phase 6 — Safe Action Approval Workflow ✅ COMPLETE



Date: February 18, 2026



What was built:



action.safe Module (src/modules/action.safe/)

- index.ts — Full end-to-end approval workflow

- schema.json — JSON Schema for autoPropose, proposalDelaySec, actions array



How it works — the NON-NEGOTIABLE safety pipeline:

1. Subscribes to incident.created events

2. Matches incidents against configurable action rules (severity + optional regex pattern)

3. PROPOSES actions via ApprovalGate.requestApproval() — NEVER auto-executes

4. Tracks pending proposals with requestId → {rule, incidentId} mapping

5. Subscribes to action.approved events

6. Validates approval token via ApprovalGate.validateToken() (mandatory check)

7. Executes action ONLY with valid, non-expired token

8. Emits action.executed event with result (success/failure)

9. Full audit trail at every step



Configurable action rules:

- id, actionType, description, triggerSeverity array, optional triggerPattern regex

- command field for future sandboxed execution

- per-rule enable/disable

- proposalDelaySec: configurable delay before proposing (allows enrichment to arrive first)

- autoPropose toggle: can be disabled to only respond to manual proposals



Safety enforcement:

- Token validation is mandatory before every execution

- Invalid/expired tokens result in immediate rejection with audit logging

- Simulated execution in MVP (logs command, does not run arbitrary code)

- Production path: sandboxed executors with restricted permissions



Phase 7 — AI Summarization ✅ COMPLETE



Date: February 18, 2026



What was built:



enricher.aiSummary Module (src/modules/enricher.aiSummary/)

- index.ts — AI-powered incident enrichment with pluggable provider architecture

- schema.json — JSON Schema for provider, model, maxTokens, includeRunbook, runbooks array



Provider abstraction:

- ISummarizer interface: summarize(incident, runbooks) → SummaryResult

- SummaryResult: summary, rootCauseHypothesis, severityReasoning, suggestedRunbooks, confidence

- TemplateSummarizer: deterministic template-based (no external API, always available)

- ExternalAISummarizer: stub for OpenAI/Anthropic API integration (falls back to template)



Template summarizer capabilities:

- Structured summary with incident details, source, matched line

- Root cause hypothesis based on keyword analysis (error, memory, cpu, disk, timeout, connection)

- Severity classification reasoning

- RAG-style runbook matching via keyword overlap against incident text

- Confidence scoring: 0.7 with runbook matches, 0.4 without, 0.3 for unconfigured external providers



Event flow:

- Subscribes to incident.created

- Generates SummaryResult

- Emits enrichment.completed with ai-summary enrichment type

- IncidentStore receives enrichment.completed and attaches data to the stored incident

- Full pipeline: incident → summary + runbook lookup → enrichment → stored on incident



Runbook configuration:

- Embedded in YAML config as structured objects (id, title, keywords, steps)

- Default config includes 4 runbooks: memory, cpu, disk, application error

- Keywords are matched case-insensitively against incident title + description

- Steps are ordered remediation instructions



End-to-End Pipeline — ALL PHASES COMPLETE ✅



Date: February 18, 2026



Full verified pipeline (smoke test with test.yaml):



1. connector.fileTail (v0.1.0) — Reads 5 log lines from sample.log

2. detector.regex (v0.1.0) — Creates 3 incidents (1 warning, 2 critical)

3. enricher.aiSummary (v0.1.0) — Generates summaries for all 3 incidents (confidence=0.7, 1 runbook match each)

4. enricher.incidentStore (v0.1.0) — Stores all 3 incidents, attaches AI enrichments

5. action.safe (v0.1.0) — Proposes 5 remediation actions (restart.service for critical, notify.team for all)

6. openclaw.tools (v0.1.0) — Registers 6 tools for external consumption



Event flow verified:

- log.ingested → 1 subscriber (detector.regex)

- incident.created → 3 subscribers (enricher.aiSummary, enricher.incidentStore, action.safe)

- enrichment.completed → 1 subscriber (enricher.incidentStore)

- action.requested → audit logged

- action.proposed → emitted by ApprovalGate



Module startup order (dependency-resolved):

action.safe → connector.fileTail → detector.regex → enricher.aiSummary → enricher.incidentStore → openclaw.tools



Current module registry:

- connector.fileTail v0.1.0 (Connector)

- detector.regex v0.1.0 (Detector)

- enricher.incidentStore v0.1.0 (Enricher)

- enricher.aiSummary v0.1.0 (Enricher)

- action.safe v0.1.0 (Action)

- openclaw.tools v0.1.0 (OpenClawTool)



OpenClaw registered tools:

- incidents.list — List incidents with filter (read-only)

- incidents.get — Get single incident by ID (read-only)

- incidents.summary — Aggregate statistics (read-only)

- incidents.updateStatus — Change status (requires approval)

- actions.propose — Propose action for approval

- audit.query — Query audit trail (read-only)



File structure:

src/

  core/

    types/events.ts, module.ts, config.ts, storage.ts, security.ts, openclaw.ts, index.ts

    bus/EventBus.ts, index.ts

    config/ConfigLoader.ts, ConfigValidator.ts, index.ts

    modules/DependencyResolver.ts, ModuleLoader.ts, ModuleRegistry.ts, index.ts

    storage/MemoryStorage.ts, NamespacedStorage.ts, index.ts

    security/AuditLogger.ts, ApprovalGate.ts, index.ts

    openclaw/ToolRegistry.ts

    Application.ts, index.ts

  shared/errors.ts, logger.ts, utils.ts, events.ts

  modules/

    connector.fileTail/index.ts, schema.json, README.md

    detector.regex/index.ts, schema.json, README.md

    enricher.incidentStore/index.ts, schema.json

    enricher.aiSummary/index.ts, schema.json

    action.safe/index.ts, schema.json

    openclaw.tools/index.ts, schema.json

    notifier.channels/index.ts, schema.json

    detector.threshold/index.ts, schema.json

  main.ts, index.ts

config/default.yaml, test.yaml

logs/sample.log

tests/

  helpers.ts — Shared test utilities (silent/capturing loggers, createTestInfra, sleep)

  eventbus.test.ts — 11 tests: subscribe/publish, multiple subs, filtering, subscribeOnce, unsubscribe, error isolation, listenerCount, async handlers, event shape

  storage.test.ts — 17 tests: MemoryStorage CRUD/list/filter/clear/isolation + NamespacedStorage isolation/prefix/clear

  file-storage.test.ts — 20 tests: get/set/overwrite/complex/special-chars, delete, list/filter/offset, has, count, clear, isolation, persistence across instances

  dependency-resolver.test.ts — 9 tests: ordering, deep chains, diamond, circular, missing, self-dep, deterministic

  config.test.ts — 9 tests: ConfigLoader defaults/load/error + ConfigValidator root/module schema

  security.test.ts — 11 tests: AuditLogger log/query/filter/limit + ApprovalGate create/approve/validate/deny/state-guard

  tool-registry.test.ts — 14 tests: registration, dedup, unregister, listing/filtering, invoke success/failure, approval enforcement

  module-lifecycle.test.ts — 19 tests: ModuleLoader factory/instantiate/mismatch + ModuleRegistry register/init-order/error/start/stop/destroy/queries/lifecycle-events

  detector-regex.test.ts — 11 tests: compile rules, invalid regex, disabled, match/no-match, multi-rule, capture groups, cooldown, rate limit, lifecycle, health

  detector-threshold.test.ts — 17 tests: manifest, init/invalid-regex/disabled, value detection (gt/lt/gte/eq), sliding window (minSamples/mixed-values), cooldown, rate limit, lifecycle, interpolation

  incident-store.test.ts — 13 tests: store/list/filter/limit, status updates, enrichment attachment, timeline, summary, retention, health

  action-safe.test.ts — 11 tests: rule compilation, invalid patterns, severity/pattern matching, autoPropose, approval+execution flow, token rejection, lifecycle

  ai-summary.test.ts — 12 tests: template/external providers, summary generation, root cause inference, severity reasoning, runbook matching/skipping, lifecycle, metrics

  notifier.test.ts — 15 tests: manifest, lifecycle/webhook-validation/disabled-channels, console notifications (incident/action/generic), severity filtering, rate limiting, health

  cli.test.ts — 16 tests: pending command, approve/deny/status/audit commands, aliases, prefix ID matching, help

  integration.test.ts — 4 tests: full pipeline (log→detect→enrich→store), end-to-end with approval, concurrent lines, error isolation

tsconfig.test.json — Test TypeScript config (extends base, includes src + tests, noEmit)



Test runner: Node built-in test runner (node:test + node:assert/strict)

Test command: npm test (206 tests, 50 suites, all passing)

Type-check tests: npm run test:check



What remains to build:

- Real AI API integration (OpenAI/Anthropic providers)

- UI extension modules

- Additional connectors (syslog, journald, Kubernetes, CloudWatch)

- Additional notification channels (Slack webhooks, PagerDuty, email)



Phase 8 — CLI Approval Tool & Notification Module ✅ COMPLETE



Date: Current Session



Built two new features:



1. CLI Approval Console (src/cli/ApprovalCLI.ts):

   - Interactive readline-based CLI for operators

   - Commands: pending, approve, deny, status, audit, help, quit

   - Short aliases: p, a, d, s, h, ?

   - Prefix matching on request IDs (first N chars)

   - Real-time notification on action.proposed events

   - Colour-coded output with ANSI escape sequences

   - Activated via --cli flag on startup, optional --operator <name>

   - Added Application.getLogger() getter to expose core logger



2. Notification Channels Module (src/modules/notifier.channels/):

   - Multi-channel notification routing (console + webhook)

   - Subscribes to configurable event types per channel

   - Console channel: colour-coded, structured output for incident.created, action.proposed, action.approved, action.executed, enrichment.completed, plus generic fallback

   - Webhook channel: HTTP POST/PUT to external endpoints (Slack, PagerDuty, etc.) with configurable headers and 10s timeout

   - Per-channel minSeverity filter for incident events

   - Global rate limiter (configurable per-minute cap)

   - Health reporting with sent/dropped/error counters

   - JSON Schema validation for channel config



Files created:

  src/cli/ApprovalCLI.ts — CLI implementation (268 lines)

  src/cli/index.ts — Barrel export

  src/modules/notifier.channels/index.ts — Module implementation (296 lines)

  src/modules/notifier.channels/schema.json — Config validation schema

  tests/cli.test.ts — 16 tests across 7 suites (pending/approve/deny/status/audit/aliases/prefix)

  tests/notifier.test.ts — 15 tests across 6 suites (manifest/lifecycle/console/severity/rate-limit/health)



Files modified:

  src/core/Application.ts — Added getLogger() public getter

  src/main.ts — Added notifier.channels registration + CLI activation via --cli flag

  config/default.yaml — Added notifier.channels config section with console channel + commented webhook example

  config/test.yaml — Added notifier.channels config section

  package.json — Added cli.test.ts and notifier.test.ts to test script



Phase 9 — File Storage Engine & Threshold Detector ✅ COMPLETE



Date: February 18, 2026



Built two new features:



1. File-based Storage Engine (src/core/storage/FileStorage.ts):

   - Persistent key/value storage using JSON files on the filesystem

   - Layout: basePath/collection/key.json — each record is a separate file

   - Atomic writes via write-to-temp-then-rename strategy

   - Sanitizes collection and key names for filesystem safety (:: → __)

   - Full IStorageEngine implementation: get, set, delete, list, has, count, clear

   - Handles missing directories, corrupt files, and non-existent collections gracefully

   - Application.ts updated with createStorageEngine() factory method

   - Config-driven: set `storage.engine: file` with `options.dataDir` to enable



2. Threshold Detector Module (src/modules/detector.threshold/):

   - Monitors numeric metrics extracted from log lines via regex

   - Sliding window analysis with configurable duration and minimum sample count

   - Five comparison operators: gt, gte, lt, lte, eq

   - Template interpolation: $metric, $value, $threshold, $operator in titles/descriptions

   - Per-rule cooldown prevents alert storms

   - Global rate limiter (configurable per-minute cap)

   - Health reporting with lines scanned, samples collected, incidents created, threshold breaches

   - Useful for: CPU/memory/disk usage monitoring, error rate thresholds, latency spikes



Files created:

  src/core/storage/FileStorage.ts — FileStorage implementation (153 lines)

  src/modules/detector.threshold/index.ts — ThresholdDetector module (290 lines)

  src/modules/detector.threshold/schema.json — Config validation schema

  tests/file-storage.test.ts — 20 tests (CRUD, pagination, isolation, persistence across instances)

  tests/detector-threshold.test.ts — 17 tests (manifest, init, detection, sliding window, cooldown, rate limit, lifecycle, interpolation)



Files modified:

  src/core/Application.ts — Added createStorageEngine() factory, FileStorage import

  src/core/storage/index.ts — Added FileStorage export

  src/main.ts — Added ThresholdDetector registration

  config/default.yaml — Added detector.threshold config (CPU/memory/disk rules), file storage config (commented)

  config/test.yaml — Added detector.threshold config

  package.json — Added file-storage.test.ts and detector-threshold.test.ts to test script



Current module registry (9 modules):

- connector.fileTail v0.1.0 (Connector)

- detector.regex v0.1.0 (Detector)

- detector.threshold v1.0.0 (Detector)

- enricher.incidentStore v0.1.0 (Enricher)

- enricher.aiSummary v0.1.0 (Enricher)

- action.safe v0.1.0 (Action)

- openclaw.tools v0.1.0 (OpenClawTool)

- notifier.channels v1.0.0 (Notifier)



Test results: 206 tests, 50 suites, 0 failures


Phase 10 — Real AI Providers & HTTP REST API ✅ COMPLETE



Date: Current Session



Built two major features:



1. Real AI Providers (src/modules/enricher.aiSummary/providers.ts):

   - Extracted provider abstraction into dedicated file with shared interfaces

   - ISummarizer, SummaryResult, Runbook, AIProviderConfig — all exported

   - TemplateSummarizer: moved from inline class, fully functional (no API needed)

   - OpenAISummarizer: real OpenAI API integration via native fetch()

     - Endpoint: POST {baseUrl}/v1/chat/completions

     - Headers: Authorization Bearer token, Content-Type JSON

     - Uses response_format: json_object for structured output

     - API key from config.apiKey or OPENAI_API_KEY env var

     - Configurable model (default: gpt-4o-mini), maxTokens, baseUrl, timeoutMs

     - AbortController-based timeout (default 30s)

   - AnthropicSummarizer: real Anthropic Messages API integration via native fetch()

     - Endpoint: POST {baseUrl}/v1/messages

     - Headers: x-api-key, anthropic-version 2023-06-01

     - API key from config.apiKey or ANTHROPIC_API_KEY env var

     - Configurable model (default: claude-sonnet-4-20250514), maxTokens, baseUrl, timeoutMs

   - buildPrompt(): structured SRE prompt with incident details, context, runbooks

   - parseAIResponse(): robust JSON parser (handles markdown fences, missing fields, confidence clamping)

   - createSummarizer() factory function for provider selection

   - Graceful fallback: if external provider fails to construct (e.g. missing API key), AISummaryEnricher falls back to TemplateSummarizer with warning log

   - Schema updated with apiKey, baseUrl, timeoutMs fields



2. HTTP REST API Module (src/modules/ui.api/):

   - Full IModule implementation using Node.js built-in http module (zero external dependencies)

   - ModuleType.UIExtension — first UI module in the system

   - Pattern-based routing with path parameter extraction (e.g. :id)

   - CORS support with configurable origin

   - JSON request/response handling

   - 8 REST endpoints:

     - GET  /api/health — System health + all module statuses

     - GET  /api/incidents — List incidents with ?severity=, ?status=, ?limit= filters

     - GET  /api/incidents/:id — Get single incident by ID

     - GET  /api/approvals/pending — List pending approval requests

     - POST /api/approvals/:id/approve — Approve a request (body: {approvedBy})

     - POST /api/approvals/:id/deny — Deny a request (body: {deniedBy, reason})

     - GET  /api/audit — Query audit trail with ?action=, ?actor=, ?limit= filters

     - GET  /api/tools — List all registered OpenClaw tools

   - Dependency injection via setDependencies() for storage, approvalGate, auditLogger, toolRegistry, getModuleHealths

   - Request counting, error tracking, health reporting

   - OPTIONS preflight handling

   - Configurable host, port (default 3000), basePath, corsOrigin



Files created:

  src/modules/enricher.aiSummary/providers.ts — Provider implementations (340 lines)

  src/modules/ui.api/index.ts — REST API module (608 lines)

  src/modules/ui.api/schema.json — Config validation schema

  tests/ai-providers.test.ts — 27 tests across 8 suites

  tests/rest-api.test.ts — 20 tests



Files modified:

  src/modules/enricher.aiSummary/index.ts — Refactored to use providers.ts, added fallback on init failure

  src/modules/enricher.aiSummary/schema.json — Added apiKey, baseUrl, timeoutMs fields

  src/main.ts — Added RestApiModule registration + dependency injection in onPreInit

  config/default.yaml — Added ui.api config section

  package.json — Added ai-providers.test.ts and rest-api.test.ts to test script



Current module registry (10 modules):

- connector.fileTail v0.1.0 (Connector)

- detector.regex v0.1.0 (Detector)

- detector.threshold v1.0.0 (Detector)

- enricher.incidentStore v0.1.0 (Enricher)

- enricher.aiSummary v0.1.0 (Enricher)

- action.safe v0.1.0 (Action)

- openclaw.tools v0.1.0 (OpenClawTool)

- notifier.channels v1.0.0 (Notifier)

- ui.api v0.1.0 (UIExtension)



Test results: 253 tests, 59 suites, 0 failures



What remains to build:

- Additional connectors (syslog, journald, Kubernetes, CloudWatch)

- Additional notification channels (Slack webhooks, PagerDuty, email)

- WebSocket real-time event streaming

- Dashboard UI module

- Plugin marketplace / third-party module loading



Phase 11 — WebSocket Streaming & Metric Collector ✅ COMPLETE



Date: Current Session



Built two new modules:



1. WebSocket Real-Time Event Streaming (src/modules/ui.websocket/):

   - Full IModule implementation using Node.js built-in http + crypto (zero external dependencies)

   - ModuleType.UIExtension — WebSocket server on configurable port (default 3001)

   - RFC 6455 compliant WebSocket handshake implemented from scratch

   - Raw WebSocket frame encoding/decoding (Text, Close, Ping, Pong opcodes)

   - Client connection management with max client limit enforcement (503 on excess)

   - WsClient class tracks per-client subscriptions and alive state

   - Client protocol:

     - Server sends welcome message on connect: { type: "welcome", clientId, subscribableEvents }

     - Client subscribes: { action: "subscribe", events: ["incident.created", ...] }

     - Client unsubscribes: { action: "unsubscribe", events: [...] }

     - Client ping: { action: "ping" } → Server responds { type: "pong" }

     - Server forwards events: { type: "event", eventType, source, timestamp, correlationId, data }

     - Invalid actions return: { type: "error", message: "..." }

   - Only allows subscription to configurable subscribableEvents list (filters unknowns)

   - Heartbeat via WebSocket ping/pong frames at configurable interval (default 30s)

   - Dead connection detection: clients that don't respond to ping are terminated

   - EventBus integration: subscribes to all subscribableEvents on start, broadcasts matching events to subscribed clients

   - Health reporting: activeClients, totalConnections, totalMessages, totalBroadcasts

   - Graceful shutdown: sends Close frame (code 1001) to all clients, unsubscribes from bus

   - Config: port, host, heartbeatIntervalMs, maxClients, subscribableEvents

   - Guards against destroyed context in async socket close callbacks



2. System Metric Collector Connector (src/modules/connector.metrics/):

   - Full IModule implementation using Node.js built-in os module (zero external dependencies)

   - ModuleType.Connector — collects system metrics at configurable intervals

   - Enabled metrics (configurable): cpu, memory, loadAvg, uptime

   - CPU measurement: snapshot-based (idle vs total delta between cycles)

   - Memory measurement: usage %, used MB, total MB via os.totalmem()/os.freemem()

   - Load average: 1m, 5m, 15m via os.loadavg()

   - Uptime: hours via os.uptime()

   - Emits log.ingested events with structured [METRIC] tagged lines:

     - "[METRIC] cpu_usage_percent=72.3"

     - "[METRIC] memory_usage_percent=58.1 memory_used_mb=4712 memory_total_mb=8096"

     - "[METRIC] load_avg_1m=1.24 load_avg_5m=0.98 load_avg_15m=0.72"

     - "[METRIC] uptime_hours=142.5"

   - Threshold warnings: emits [WARNING] lines when metrics exceed configured thresholds

     - "[WARNING] cpu_usage_percent=95.2 exceeds threshold 90"

     - These can be picked up by regex/threshold detectors in the pipeline

   - Metadata includes collector name and cycle number

   - Health reporting: cycleCount, linesEmitted, enabledMetrics

   - Config: intervalMs, enabledMetrics, thresholds (cpuPercent, memoryPercent), source

   - Exported CPU helpers (takeCpuSnapshot, computeCpuPercent) for testability



Files created:

  src/modules/ui.websocket/index.ts — WebSocket streaming module (~590 lines)

  src/modules/ui.websocket/schema.json — Config validation schema

  src/modules/connector.metrics/index.ts — Metric collector module (~290 lines)

  src/modules/connector.metrics/schema.json — Config validation schema

  tests/websocket.test.ts — 16 tests across 6 suites

  tests/metric-collector.test.ts — 16 tests across 5 suites



Files modified:

  src/main.ts — Added WebSocketModule + MetricCollector registration

  config/default.yaml — Added ui.websocket + connector.metrics config sections

  package.json — Added websocket.test.ts and metric-collector.test.ts to test script



Current module registry (12 modules):

- connector.fileTail v0.1.0 (Connector)

- connector.metrics v0.1.0 (Connector)

- detector.regex v0.1.0 (Detector)

- detector.threshold v1.0.0 (Detector)

- enricher.incidentStore v0.1.0 (Enricher)

- enricher.aiSummary v0.1.0 (Enricher)

- action.safe v0.1.0 (Action)

- openclaw.tools v0.1.0 (OpenClawTool)

- notifier.channels v1.0.0 (Notifier)

- ui.api v0.1.0 (UIExtension)

- ui.websocket v0.1.0 (UIExtension)



Test results: 289 tests, 72 suites, 0 failures



What remains to build:

- Additional connectors (syslog, journald, Kubernetes, CloudWatch)

- Additional notification channels (Slack webhooks, PagerDuty, email)

- Dashboard UI module

- Plugin marketplace / third-party module loading



Phase 12 — Dynamic Plugin Loader ✅ COMPLETE



Date: Current Session



Built a runtime plugin discovery and loading system that allows external
modules to be loaded from a plugins directory at startup without modifying
core source code.



Core Implementation (src/core/plugins/PluginLoader.ts ~340 lines):

  - PluginManifest interface: id, name, version, type, description?, entry?, dependencies?
  - PluginDescriptor: manifest + directory + entryPath
  - PluginDiscoveryResult: plugins[] + errors[]
  - PluginLoader class with discover(), loadPlugin(), loadAll() methods
  - readPlugin() — reads and validates manifest.json from plugin subdirectories
  - importEntry() — supports CommonJS (require) then ESM (import()) fallback
  - resolveModuleExport() — tries default export, named Module, prototype.manifest, then any constructor
  - validateModuleContract() — checks manifest.id match + all 5 lifecycle methods exist
  - validateManifest() — checks required fields (id, name, version, type) + valid ModuleType enum values

Application Integration (src/core/Application.ts):
  - Added step "4b. Dynamic Plugin Discovery" after factory registration
  - Reads pluginsDir from config, calls pluginLoader.loadAll()
  - Registers new module factories (skips duplicates with warning)
  - Guard: if (!this.moduleLoader.hasFactory(id)) prevents plugins from overriding built-in modules

Config (config/default.yaml):
  - Added optional pluginsDir setting (commented out by default: # pluginsDir: ./plugins)

Files created:
  src/core/plugins/PluginLoader.ts — Plugin loader (~340 lines)
  tests/plugin-loader.test.ts — 14 tests across 4 suites (Discovery, Loading, loadAll, Misc)



Phase 13 — Slack Webhook & PagerDuty Notifiers ✅ COMPLETE



Date: Current Session



Built two production notification channel modules for external service
integration.



1. Slack Webhook Notifier (src/modules/notifier.slack/):
   - Full IModule implementation (ModuleType.Notifier)
   - Slack Block Kit formatting for rich message layout
   - Severity-based color coding: critical=#ff0000, warning=#ff9900, info=#36a64f
   - Severity emojis: :rotating_light: :warning: :information_source:
   - Event-specific formatters:
     - incident.created — colored sidebar, header, severity/source/time fields, description
     - action.proposed — orange sidebar, action type, reasoning
     - action.approved — green sidebar, approved by, token ID
     - action.executed — green (success) or red (failure), output details
     - enrichment.completed — blue sidebar, enricher module, enrichment type
     - Generic fallback — grey sidebar, JSON payload
   - Minimum severity filter for incident events
   - Per-minute rate limiting (default 30/min)
   - HTTP POST to Slack Incoming Webhook URL with timeout
   - Channel, username, icon_emoji overrides
   - Health reporting: totalSent, totalDropped, totalErrors
   - Test accessors: formatMessage(), sendToSlack(), getConfig(), getMetrics()
   - Config: webhookUrl (required), channel, username, iconEmoji, events[], minSeverity, rateLimitPerMinute, timeoutMs

2. PagerDuty Events API v2 Notifier (src/modules/notifier.pagerduty/):
   - Full IModule implementation (ModuleType.Notifier)
   - PagerDuty Events API v2 integration (POST to /v2/enqueue)
   - Event mapping:
     - incident.created → PD "trigger" event with severity, custom_details, dedup_key
     - action.executed (success + incidentId) → PD "resolve" event
     - action.executed (failure) → PD "trigger" with error severity
     - Other events → generic "trigger" with info severity
   - Severity mapping: critical→critical, warning→warning, info→info
   - Dedup key support: {prefix}-{incidentId} for alert correlation
   - Summary truncation to 1024 chars (PD API limit)
   - component and group fields for PD service grouping
   - Per-minute rate limiting (default 20/min)
   - HTTP POST with configurable timeout
   - Health reporting: totalSent, totalDropped, totalErrors, lastDedupKey, routingKey (masked)
   - Test accessors: buildPdEvent(), sendToPagerDuty(), getConfig(), getMetrics()
   - Config: routingKey (required), apiUrl, events[], minSeverity, dedupKeyPrefix, source, component?, group?, timeoutMs, rateLimitPerMinute

Files created:
  src/modules/notifier.slack/index.ts — Slack notifier (~446 lines)
  src/modules/notifier.slack/schema.json — Config validation schema
  src/modules/notifier.pagerduty/index.ts — PagerDuty notifier (~367 lines)
  src/modules/notifier.pagerduty/schema.json — Config validation schema
  tests/notifier-integrations.test.ts — 28 tests (14 Slack + 14 PagerDuty)

Files modified:
  src/main.ts — Added SlackNotifier + PagerDutyNotifier imports and registration
  src/core/Application.ts — Added PluginLoader import + step 4b plugin discovery
  config/default.yaml — Added notifier.slack + notifier.pagerduty config sections (disabled by default), pluginsDir
  package.json — Added plugin-loader.test.ts + notifier-integrations.test.ts to test script

Current module registry (14 modules):
- connector.fileTail v0.1.0 (Connector)
- connector.metrics v0.1.0 (Connector)
- detector.regex v0.1.0 (Detector)
- detector.threshold v1.0.0 (Detector)
- enricher.incidentStore v0.1.0 (Enricher)
- enricher.aiSummary v0.1.0 (Enricher)
- action.safe v0.1.0 (Action)
- openclaw.tools v0.1.0 (OpenClawTool)
- notifier.channels v1.0.0 (Notifier)
- notifier.slack v0.1.0 (Notifier)
- notifier.pagerduty v0.1.0 (Notifier)
- ui.api v0.1.0 (UIExtension)
- ui.websocket v0.1.0 (UIExtension)

Test results: 333 tests, 86 suites, 0 failures

What remains to build:
- Additional connectors (syslog, journald, Kubernetes, CloudWatch)
- Additional notification channels (email, Microsoft Teams)
- Dashboard UI module
- Plugin marketplace / registry



Phase 14 — Incident Correlation Engine ✅ COMPLETE



Date: Current Session



Built an incident correlation engine that groups related incidents by time
proximity and keyword similarity to reduce alert noise and detect incident
storms.



Correlation Engine (src/modules/enricher.correlator/):
  - Full IModule implementation (ModuleType.Enricher)
  - Time-windowed grouping: incidents within configurable window (default 60s) are candidates
  - Keyword-based Jaccard similarity on tokenised titles + descriptions
  - Source match bonus: same-source incidents get 0.7× effective threshold (easier to group)
  - CorrelationGroup tracks: rootIncidentId, memberIds, keywords (Set), severity, timestamps
  - Storm detection: when group size reaches stormThreshold, emits `incident.storm` event
  - Storm emitted once per group (stormEmitted flag)
  - Emits `enrichment.completed` for every correlated incident (links to group)
  - Automatic group expiry via configurable TTL (default 1h), periodic sweep
  - LRU-style eviction when maxGroups capacity reached
  - Exported utility functions for testability: tokenize(), jaccardSimilarity()
  - Health reporting: activeGroups, totalCorrelated, totalGroups, totalStorms, totalExpired
  - Test accessors: getGroups(), getMetrics(), getConfig()
  - Config: timeWindowMs, similarityThreshold, maxGroupSize, stormThreshold, maxGroups, groupTtlMs

Event types produced:
  - enrichment.completed (enrichmentType: 'correlation') — for each correlated incident
  - incident.storm — when a group crosses stormThreshold

Files created:
  src/modules/enricher.correlator/index.ts — Correlator module (~340 lines)
  src/modules/enricher.correlator/schema.json — Config validation schema
  tests/correlator.test.ts — 20 tests across 7 suites



Phase 15 — Scheduled Health Check Connector ✅ COMPLETE



Date: Current Session



Built a health check connector that periodically probes HTTP/TCP endpoints
and feeds failures into the detection pipeline as log.ingested events.



Health Check Connector (src/modules/connector.healthCheck/):
  - Full IModule implementation (ModuleType.Connector)
  - Multi-endpoint support with per-endpoint configuration
  - HTTP probes: configurable method (GET/HEAD/POST), expected status code, body content match
  - TCP probes: raw socket connect to tcp://host:port
  - Per-endpoint configurable severity (info/warning/critical)
  - Consecutive failure threshold: only alert after N consecutive failures
  - Recovery detection: emits [RECOVERY] tagged line when endpoint comes back online
  - Per-endpoint state tracking: status (unknown/healthy/unhealthy), consecutiveFails, response time
  - Emits log.ingested events tagged with [HEALTH_CHECK] + [FAILURE] or [RECOVERY]
  - Event metadata includes endpointId, endpointName, endpointUrl, severity, responseMs
  - All endpoints checked concurrently via Promise.allSettled
  - Configurable per-request timeout using AbortSignal.timeout
  - Health reporting: totalCycles, totalProbes, totalFailures, totalRecoveries, per-endpoint status map
  - Module health status: degraded when any endpoint is unhealthy
  - Test accessors: getStates(), getMetrics(), getConfig(), probe() (mockable), runCycle()
  - Config: intervalMs, timeoutMs, endpoints[], source

Files created:
  src/modules/connector.healthCheck/index.ts — Health check connector (~370 lines)
  src/modules/connector.healthCheck/schema.json — Config validation schema
  tests/health-check.test.ts — 19 tests across 5 suites

Files modified:
  src/main.ts — Added IncidentCorrelator + HealthCheckConnector imports and registration
  config/default.yaml — Added enricher.correlator (enabled) + connector.healthCheck (disabled) config sections
  package.json — Added correlator.test.ts + health-check.test.ts to test script

Current module registry (16 modules):
- connector.fileTail v0.1.0 (Connector)
- connector.metrics v0.1.0 (Connector)
- connector.healthCheck v0.1.0 (Connector)
- detector.regex v0.1.0 (Detector)
- detector.threshold v1.0.0 (Detector)
- enricher.incidentStore v0.1.0 (Enricher)
- enricher.aiSummary v0.1.0 (Enricher)
- enricher.correlator v0.1.0 (Enricher)
- action.safe v0.1.0 (Action)
- openclaw.tools v0.1.0 (OpenClawTool)
- notifier.channels v1.0.0 (Notifier)
- notifier.slack v0.1.0 (Notifier)
- notifier.pagerduty v0.1.0 (Notifier)
- ui.api v0.1.0 (UIExtension)
- ui.websocket v0.1.0 (UIExtension)

Test results: 372 tests, 99 suites, 0 failures

---

Phase 16 — Incident Deduplication & Suppression ✅ COMPLETE

New module: enricher.dedup v0.1.0 (Enricher)
- SHA-256 fingerprint-based duplicate detection
- Configurable fingerprint fields (default: title + severity + detectedBy)
- Time-windowed suppression (default 5 min) — duplicates within window are silenced
- Occurrence counting per fingerprint (tracks how many times each fingerprint is seen)
- Emits `incident.suppressed` events for dashboard visibility (configurable)
- Emits `enrichment.completed` with dedup_occurrence data on each suppression
- Auto-expiry sweep removes stale fingerprints after window elapses
- LRU-style capacity management (maxFingerprints with oldest-first eviction)
- Health reporting includes suppression rate percentage
- Test accessors: getFingerprints(), getMetrics(), getConfig()

Files created:
  src/modules/enricher.dedup/schema.json — Config validation schema (windowMs, fingerprintFields, maxFingerprints, emitSuppressed)
  src/modules/enricher.dedup/index.ts — DedupEnricher class + computeFingerprint() utility
  tests/dedup.test.ts — 18 tests across 6 suites

Phase 17 — Escalation Engine ✅ COMPLETE

New module: action.escalation v0.1.0 (Action)
- Multi-level escalation policies with configurable timeouts (L1 → L2 → L3)
- Policy matching by severity and/or title regex pattern (first match wins)
- Periodic sweep-based escalation checking (configurable interval)
- Emits `incident.escalated` events with level, notify targets, and elapsed time
- Emits `enrichment.completed` with escalation metadata
- Incident lifecycle tracking: subscribes to incident.created and incident.updated
- Acknowledgement support: pauses escalation timers (configurable)
- Auto-removes resolved/closed incidents from tracking
- Repeat notifications at configurable intervals for specific levels
- Capacity management with oldest-first eviction (maxTrackedIncidents)
- Health reporting with escalation/tracking/resolution metrics
- Test accessors: getTracked(), getMetrics(), getConfig(), sweep()

Files created:
  src/modules/action.escalation/schema.json — Config validation schema (checkIntervalMs, policies, levels, matching, repeat)
  src/modules/action.escalation/index.ts — EscalationEngine class with sweep-based escalation
  tests/escalation.test.ts — 21 tests across 8 suites

Files modified:
  src/main.ts — Added DedupEnricher + EscalationEngine imports and registration
  config/default.yaml — Added enricher.dedup (enabled) + action.escalation (enabled with sample policies) config sections
  package.json — Added dedup.test.ts + escalation.test.ts to test script

Current module registry (18 modules):
- connector.fileTail v0.1.0 (Connector)
- connector.metrics v0.1.0 (Connector)
- connector.healthCheck v0.1.0 (Connector)
- detector.regex v0.1.0 (Detector)
- detector.threshold v1.0.0 (Detector)
- enricher.incidentStore v0.1.0 (Enricher)
- enricher.aiSummary v0.1.0 (Enricher)
- enricher.correlator v0.1.0 (Enricher)
- enricher.dedup v0.1.0 (Enricher)
- action.safe v0.1.0 (Action)
- action.escalation v0.1.0 (Action)
- openclaw.tools v0.1.0 (OpenClawTool)
- notifier.channels v1.0.0 (Notifier)
- notifier.slack v0.1.0 (Notifier)
- notifier.pagerduty v0.1.0 (Notifier)
- ui.api v0.1.0 (UIExtension)
- ui.websocket v0.1.0 (UIExtension)

Test results: 411 tests, 113 suites, 0 failures

What remains to build:
- Additional connectors (syslog, journald, Kubernetes, CloudWatch)
- Additional notification channels (email)
- Dashboard UI module

---

Phase 18 — Runbook Automation Engine ✅ COMPLETE

New module: action.runbook v0.1.0 (Action)
- Subscribes to enrichment.completed (ai-summary type) for suggested runbooks
- Parses suggestedRunbooks from AI summary data and orchestrates step-by-step execution
- Approval-gated mode: proposes runbook execution via ApprovalGate, waits for human approval
- Auto-execute mode: runs runbooks immediately without approval (configurable, default off)
- Per-step approval mode: requires separate approval for each step (configurable)
- Emits runbook.started, runbook.stepCompleted, runbook.completed events
- Emits action.executed for audit trail on each completed runbook
- Cooldown per incident (configurable, default 60s) prevents duplicate runbook proposals
- Capacity management (maxConcurrentRunbooks, maxRunbookHistory)
- Severity filtering — only processes enrichments for matching severity levels
- Health reporting with execution/completion/failure/rate metrics
- Test accessors: getExecutions(), getHistory(), getMetrics(), getConfig(), getCooldowns(), getApprovalMappings()

Files created:
  src/modules/action.runbook/schema.json — Config validation schema (autoExecute, requireApprovalPerStep, stepTimeoutMs, maxConcurrentRunbooks, maxRunbookHistory, cooldownMs, severityFilter)
  src/modules/action.runbook/index.ts — RunbookEngine class with full orchestration and approval gating
  tests/runbook.test.ts — 21 tests across 8 suites (Lifecycle, Enrichment Filtering, Auto-Execute, Approval-Gated, Per-Step Approval, Cooldown, Capacity, Health)

Phase 19 — Microsoft Teams Webhook Notifier ✅ COMPLETE

New module: notifier.teams v0.1.0 (Notifier)
- O365 MessageCard connector format (@type: MessageCard, @context: https://schema.org/extensions)
- Severity-based themeColor: info=36a64f (green), warning=ff9900 (orange), critical=ff0000 (red)
- Structured fact sets with key/value pairs for each event type
- Formats incident.created (with severity, ID, description, detected-by facts)
- Formats action.proposed (with action type, description, reasoning, requested-by facts)
- Formats action.approved (placeholder for approved events)
- Formats action.executed (with result status, action type, output, executed-by facts)
- Formats enrichment.completed (with incident ID, enricher module, enrichment type facts)
- Generic formatting for unknown event types
- Minimum severity filter — drops incidents below configured threshold
- Per-minute rate limiting with sliding window (configurable)
- Timeout handling for webhook HTTP calls
- Health reporting: healthy/degraded/unhealthy based on error state
- Test accessors: getConfig(), getMetrics(), sendToTeams() (public for mocking), formatMessage()

Files created:
  src/modules/notifier.teams/schema.json — Config validation schema (webhookUrl, events, minSeverity, rateLimitPerMinute, timeoutMs, themeColor)
  src/modules/notifier.teams/index.ts — TeamsNotifier class with O365 MessageCard formatting
  tests/teams-notifier.test.ts — 19 tests across 5 suites (Lifecycle, Message Formatting, Severity Filtering, Rate Limiting, Error Handling)

Files modified:
  src/main.ts — Added RunbookEngine + TeamsNotifier imports and registration
  config/default.yaml — Added action.runbook (disabled) + notifier.teams (disabled) config sections
  package.json — Added runbook.test.ts + teams-notifier.test.ts to test script

Current module registry (20 modules):
- connector.fileTail v0.1.0 (Connector)
- connector.metrics v0.1.0 (Connector)
- connector.healthCheck v0.1.0 (Connector)
- detector.regex v0.1.0 (Detector)
- detector.threshold v1.0.0 (Detector)
- enricher.incidentStore v0.1.0 (Enricher)
- enricher.aiSummary v0.1.0 (Enricher)
- enricher.correlator v0.1.0 (Enricher)
- enricher.dedup v0.1.0 (Enricher)
- action.safe v0.1.0 (Action)
- action.escalation v0.1.0 (Action)
- action.runbook v0.1.0 (Action)
- openclaw.tools v0.1.0 (OpenClawTool)
- notifier.channels v1.0.0 (Notifier)
- notifier.slack v0.1.0 (Notifier)
- notifier.pagerduty v0.1.0 (Notifier)
- notifier.teams v0.1.0 (Notifier)
- ui.api v0.1.0 (UIExtension)
- ui.websocket v0.1.0 (UIExtension)

Test results: 451 tests, 126 suites, 0 failures

Phase 20 — Additional Connectors ✅ COMPLETE

Four new connector modules for ingesting data from diverse infrastructure sources.

New module: connector.syslog v1.0.0 (Connector)
- UDP and TCP syslog listener using dgram.Socket / net.Server
- RFC 3164 (BSD) and RFC 5424 (IETF) syslog format parsing with auto-detect
- Priority decomposition: facility = pri >> 3, severity = pri & 0x07
- 24 facility names, 8 severity names mapping
- Syslog severity → OpsPilot severity mapping (0-2=critical, 3-4=warning, 5-7=info)
- Nil structured data handling for RFC 5424 (`-` prefix stripping)
- Test accessors: getConfig(), getMetrics(), injectMessage()

New module: connector.journald v1.0.0 (Connector)
- Reads systemd journal via `journalctl --output=json` subprocess
- Cursor-based resumption (no missed entries across restarts)
- Unit and priority filtering
- Graceful fallback when journalctl is unavailable (reports unhealthy)
- Journald priority → OpsPilot severity mapping (0-2=critical, 3-4=warning, 5-7=info)
- Test accessors: getConfig(), getMetrics(), getCursor(), isAvailable(), setAvailable(), injectEntries(), parseEntry()

New module: connector.kubernetes v1.0.0 (Connector)
- Polls K8s API via plain fetch() (zero SDK dependency)
- K8s Events: Warning/Normal with configurable severity mapping
- Pod status: CrashLoopBackOff, OOMKilled, ImagePullBackOff detection with Map-based dedup
- Node conditions: Ready=False, MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable
- In-cluster ServiceAccount auth and explicit bearer token support
- resourceVersion tracking for event pagination
- Test accessors: getConfig(), getMetrics(), getKnownPodStates(), clearPodStates(), parseK8sEvent(), parsePodStatus(), parseNodeConditions(), processEvent(), processPodStatus(), processNodeConditions(), fetchK8s()

New module: connector.cloudwatch v1.0.0 (Connector)
- Polls AWS CloudWatch Logs via FilterLogEvents API using fetch (mockable)
- Multi-log-group polling with per-group cursor tracking (nextForwardToken)
- Filter pattern support for server-side log filtering
- Configurable lookback window for initial poll
- Test accessors: getConfig(), getGroupStates(), getMetrics(), injectEvents()

Files created:
  src/modules/connector.syslog/schema.json + index.ts
  src/modules/connector.journald/schema.json + index.ts
  src/modules/connector.kubernetes/schema.json + index.ts
  src/modules/connector.cloudwatch/schema.json + index.ts
  tests/syslog.test.ts — 13 tests across 4 suites
  tests/journald.test.ts — 9 tests across 3 suites
  tests/kubernetes.test.ts — 18 tests across 7 suites
  tests/cloudwatch.test.ts — 8 tests across 3 suites

Phase 21 — Email Notifier ✅ COMPLETE

New module: notifier.email v1.0.0 (Notifier)
- Minimal SMTP client (EHLO → AUTH PLAIN → MAIL FROM → RCPT TO → DATA)
- STARTTLS upgrade and implicit TLS (port 465) support
- RFC 5322 message construction with MIME multipart/alternative
- Dot-stuffing per RFC 5321 for message body
- Severity-based subject tags and HTML body color coding
- HTML email body with inline CSS styling
- HTML-escaping of all user content to prevent XSS
- Formats all major event types + generic fallback
- Minimum severity filter, per-minute rate limiting
- sendEmail() is public for test mocking (bypasses real SMTP)
- Test accessors: getConfig(), getMetrics()

Files created:
  src/modules/notifier.email/schema.json + index.ts
  tests/email-notifier.test.ts — 20 tests across 6 suites

Phase 22 — Dashboard UI Module ✅ COMPLETE

New module: ui.dashboard v1.0.0 (UIExtension)
- Self-contained HTML dashboard served on configurable port (default 3001)
- Zero external dependencies — all HTML, CSS, and JS embedded as template literals
- Dark theme (GitHub-inspired) with responsive grid layout
- Summary cards, module health cards, recent events feed table
- Auto-refresh via JavaScript polling (configurable interval)
- Ring buffer of recent events (configurable max, newest-first)
- Subscribes to well-known event types for the feed
- JSON API endpoints: /api/status, /api/events, /api/modules
- XSS protection, dependency injection for module health
- Test accessors: getConfig(), getRecentEvents(), getMetrics(), getServer(), renderDashboardHtml(), injectEvent()

Files created:
  src/modules/ui.dashboard/schema.json + index.ts
  tests/dashboard.test.ts — 17 tests across 4 suites

Files modified (Phases 20-22):
  src/main.ts — Added 6 new imports + registrations + dashboard dependency injection
  config/default.yaml — Added 6 new disabled config sections
  package.json — Added 6 test files to test script

Current module registry (26 modules):
- connector.fileTail v0.1.0, connector.metrics v0.1.0, connector.healthCheck v0.1.0
- connector.syslog v1.0.0, connector.journald v1.0.0, connector.kubernetes v1.0.0, connector.cloudwatch v1.0.0
- detector.regex v0.1.0, detector.threshold v1.0.0
- enricher.incidentStore v0.1.0, enricher.aiSummary v0.1.0, enricher.correlator v0.1.0, enricher.dedup v0.1.0
- action.safe v0.1.0, action.escalation v0.1.0, action.runbook v0.1.0
- openclaw.tools v0.1.0
- notifier.channels v1.0.0, notifier.slack v0.1.0, notifier.pagerduty v0.1.0, notifier.teams v0.1.0, notifier.email v1.0.0
- ui.api v0.1.0, ui.websocket v0.1.0, ui.dashboard v1.0.0

Test results: 536 tests, 154 suites, 0 failures

All planned feature phases are now complete.

---

Phase 23 — Anomaly Detector Module ✅ COMPLETE

New module: detector.anomaly v1.0.0 (Detector)
- Statistical anomaly detection for numeric metrics extracted from log events
- Subscribes to log.ingested, extracts values via configurable regex patterns
- Four detection methods:
  - Z-Score: classical Gaussian deviation (mean ± k·σ)
  - MAD: Median Absolute Deviation (robust to outliers, uses 1.4826 normalisation constant)
  - IQR: Interquartile Range (Q1 − k·IQR, Q3 + k·IQR)
  - EWMA: Exponentially Weighted Moving Average with control limits
- Training phase: collects minTrainingSamples before activating detection
- Detection runs BEFORE adding new sample to window (uncontaminated baseline)
- Direction-aware filtering: both/high/low
- Per-metric cooldown prevents alert storms
- Global rate limit (maxIncidentsPerMinute) caps total incidents
- Rolling window bounded by trainingWindowSize with FIFO eviction
- Configurable sensitivity (number of std devs / MADs / IQRs)
- Emits incident.created with full context (metricId, method, value, expected, bounds, direction)
- Test accessors: getConfig(), getCompiledMetrics(), getMetrics(), getWindow(), injectValue(), trainMetric()

Files created:
  src/modules/detector.anomaly/schema.json + index.ts
  tests/anomaly-detector.test.ts — 37 tests across 13 suites

Files modified:
  src/main.ts — Added import + registration for AnomalyDetector (27th module)
  config/default.yaml — Added detector.anomaly config section (disabled, with cpu + memory example metrics)
  package.json — Added anomaly-detector.test.ts to test script

Current module registry (27 modules):
- connector.fileTail v0.1.0, connector.metrics v0.1.0, connector.healthCheck v0.1.0
- connector.syslog v1.0.0, connector.journald v1.0.0, connector.kubernetes v1.0.0, connector.cloudwatch v1.0.0
- detector.regex v0.1.0, detector.threshold v1.0.0, detector.anomaly v1.0.0
- enricher.incidentStore v0.1.0, enricher.aiSummary v0.1.0, enricher.correlator v0.1.0, enricher.dedup v0.1.0
- action.safe v0.1.0, action.escalation v0.1.0, action.runbook v0.1.0
- openclaw.tools v0.1.0
- notifier.channels v1.0.0, notifier.slack v0.1.0, notifier.pagerduty v0.1.0, notifier.teams v0.1.0, notifier.email v1.0.0
- ui.api v0.1.0, ui.websocket v0.1.0, ui.dashboard v1.0.0

Test results: 573 tests, 171 suites, 0 failures

