# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

**Opportunity Architecture** is the second agent in the Micro-SaaS Factory pipeline. It consumes high-scoring opportunities (score ≥ 40) from `opportunity-detector` (port 3000) and generates complete technical specifications (SPEC-XXXX format) for Shopify apps using an LLM backend.

## Commands

```bash
# Development
npm run dev           # Hot-reload dev server (tsx watch)
npm run build         # Compile TypeScript → dist/
npm start             # Run compiled production binary

# Database
npm run db:push       # Apply Prisma schema migrations
npm run db:studio     # Open Prisma Studio (visual editor)
npm run db:generate   # Regenerate Prisma client after schema changes

# CLI Operations
npm run generate OPP-XXXX   # Manually trigger spec generation
npm run list                # List all specs (supports --status, --limit flags)
npm run show SPEC-XXXX      # View spec (add --markdown or --json)
npm run render SPEC-XXXX    # Export spec to .md file
npm run stats               # Display generation statistics
npm run poll                # Manual detector poll + auto-trigger

# Testing / Diagnostics
npm run test:claude-code    # Test Claude Code provider smoke test
npm run test:detector       # Test detector connection
npm run secret:generate     # Generate a random HMAC secret
```

## Architecture

### Service Flow
```
opportunity-detector (port 3000)
        │  HMAC-signed HTTP (DetectorClient)
        ▼
opportunity-architecture (port 3001)
  1. Fetch opportunity from detector
  2. Cache locally (OpportunityCache table)
  3. Call LLM → validated TechnicalSpec JSON
  4. Persist spec (ArchitectureSpec table)
  5. Render Markdown on-demand from JSON
```

### Trigger Modes
- **Auto**: Poller cron checks detector; score ≥ `AUTO_TRIGGER_SCORE_THRESHOLD` (default 40) triggers generation
- **Manual CLI**: `npm run generate OPP-XXXX`
- **API**: `POST /architect/generate` (HMAC-protected)

### LLM Backends
Selected via `LLM_BACKEND` env var. Two implementations share a common interface:
- `anthropic-api` — uses `@anthropic-ai/sdk` with `tool_use` for structured output
- `claude-code` — spawns Claude Code CLI with `--json-schema` enforcement
- `auto` — prefers Claude Code if binary found, falls back to API

Factory is in `src/llm/factory.ts`. Both backends return identical response format.

### Key Source Directories
- `src/architect/` — LLM prompt, Zod schema, Markdown renderer
- `src/llm/` — LLM provider interface + two implementations + factory
- `src/scoring/` — Orchestrator (full pipeline) and poller (auto-trigger)
- `src/detector-client/` — HMAC-signed HTTP client to opportunity-detector
- `src/auth/` — HMAC middleware + IP allowlist CIDR filtering
- `src/storage/repository.ts` — All Prisma database operations
- `src/api/server.ts` — Express server + all HTTP endpoints
- `src/cli.ts` — CLI entry point

### Database (Prisma + SQLite)
Four tables:
- **OpportunityCache** — local mirror of detector opportunities
- **ArchitectureSpec** — generated specs (`specJson` is canonical; Markdown is never persisted)
- **ArchitectRun** — per-generation audit log
- **PollRun** — per-poll-cycle audit log

Spec versioning: regenerating an opportunity marks the previous spec `isActive=false` and increments `version`.

### Security (4 layers)
1. Tailscale VPN (deployment)
2. Caddy HTTPS reverse proxy (deployment)
3. IP allowlist (`IP_ALLOWLIST` CIDR env var) — Express middleware
4. HMAC-signed requests with nonce + timestamp validation

**Critical**: `HMAC_SECRET` (this service's own secret) and `DETECTOR_HMAC_SECRET` (used to sign calls *to* the detector) must be different values.

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | SQLite path (default) or PostgreSQL URL |
| `LLM_BACKEND` | `anthropic-api` \| `claude-code` \| `auto` |
| `ANTHROPIC_API_KEY` | Required when using `anthropic-api` backend |
| `CLAUDE_MODEL` | Default: `claude-opus-4-7` |
| `HMAC_SECRET` | This service's HMAC secret (32+ chars, unique) |
| `DETECTOR_HMAC_SECRET` | Detector's HMAC secret (for signing calls to detector) |
| `DETECTOR_URL` | URL of opportunity-detector (default: `http://localhost:3000`) |
| `PORT` | Default `3001` (detector uses 3000) |
| `AUTO_TRIGGER_SCORE_THRESHOLD` | Min score for auto-generation (default `40`) |

## Spec Schema

The generated `TechnicalSpec` has 11 sections defined in `src/architect/schemas/spec-schema.ts`:
`overview`, `architecture`, `shopify`, `apiEndpoints`, `database`, `ui`, `testing`, `stack`, `estimation`, `compliance`, `metadata`

Zod validates at runtime; JSON Schema constrains LLM output. Schema version tracked in `specSchemaVersion` field for future migrations.

## TypeScript

Strict mode is fully enabled including `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`. Target is ES2022, module is CommonJS, output to `./dist`.
