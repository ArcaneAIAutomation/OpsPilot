# detector.regex

Subscribes to `log.ingested` events and applies configurable regex rules to detect incidents.

## Configuration

```yaml
modules:
  detector.regex:
    enabled: true
    maxIncidentsPerMinute: 30
    rules:
      - id: error-generic
        pattern: "\\bERROR\\b"
        flags: "i"
        severity: critical
        title: "Error detected in logs"
        description: "Log line matched error pattern: $0"
        cooldownMs: 60000
        enabled: true

      - id: warn-memory
        pattern: "memory usage.*(\\d+)%"
        flags: "i"
        severity: warning
        title: "High memory usage detected"
        description: "Memory usage at $1%"
        cooldownMs: 120000
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `rules` | array | *(required)* | Array of detection rule objects |
| `rules[].id` | string | *(required)* | Unique rule identifier |
| `rules[].pattern` | string | *(required)* | Regex pattern to match against log lines |
| `rules[].flags` | string | `"i"` | Regex flags |
| `rules[].severity` | string | *(required)* | `info`, `warning`, or `critical` |
| `rules[].title` | string | *(required)* | Human-readable incident title |
| `rules[].description` | string | `"Pattern matched: $0"` | Description template with `$0`-`$9` substitution |
| `rules[].cooldownMs` | integer | `60000` | Min ms between incidents for this rule |
| `rules[].enabled` | boolean | `true` | Whether rule is active |
| `maxIncidentsPerMinute` | integer | `30` | Global rate limit |

## Events Consumed

| Event Type | Payload | Description |
|-----------|---------|-------------|
| `log.ingested` | `LogIngestedPayload` | Log lines to scan |

## Events Produced

| Event Type | Payload | Description |
|-----------|---------|-------------|
| `incident.created` | `IncidentCreatedPayload` | Emitted when a rule matches a log line |

## Design Notes

- Rules compile regex patterns once at initialization — not per-line
- Per-rule cooldown prevents alert storms from repeated matching
- Global rate limit acts as a safety valve
- Description templates support `$0` (full match) through `$9` (capture groups)
- Disabled rules are skipped at zero cost
- All incidents include the matched rule ID, source log line, and capture groups in context
