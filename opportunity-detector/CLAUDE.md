# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Setup (first time)
npm install
npx playwright install chromium
npm run db:generate
npm run db:push

# Development
npm run dev                              # API server (tsx watch, port 3000)
npm run scan                             # Full scan (all 4 sources)
npm run scan -- --source=appstore        # Shopify App Store only
npm run scan -- --source=reddit          # Reddit only
npm run scan -- --source=community       # Shopify Community only
npm run scan -- --source=producthunt     # Product Hunt only
npm run scan -- --skip-analysis          # Scrape + save, no LLM call
npm run list                             # List opportunities
npm run show OPP-XXXX                    # Detail view for one opportunity
npm run stats                            # Global stats (signals, opps, scan runs)

# Build & production
npm run build && npm start

# DB
npm run db:studio                        # Prisma Studio at localhost:5555
npm run db:generate                      # Regenerate Prisma client after schema changes
npm run db:push                          # Push schema to DB (dev only, no migration file)

# Utilities
npm run test:claude-code                 # Smoke test Claude Code CLI round-trip
npm run secret:generate                  # Generate a 32-byte HMAC secret
```

No test suite — `npm run test:claude-code` is the only automated check.

## Architecture

Pipeline: **Scrapers → RawSignal storage → LLM analysis → Opportunity storage → CLI / API**

### Scrapers (`src/scrapers/`)

Four scrapers, all return `RawSignal[]`.

| File | Source key | Strategy | Fragile parts |
|------|------------|----------|---------------|
| `shopify-appstore.ts` | `shopify_appstore` | Playwright headless browser — sitemap discovery → JSON interception + DOM fallback for reviews | CSS selectors break when Shopify updates DOM. Sitemap URL format can change. |
| `shopify-community.ts` | `shopify_community` | Discourse JSON API (axios, no browser) — latest topics, monthly top, 19 pain-point keyword searches | Category IDs hardcoded (`shopify-apps:186`, `technical-qa:211`, `shopify-discussion:95`) — verify if topics stop returning data. |
| `reddit.ts` | `reddit` | Reddit `.json` API (axios) — hot, top/week, top/month per subreddit + 12 search queries per subreddit | Must use a descriptive `User-Agent` (e.g. `OpportunityDetector/1.0`). Googlebot UA → 403. |
| `producthunt.ts` | `producthunt` | **Without token**: Atom feeds (`/feed?category=X`) with browser headers, 10 categories × 50 entries. **With token**: GraphQL API, 7 topics × 40 posts (paginated). | Atom feeds require full browser `Accept` headers — plain `axios.get` without them returns 0 items. |

**Signal types**: `negative_review` (App Store) · `forum_post` (Reddit, Community) · `product_launch` (Product Hunt)

**Deduplication**: `sourceUrl @unique` on `RawSignal` — upsert silently skips duplicates across runs.

### LLM abstraction (`src/llm/`)

Two providers behind `LLMProvider` interface, selected via `LLM_BACKEND`:
- `anthropic-api` — uses `tool_use` to force JSON output
- `claude-code` — uses `claude` CLI with `--json-schema` flag, no API cost, requires `claude` in PATH
- `auto` — tries `anthropic-api`, falls back to `claude-code`

Output is always validated with `AnalysisOutputSchema` (Zod, `src/utils/types.ts`). `total_score` is **recomputed client-side** — never trust the LLM value.

### Scoring (`src/scoring/analyzer.ts`, `src/prompts/detector-prompt.ts`)

Fetches unprocessed `RawSignal` records in batches, sends to LLM with the French system prompt, validates each returned `Opportunity` via `OpportunitySchema`, discards anything below `MIN_SCORE_THRESHOLD`.

Scoring dimensions (each 0–10, total 0–50):
- `market_size` — breadth of affected merchants
- `urgency` — severity of the pain (revenue impact, blocking)
- `feasibility` — buildable by an AI agent in 1–3 weeks
- `monetization` — willingness to pay, pricing potential
- `competition` — **inverted**: 10 = no competitors or all poorly rated

The system prompt is in French and targets the Shopify micro-SaaS context specifically.

### Storage (`prisma/schema.prisma`)

Four models:
- `RawSignal` — raw scraper output, `sourceUrl` unique, `processed` flag
- `Opportunity` — scored opportunity with status (`new` · `reviewed` · `building` · `shipped` · `rejected`)
- `OpportunitySignal` — M2M join between opportunities and their source signals
- `ScanRun` — audit log per pipeline execution

Default: SQLite (`file:./dev.db`). Switch to PostgreSQL: change `provider` in schema + `DATABASE_URL`.

### API (`src/api/server.ts`)

Express server, port 3000. Auth on all routes except `/health`: **IP allowlist → HMAC**.

HMAC scheme: `HMAC-SHA256(timestamp + "." + nonce + "." + method + "." + path + "." + body)`. Replay window: 5 minutes. See `deploy/n8n/sign-request.js` for n8n signing reference.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth) |
| `POST` | `/scan` | Trigger scan. Body: `{ source?, minScore?, maxOpportunities?, async? }` |
| `GET` | `/opportunities` | List. Query: `status?`, `minScore?`, `limit?` (default 50) |
| `GET` | `/opportunities/:id` | Single opportunity |
| `PATCH` | `/opportunities/:id` | Update `status` / `reviewNotes` |
| `GET` | `/scans/recent` | Last 10 scan runs |

Rate limits: `/scan` → 10/hour per IP · read endpoints → 60/minute.

## Key env vars

| Var | Default | Notes |
|-----|---------|-------|
| `LLM_BACKEND` | `anthropic-api` | `claude-code` for free local use |
| `ANTHROPIC_API_KEY` | — | Required if `LLM_BACKEND=anthropic-api` |
| `HMAC_SECRET` | — | 32+ char secret, generate with `npm run secret:generate` |
| `IP_ALLOWLIST` | — | Comma-separated CIDRs, e.g. `100.64.0.0/10,127.0.0.1` |
| `DATABASE_URL` | — | e.g. `file:./dev.db` for SQLite |
| `MIN_SCORE_THRESHOLD` | `25` | Opportunities below this are discarded (max 50) |
| `MAX_SIGNALS_PER_SCAN` | `200` | Cap on signals fed to LLM per run |
| `MAX_OPPORTUNITIES_PER_SCAN` | `15` | Cap on opportunities saved per run |
| `PRODUCT_HUNT_TOKEN` | — | Optional. Without it, falls back to Atom feeds (still works well) |
| `REDDIT_USER_AGENT` | — | Overrides default UA. Must be descriptive — Googlebot-style UAs are blocked. |
| `PORT` | `3000` | API server port |

## Deployment

- **Local (dev)**: `LLM_BACKEND=claude-code`, no API cost, requires `claude` CLI in PATH
- **Production (VPS)**: Docker Compose in `deploy/` — detector + n8n + Caddy reverse proxy
- Bootstrap: `bash deploy/scripts/install.sh` on a fresh Hetzner VPS

## Known gotchas

- **Product Hunt Atom feeds** return 0 items without a full browser `Accept` header. The old RSS code used `<item>` but PH uses Atom `<entry>` tags.
- **Reddit API** returns 403 if the User-Agent looks like a fake Googlebot. Use a plain descriptive UA.
- **Shopify App Store** scraper uses JSON response interception for reviews — if Shopify changes their review API endpoint the interceptor silently falls back to DOM scraping.
- **Discourse category IDs** in the Community scraper are hardcoded. If a category is restructured, the ID breaks silently (returns 0 topics). Check `fetchCategoryTopics` in `shopify-community.ts`.
- **`total_score` is always recomputed** client-side in `analyzer.ts` — the LLM's own sum is ignored.
