# OpsPilot Product Overview

OpsPilot is a modular AI-powered operations agent that monitors systems, detects incidents, explains problems clearly, and safely assists humans in resolving operational issues.

## Core Value Proposition

Converts overwhelming operational signals into actionable understanding:

```
RAW SIGNAL → INCIDENT → UNDERSTANDING → SAFE ACTION
```

## Key Principles

- **Modular First**: Everything outside core is a self-contained module
- **Event-Driven**: Modules communicate exclusively through typed event bus
- **Safety by Design**: AI never executes actions automatically; all actions require human approval
- **Observable**: Every action is audited and traceable

## Module Categories

- **Connectors**: Ingest external data (logs, metrics, APIs)
- **Detectors**: Analyze data and create incidents
- **Enrichers**: Add context, correlation, deduplication
- **Actions**: Propose or execute safe remediation
- **Notifiers**: Deliver alerts to external channels
- **UI Extensions**: Dashboards, APIs, real-time streaming

## Safety Model (Non-Negotiable)

```
AI Proposal → Human Review → Approval Token (15-min TTL) → Gated Execution → Audit Log
```

All actions must be proposed, explained, and approved before execution. Approval tokens expire after 15 minutes. Every action is recorded in an immutable audit log.

## Current Status

Working architecture with 27 modules across all categories. Core framework complete with 573 passing tests. Production gaps exist in database persistence, authentication, and containerization.
