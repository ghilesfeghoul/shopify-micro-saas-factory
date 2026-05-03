# 🛠️ Opportunity Development

Troisième agent du système **Micro-SaaS Factory**. Génère des apps Shopify complètes (code + tests + configs + docs) à partir des spécifications techniques produites par [`opportunity-architecture`](../opportunity-architecture).

[![Version](https://img.shields.io/badge/version-1.0.0-blue)]()
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)]()
[![License](https://img.shields.io/badge/license-Private-red)]()

---

## 📋 Table des matières

- [Vue d'ensemble](#vue-densemble)
- [Démarrage rapide](#démarrage-rapide)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Utilisation](#utilisation)
- [Sécurité](#sécurité)
- [Déploiement](#déploiement)
- [Coûts](#coûts)
- [Maintenance](#maintenance)
- [Dépannage](#dépannage)

---

## Vue d'ensemble

### Ce que fait l'agent

L'agent Développeur prend une `TechnicalSpec` JSON canonique (sortie de l'Architecte) et **génère un repository Shopify app complet** :

- Code source TypeScript (backend + frontend Polaris)
- Schéma Prisma + repositories
- Tests Jest + Playwright
- Configuration Shopify (shopify.app.toml, scopes, webhooks GDPR)
- Documentation (README + guides)
- Repo Git autonome avec commits incrémentaux par phase

Il fait ça en orchestrant **plusieurs sous-agents Claude Code en parallèle**, chacun spécialisé dans un rôle (backend, UI, tests, config, docs), avec accès aux **skills installés** (Superpowers, Shopify officiels, custom).

### Pourquoi cet agent existe

Une spec technique JSON, même excellente, n'est pas du code qui tourne. Et générer du code Shopify de qualité production avec un seul prompt Claude est limité par :
- La fenêtre de contexte (perdre le détail sur des apps de 5000+ lignes)
- L'incohérence entre modules (backend invente un schéma DB différent de celui des repositories)
- L'oubli des contraintes Shopify (webhooks GDPR, scopes, App Bridge)

L'agent Développeur résout ça avec :
1. **Décomposition explicite** en chunks isolés et bien définis
2. **Sous-agents spécialisés** chacun avec un prompt système expert
3. **Skills locaux** distribués aux sous-agents pertinents
4. **Phase d'intégration** qui réconcilie les modules
5. **Repair loop** automatique si validation échoue

### Caractéristiques principales

- **Stratégie hybride** : orchestrateur central + sous-agents en parallèle + intégration finale
- **Claude Code par défaut** avec API en fallback (les sous-agents génèrent du vrai code, ils ont besoin des outils filesystem)
- **Skills auto-détectés** : Superpowers, skills Shopify officiels, custom paths
- **Output local** : repo Git autonome dans `/apps/SPEC-XXXX/` avec auto-commits par phase
- **Validation multi-niveaux** : TypeScript, lint, tests, compliance Shopify (GDPR webhooks, scopes, secrets)
- **Repair loop** : 3 tentatives max, sinon `needs_human_review`
- **Communication HMAC-signed** avec l'architecte (cohérent avec sécurité globale)
- **CLI complet** + API HTTP sécurisée (port 3002)

---

## Démarrage rapide

### Prérequis

- Node.js >= 20
- `opportunity-architecture` accessible et fonctionnel (avec son `HMAC_SECRET`)
- Soit Claude Code installé avec abonnement Pro/Max (recommandé), soit une clé Anthropic
- Git installé (pour les repos autonomes générés)

### Installation

```bash
cd shopify-micro-saas-factory/opportunity-development
npm install

cp .env.example .env
# Éditer .env (voir Configuration)

npm run db:generate
npm run db:push

# Tester la connexion à l'architecte
npm run test:architect

# Tester la détection des skills
npm run test:skills

# Tester Claude Code
npm run test:claude-code

# Première génération (sur une SPEC-XXXX existante côté architecte)
npm run generate SPEC-XXXX
```

Si tout se passe bien, tu verras le pipeline en action :

```
🛠️  Starting generation for SPEC-X7Y2...

📂 Workspace: /Users/.../apps/SPEC-X7Y2
🆔 App ID:    APP-K3M9
📋 Run ID:    cm9...

━━━ Phase: PLANNING ━━━

📐 Plan ready: 8 chunks

━━━ Phase: GENERATING ━━━

▶️  [00-CHK-A1B2] config     Initialize package.json + tsconfig + shopify.app.toml
▶️  [01-CHK-C3D4] database   Prisma schema + repositories
▶️  [02-CHK-E5F6] config     Setup .env.example + .gitignore
✅ [00-CHK-A1B2] completed in 245s ($1.234)
✅ [02-CHK-E5F6] completed in 187s ($0.567)
✅ [01-CHK-C3D4] completed in 412s ($2.103)
▶️  [03-CHK-G7H8] backend    Express + OAuth + GDPR webhooks
...

━━━ Phase: INTEGRATING ━━━
━━━ Phase: VALIDATING ━━━

✅ Validation passed

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:        ✅ completed
App ID:        APP-K3M9
Workspace:     /Users/.../apps/SPEC-X7Y2
Chunks:        8/8 successful
Duration:      52.3 min
Cost:          $11.234
Repair runs:   0

Next steps:
  cd apps/SPEC-X7Y2
  npm run dev
  cat README.md
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  opportunity-architecture (port 3001)                                │
│  Generates TechnicalSpec JSON                                        │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ ArchitectClient (HMAC signed)
                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  opportunity-development (port 3002)                                 │
│                                                                       │
│  Triggers:                                                            │
│   • CLI: npm run generate SPEC-XXXX                                  │
│   • API: POST /develop/generate                                      │
│   • n8n: scheduled poll of approved specs                            │
│                                                                       │
│  Pipeline:                                                            │
│   1. Fetch spec (HMAC call to architect)                             │
│   2. Setup workspace /apps/SPEC-XXXX/ + git init                     │
│   3. Detect skills (~/.claude/skills, ~/.claude/plugins, $SKILLS_PATH)│
│   4. PLAN: orchestrator LLM → 5-12 chunks DAG                        │
│   5. EXECUTE: parallel sub-agents (config, db, backend, ui, tests…)  │
│   6. INTEGRATE: cross-module coherence pass                          │
│   7. VALIDATE: npm install + tsc + lint + tests + Shopify compliance │
│   8. REPAIR (if needed): up to 3 retry attempts                      │
│   9. Mark in DB: completed | needs_human_review | failed             │
└──────────────────────────────────────────────────────────────────────┘
                         │ produces
                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  /apps/SPEC-XXXX/  ← autonomous Git repo                             │
│   .git/                                                              │
│   src/                                                               │
│     api/                                                             │
│     routes/                                                          │
│     repository/                                                      │
│     middleware/                                                      │
│   prisma/schema.prisma                                               │
│   tests/                                                             │
│   shopify.app.toml                                                   │
│   package.json                                                       │
│   README.md                                                          │
│   SPEC.md                ← markdown spec from architect              │
│   GENERATION_PLAN.json   ← chunks DAG                                │
│   INTEGRATION_REPORT.md                                              │
│   COMPLIANCE_REPORT.md                                               │
│   transcripts/<chunkId>.txt  ← per-sub-agent transcripts             │
└──────────────────────────────────────────────────────────────────────┘
```

### Structure du projet

```
opportunity-development/
├── prisma/
│   └── schema.prisma                  # GenerationRun + SubAgentTask
├── src/
│   ├── api/
│   │   └── server.ts                  # Express HTTP API (HMAC auth)
│   ├── architect-client/
│   │   ├── client.ts                  # HMAC client to architect
│   │   └── test-connection.ts
│   ├── auth/
│   │   ├── hmac.ts                    # HMAC sign/verify
│   │   └── ip-allowlist.ts            # IP CIDR filtering
│   ├── llm/
│   │   ├── provider.ts                # Common interface
│   │   ├── anthropic-api-provider.ts  # For short structured outputs
│   │   ├── claude-code-provider.ts    # Lightweight wrapper (--bare)
│   │   ├── factory.ts                 # Backend selection (default: auto)
│   │   └── test-claude-code.ts
│   ├── orchestrator/
│   │   ├── orchestrator.ts            # The brain — full pipeline
│   │   └── task-decomposer.ts         # Spec → DAG of chunks
│   ├── prompts/
│   │   ├── orchestrator-prompt.ts
│   │   ├── backend-agent-prompt.ts
│   │   ├── ui-agent-prompt.ts
│   │   ├── database-agent-prompt.ts
│   │   ├── tests-agent-prompt.ts
│   │   ├── config-agent-prompt.ts
│   │   └── specialized-agents-prompts.ts  # docs, integrator, repair
│   ├── skills/
│   │   ├── detector.ts                # Find SKILL.md files
│   │   ├── injector.ts                # Format for prompts
│   │   └── test-detection.ts
│   ├── spawn/
│   │   ├── claude-code-spawner.ts     # ★ Real code-gen subprocess
│   │   ├── parallel-pool.ts           # Bounded concurrency
│   │   └── sub-agent.ts               # SubAgent class
│   ├── storage/
│   │   └── repository.ts              # Prisma layer
│   ├── utils/
│   │   ├── id-generator.ts            # APP-XXXX, CHK-XXXX
│   │   ├── logger.ts
│   │   └── types.ts
│   ├── validation/
│   │   ├── runner.ts                  # npm install/tsc/lint/test
│   │   └── shopify-checks.ts          # GDPR webhooks, scopes, secrets
│   ├── workspace/
│   │   └── manager.ts                 # /apps/SPEC-XXXX/ lifecycle
│   └── cli.ts                         # CLI entry
├── deploy/
│   ├── docker-compose.yml
│   ├── development.Dockerfile
│   ├── caddy/Caddyfile
│   ├── n8n/sign-request.js
│   └── scripts/install.sh
├── docs/
│   ├── llm-backend-switching.md
│   ├── parallelization.md
│   └── skills-integration.md
├── n8n-workflow.json
├── .env.example
├── package.json
├── tsconfig.json
└── README.md                          # ← you are here
```

### Lifecycle d'une génération

```
pending ──► planning ──► generating ──► integrating ──► validating ──► completed
                                                              │
                                                              └──► repairing (max 3) ──► completed
                                                                                    └──► needs_human_review
                                                                                    └──► failed
```

---

## Configuration

### Backend LLM

Voir [docs/llm-backend-switching.md](./docs/llm-backend-switching.md) pour les détails. TL;DR :
- **Local sur Mac** : `LLM_BACKEND="auto"` (Claude Code prioritaire)
- **Production VPS** : `LLM_BACKEND="anthropic-api"` (mais perd les skills)

### Variables critiques

| Variable | Requis | Description |
|----------|--------|-------------|
| `LLM_BACKEND` | Oui | `auto` (recommandé), `claude-code`, `anthropic-api` |
| `HMAC_SECRET` | Oui | Secret de **ce** service (pour son API) |
| `ARCHITECT_URL` | Oui | URL de l'architecte (ex: `http://localhost:3001`) |
| `ARCHITECT_HMAC_SECRET` | Oui | **= `HMAC_SECRET` de l'architecte** |
| `IP_ALLOWLIST` | Oui | CIDR autorisés |
| `APPS_ROOT` | Non | Racine des workspaces (défaut: `./apps`) |
| `MAX_PARALLEL_SUBAGENTS` | Non | 1-10, défaut 3 |
| `SKILLS_PATH` | Non | Paths supplémentaires séparés par `:` |

### Génération des secrets

```bash
npm run secret:generate
```

---

## Utilisation

### Mode CLI

```bash
# Générer
npm run generate SPEC-XXXX                        # standard
npm run generate SPEC-XXXX -- --force             # écraser workspace existant
npm run generate SPEC-XXXX -- --skip-validation   # plus rapide, moins safe

# Lister les runs
npm run list
npm run list -- --status=completed
npm run list -- --status=needs_human_review

# Voir un run
npm run show APP-K3M9

# Re-valider un workspace
npm run validate APP-K3M9

# Retry (refait le run depuis le début, écrase le workspace)
npm run retry APP-K3M9

# Stats globales
npm run stats
```

### Mode API

```bash
npm run dev                       # dev mode hot reload
npm run build && npm start        # production
```

Endpoints :

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/health` | Health check (no auth) |
| POST | `/develop/generate` | Trigger generation (HMAC) |
| GET | `/develop/runs` | List runs (HMAC) |
| GET | `/develop/runs/:id` | Run details (HMAC) |
| PATCH | `/develop/runs/:id` | Update status (HMAC) |
| GET | `/develop/runs/:id/workspace` | Verify workspace exists (HMAC) |
| GET | `/develop/stats` | Global stats (HMAC) |

### Mode workflow n8n

Le workflow `n8n-workflow.json` :
1. Tourne quotidiennement à 10h
2. Récupère les specs `status=approved` de l'architecte
3. Pour chacune, déclenche une génération en mode async
4. Email digest à la fin

Variables n8n requises :
- `ARCHITECT_URL`, `ARCHITECT_HMAC_SECRET`
- `DEVELOPMENT_URL`, `DEVELOPMENT_HMAC_SECRET`
- `NOTIFICATION_FROM_EMAIL`, `NOTIFICATION_TO_EMAIL`

---

## Sécurité

Identique aux services siblings : 4 couches (Tailscale + Caddy + IP allowlist + HMAC). Voir le `deploy/README.md` du détecteur pour le détail.

**Spécificité du dev agent** : il **exécute du code généré dynamiquement** (npm install, tsc, tests). Mesures de sécurité :
- Workspaces isolés dans `/apps/SPEC-XXXX/` (jamais de write hors de là)
- Sub-agents lancés avec `bypassPermissions` mais avec `cwd` strictement borné au workspace
- Détection des secrets hardcodés via scan statique avant validation
- Pas d'exécution de code applicatif (les apps générées ne sont **jamais lancées** par cet agent — c'est à toi de faire `npm run dev` après)

---

## Déploiement

### Option 1 — Local sur Mac (recommandé)

```bash
LLM_BACKEND="auto"  # Claude Code + skills
ARCHITECT_URL="http://localhost:3001"
npm run dev
```

C'est l'option qui produit les meilleures apps (skills + Pro/Max gratuit).

### Option 2 — VPS pour automation 24/7

⚠️ Limites :
- Pas de skills accessibles
- API Anthropic obligatoire (pas de Claude Code OAuth en container persistant)

```bash
ssh root@TON_VPS
cd /opt
git clone https://github.com/ghilesfeghoul/shopify-micro-saas-factory.git msf-development
cd msf-development/opportunity-development
bash deploy/scripts/install.sh

nano .env  # ANTHROPIC_API_KEY + ARCHITECT_HMAC_SECRET

cd deploy && docker compose up -d
```

### Option 3 — Hybride (recommandé pour ton cas)

- VPS : détecteur + architecte tournent en cron 24/7
- Mac : dev agent local que tu lances toi-même quand une spec est approved
- n8n notifie par email "spec X est approved, prête à dev"
- Tu lances `npm run generate SPEC-X` quand tu as 1h devant toi

C'est le compromis qualité/coût/contrôle optimal.

---

## Coûts

### Mode local (Claude Code Pro/Max)

| Item | Coût |
|------|------|
| 1 app (60-80h estimées) | **0€ marginal** (consomme tes quotas hebdo) |
| 12 apps/an | **0€ marginal** |

### Mode API Anthropic

| Item | Coût |
|------|------|
| 1 app moyenne | 6-14€ |
| 12 apps/an | 72-168€ |
| 20 apps/an (objectif Y1) | 120-280€ |

Optimisations possibles :
- `MAX_PARALLEL_SUBAGENTS=2` réduit légèrement la facture en limitant les requêtes
- Switch vers Claude Sonnet (`CLAUDE_MODEL="claude-sonnet-4-6"`) : -75% du coût, qualité légèrement inférieure
- Mode local pour les apps complexes, mode API pour les simples

---

## Maintenance

### Voir les logs

```bash
tail -f logs/combined.log
```

### Inspecter un workspace

```bash
cd apps/SPEC-XXXX
git log --oneline           # Voir les commits par phase
cat GENERATION_PLAN.json    # Le plan d'exécution
cat COMPLIANCE_REPORT.md    # Vérifications Shopify
ls transcripts/             # Transcripts par sous-agent
```

### Nettoyer les workspaces

```bash
# Supprime un workspace après commit/push externe
rm -rf apps/SPEC-XXXX

# Liste tous les workspaces
ls -la apps/
```

### Migration vers PostgreSQL

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

---

## Dépannage

### "Claude Code binary not found"

Installer : `npm install -g @anthropic-ai/claude-code` puis `claude` (auth interactive).

### "Architect connection failed: 401"

`ARCHITECT_HMAC_SECRET` ne matche pas le `HMAC_SECRET` de l'architecte. Vérifier les deux côtés.

### "No skills detected"

Vérifier les paths : `ls ~/.claude/skills/` et `ls ~/.claude/plugins/`. Si tes skills sont ailleurs, configurer `SKILLS_PATH` dans .env.

### "Chunk failed: missing expected outputs"

Le sous-agent n'a pas créé les fichiers attendus. Inspecter le transcript : `cat apps/SPEC-XXXX/transcripts/<chunkId>.txt`. Causes courantes :
- Sous-agent timeout (augmenter le timeout du chunk)
- Sous-agent a interprété l'instruction différemment (raffiner le prompt)
- Skill manquant qui aurait été utile

### "needs_human_review" status

Le repair loop a échoué après 3 tentatives. Workflow :
1. `npm run show APP-XXXX` pour voir les chunks et erreurs
2. `cd apps/SPEC-XXXX && cat REPAIR_REPORT.md` (créé par le repair agent)
3. Corriger manuellement les erreurs résiduelles
4. `npm run validate APP-XXXX` pour re-valider
5. Marquer le run comme completed via API : `PATCH /develop/runs/:id { "status": "completed" }`

### Génération extrêmement lente

- Vérifier `MAX_PARALLEL_SUBAGENTS` (>= 2 conseillé)
- Vérifier que Claude Code n'est pas bloqué sur du `Bash` interactif (les sous-agents doivent tourner en `bypassPermissions`)
- Inspecter `transcripts/` pour voir si un sous-agent boucle

---

## Liens utiles

- [Service détecteur](../opportunity-detector/README.md)
- [Service architecte](../opportunity-architecture/README.md)
- [Blueprint complet du projet](../micro-saas-factory-blueprint.docx)
- [LLM backend switching](./docs/llm-backend-switching.md)
- [Parallélisation détaillée](./docs/parallelization.md)
- [Intégration des skills](./docs/skills-integration.md)

---

## License

Privé. Tous droits réservés.

CEO: [Ghiles FEGHOUL](mailto:ghiles.feghoul@gmail.com)

---

*Dernière mise à jour : avril 2026 — version 1.0.0*
