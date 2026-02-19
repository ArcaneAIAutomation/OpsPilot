# connector.fileTail

Tails a log file and emits `log.ingested` events for each new line.

## Configuration

```yaml
modules:
  connector.fileTail:
    enabled: true
    path: /var/log/syslog
    encoding: utf-8
    pollIntervalMs: 1000
    fromBeginning: false
    maxLineLength: 65536
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `path` | string | *(required)* | Absolute path to the log file |
| `encoding` | string | `utf-8` | File encoding (`utf-8`, `ascii`, `latin1`) |
| `pollIntervalMs` | integer | `1000` | Polling interval in ms (fallback when fs.watch unavailable) |
| `fromBeginning` | boolean | `false` | Read entire file on first start |
| `maxLineLength` | integer | `65536` | Max characters per line (truncates beyond) |

## Events Produced

| Event Type | Payload | Description |
|-----------|---------|-------------|
| `log.ingested` | `LogIngestedPayload` | Emitted for each new line read from the file |

## Events Consumed

None. This is a pure ingestion connector.

## Lifecycle

- **initialize** — Validates the configured file path exists (warns if not yet created)
- **start** — Opens a file watcher via `fs.watch` + polling fallback, begins tailing
- **stop** — Closes the watcher, stops reading
- **destroy** — Releases all references

## Design Notes

- Uses `fs.createReadStream` starting from the last known byte offset
- Tracks byte position across reads to avoid re-reading old data
- Handles file truncation (log rotation) by resetting to byte 0
- Emits lines as they arrive — no batching, no buffering beyond newline splitting
