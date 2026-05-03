# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A monorepo containing 3 independent Node.js/TypeScript services that form a pipeline for automatically detecting Shopify app opportunities, generating technical specs, and producing complete app codebases via AI agents.

```
Opportunity Detector (port 3000)
  → Opportunity Architect (port 3001)
    → Opportunity Development (port 3002)
      → /apps/SPEC-XXXX/ (generated Git repos)
```

## Common Commands (per service)

Each service (`opportunity-detector/`, `opportunity-architecture/`, `opportunity-development/`) uses the same pattern:

```bash
npm run dev          # Hot-reload dev server (tsx watch)
npm run build        # Compile TypeScript → dist/
npm run start        # Run compiled output (production)
npm run db:push      # Sync Prisma schema to database
npm run db:studio    # Open Prisma Studio GUI (port 5555)
npm run db:generate  # Regenerate Prisma client after schema changes
```

Service-specific CLI commands:
```bash
# Detector
npm run scan         # Trigger full scan (all 4 sources)
npm run list         # List opportunities
npm run show OPP-XXXX
npm run stats

# Architect
npm run generate OPP-XXXX   # Generate spec for opportunity
npm run poll                # Auto-trigger for score >= 40
npm run show SPEC-XXXX
npm run render SPEC-XXXX    # Export spec to .md file

# Development
npm run generate SPEC-XXXX  # Generate full app code
npm run show APP-XXXX
npm run retry APP-XXXX
npm run validate APP-XXXX
```

There are no automated tests beyond smoke tests (`npm run test:*` checks connectivity only).

## Architecture

### Tech Stack (all 3 services)
- **TypeScript 5.7** (strict mode), **Node.js >= 20**, **CommonJS output**
- **Express 4** for HTTP APIs
- **Prisma 5** with **SQLite** (PostgreSQL-ready — change provider in `prisma/schema.prisma`)
- **Zod** for runtime validation
- **@anthropic-ai/sdk** for Claude API; also supports Claude Code CLI subprocess

### LLM Backend Abstraction
Each service has a `src/llm/` directory with a provider interface and two concrete implementations:
- `anthropic-api` — uses `@anthropic-ai/sdk` (paid)
- `claude-code` — spawns Claude Code CLI subprocess (free with Pro/Max quota)
- `auto` — tries Claude Code first, falls back to API

Controlled via `LLM_BACKEND` env var.

### Security (4 layers, every service)
1. **Tailscale VPN** — hides from public internet
2. **Caddy HTTPS** — TLS termination
3. **IP CIDR allowlist** — `IP_ALLOWLIST` env var (e.g., `100.64.0.0/10,127.0.0.1`)
4. **HMAC-SHA256 request signing** — headers `X-Timestamp`, `X-Nonce`, `X-Signature`; 5-minute replay window

**Inter-service HMAC**: Each service has its own `HMAC_SECRET` (to authenticate inbound requests) plus a `XXX_HMAC_SECRET` (to sign outbound requests to the upstream service). These must match across services.

### Data Flow & IDs
- Detector produces `OPP-XXXX` opportunities (scored 0–50)
- Architect consumes `OPP-XXXX`, produces `SPEC-XXXX` specs (JSON canonical + markdown render)
- Development consumes `SPEC-XXXX`, produces `APP-XXXX` generation runs and `/apps/SPEC-XXXX/` workspaces

### Development Agent Internals
The most complex service. Generation runs through 8 phases: `planning → generating → integrating → validating → repairing (max 3 attempts) → completed | needs_human_review | failed`

Sub-agents are specialized Claude Code instances (backend, ui, database, tests, config, docs, integrator, repair). Skills are auto-detected from `~/.claude/skills`, `~/.claude/plugins`, and `SKILLS_PATH` env var, then injected into sub-agent prompts.

Generated apps land in `APPS_ROOT` (default `./apps/`) as autonomous Git repos with per-phase commits.

## Environment Variables

Each service has a `.env.example`. Critical variables:

| Variable | Where | Purpose |
|---|---|---|
| `LLM_BACKEND` | all | `anthropic-api` \| `claude-code` \| `auto` |
| `ANTHROPIC_API_KEY` | all | Required if `LLM_BACKEND=anthropic-api` |
| `HMAC_SECRET` | all | 32+ hex chars; generate with `npm run secret:generate` |
| `IP_ALLOWLIST` | all | CIDR ranges allowed to call this service |
| `DETECTOR_URL` + `DETECTOR_HMAC_SECRET` | architect | Points to detector service |
| `ARCHITECT_URL` + `ARCHITECT_HMAC_SECRET` | development | Points to architect service |
| `APPS_ROOT` | development | Where generated app workspaces are written |
| `MAX_PARALLEL_SUBAGENTS` | development | 1–10, default 3 |

## Key Source Locations

| Path | What it is |
|---|---|
| `*/src/api/server.ts` | Express server entry point |
| `*/src/llm/provider.ts` | LLM provider interface |
| `*/src/auth/` | HMAC signing + IP allowlist middleware |
| `*/prisma/schema.prisma` | Database schema |
| `opportunity-development/src/orchestrator/` | 8-phase generation pipeline |
| `opportunity-development/src/spawn/` | Sub-agent spawning (Claude Code + parallel pool) |
| `opportunity-development/src/prompts/` | 8 specialized agent system prompts |
| `opportunity-detector/CLAUDE.md` | Detailed guide for the detector service |

## Deployment

**Local dev**: Run each service with `npm run dev` in its directory. Use `LLM_BACKEND=claude-code` to avoid API costs.

**Production**: `cd opportunity-[service]/deploy && docker compose up -d`. Includes PostgreSQL, n8n (orchestration), Caddy, and Tailscale. Each service has a `deploy/` directory with `docker-compose.yml`, `Caddyfile`, `Dockerfile`, and setup scripts.

**n8n automation**: Each service includes an importable `n8n-workflow.json` for scheduled triggers (detector: weekly, architect: daily polling, development: daily generation).
