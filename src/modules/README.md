# OpsPilot Modules

This directory will contain all OpsPilot modules organized by type:

- `connector.*` — Ingest external data
- `detector.*` — Create incidents from patterns
- `enricher.*` — Add context and intelligence
- `notifier.*` — Communicate events
- `actions.*` — Propose safe remediation
- `openclaw.*` — Agent tool interfaces
- `ui.*` — Dashboard extensions

Each module is a self-contained package with:
- `index.ts` — Module implementation
- `schema.json` — Config validation schema
- `README.md` — Documentation
- `tests/` — Unit tests
