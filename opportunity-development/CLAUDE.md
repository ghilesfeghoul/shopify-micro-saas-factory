# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Service Role

This is the **Opportunity Development** service (port 3002). It consumes `SPEC-XXXX` specs from the Architect service and generates complete Shopify app codebases by orchestrating a DAG of specialized Claude Code sub-agents. Generated apps land in `APPS_ROOT` (default `./apps/SPEC-XXXX/`) as autonomous Git repos.

## Commands

```bash
npm run dev          # Hot-reload dev server
npm run build        # Compile TypeScript → dist/
npm run start        # Run compiled output

# Database
npm run db:push      # Sync Prisma schema to SQLite
npm run db:studio    # Open Prisma Studio (port 5555)
npm run db:generate  # Regenerate Prisma client after schema changes

# CLI (use tsx src/cli.ts or the npm aliases)
npm run generate SPEC-XXXX   # Trigger app generation
npm run show APP-XXXX        # Show generation run details
npm run retry APP-XXXX       # Retry a failed run
npm run validate APP-XXXX    # Re-validate a workspace
npm run list                 # List all runs
npm run stats                # Global statistics

# Smoke tests (connectivity only)
npm run test:claude-code     # Test Claude Code binary
npm run test:architect       # Test Architect service connection
npm run test:skills          # Test skill detection (shows count)
```

## Architecture

### The 8-Phase Pipeline (`src/orchestrator/orchestrator.ts`)

`orchestrate(specId)` drives the lifecycle stored as `status` on `GenerationRun`:

1. **Setup** — Create `/apps/SPEC-XXXX/`, init Git, write `SPEC.md`, initial commit
2. **Planning** — Decompose spec into 5–12 chunks via LLM → validate DAG (no cycles) → write `GENERATION_PLAN.json`
3. **Generating** — Execute chunk DAG with bounded parallelism (default 3 concurrent); each chunk = one Claude Code sub-agent subprocess
4. **Integrating** — Single "integrator" sub-agent fixes cross-module inconsistencies (schema/endpoint mismatches, missing imports)
5. **Validating** — `validateWorkspace()`: npm install → tsc → lint → tests; builds a `ValidationSummary`
6. **Repairing** — Up to 3 repair attempts; each spawns a "repair" sub-agent with the error report, then re-validates
7. **Compliance** — Check GDPR webhooks, Shopify scopes, secrets; write `COMPLIANCE_REPORT.md`
8. **Finalize** — Status becomes `completed`, `needs_human_review`, or `failed`

### Task Decomposition (`src/orchestrator/task-decomposer.ts`)

Calls the LLM with `ORCHESTRATOR_SYSTEM_PROMPT` to produce a chunk DAG. LLM returns positional dependency indices which are remapped to actual chunk IDs. Cycles are rejected with DFS. Chunks are typed with `SubAgentRole`: `backend | ui | database | tests | config | docs | integrator | repair`.

### Sub-Agent Spawning (`src/spawn/`)

- **`claude-code-spawner.ts`** — Runs `claude -p --output-format json --permission-mode bypassPermissions` as a subprocess. Sub-agents get full filesystem tools (Read/Write/Edit/Bash/Glob/Grep) plus all user-installed skills. Working directory = workspace.
- **`parallel-pool.ts`** — `p-limit`-based bounded concurrency. `MAX_PARALLEL_SUBAGENTS` env var (1–10, default 3).
- **`sub-agent.ts`** — Wraps spawner: snapshots FS before/after to diff created/modified files, picks role-appropriate skills, verifies expected outputs, returns `SubAgentResult`.

### Skill Detection & Injection (`src/skills/`)

- **`detector.ts`** — Scans three sources: `~/.claude/skills/`, `~/.claude/plugins/installed_plugins.json` (registry-based, versioned cache paths), and `SKILLS_PATH` env var. Plugin skills are namespaced `pluginName:skillName`. Returns `DetectedSkill[]` with extracted tags.
- **`injector.ts`** — `pickRelevantSkills(role, skills)` filters by tags (e.g., backend → shopify/oauth/superpowers; ui → polaris/react/app-bridge). Formats a markdown table appended to each sub-agent's system prompt so sub-agents self-discover and self-apply skills.

### LLM Backend (`src/llm/`)

Controlled by `LLM_BACKEND` env var (`auto` | `claude-code` | `anthropic-api`). `auto` tries Claude Code first, falls back to API. The orchestrator's decomposition and compliance calls use `--bare --json-schema` (structured output), while sub-agents use full agent mode (no `--bare`).

### Data Models (`prisma/schema.prisma`)

Two models:
- `GenerationRun` — One per spec. Tracks status, chunk counts, costs, validation/repair/compliance results.
- `SubAgentTask` — One per chunk per run. Tracks role, instruction, dependencies, filesCreated/Modified, cost, duration.

### Key Type Definitions (`src/utils/types.ts`)

`TechnicalSpec`, `TaskChunk`, `SubAgentResult`, `GenerationStatus`, `SubAgentRole` — understand these before touching the orchestrator or spawner.

## Environment Variables

See `.env.example`. Critical ones not obvious from the parent CLAUDE.md:

| Variable | Default | Notes |
|---|---|---|
| `CLAUDE_CODE_TIMEOUT_MS` | `1800000` | 30 min per sub-agent; increase for large chunks |
| `CLAUDE_CODE_USE_BARE` | `false` | Must stay false — sub-agents need filesystem tools |
| `CLAUDE_MODEL` | `claude-opus-4-7` | Model used when `LLM_BACKEND=anthropic-api` |
| `GIT_AUTHOR_NAME/EMAIL` | MSF Dev Agent | Identity for commits inside generated workspaces |
| `MAX_PARALLEL_SUBAGENTS` | `3` | Increase carefully — Claude Code quota limits apply |
| `SKILLS_PATH` | `` | Colon-separated extra skill directories |

## Prompts (`src/prompts/`)

Each of the 8 roles has a system prompt file. The orchestrator and integrator prompts are also here. When editing prompts, the key constraint is that sub-agents must emit valid JSON in their final output (the spawner parses it to extract cost/status).
