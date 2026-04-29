# 🏗️ Opportunity Architecture

Deuxième agent du système **Micro-SaaS Factory**. Génère des spécifications techniques complètes d'apps Shopify à partir des opportunités scorées par [`opportunity-detector`](../opportunity-detector).

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
- [Roadmap](#roadmap)

---

## Vue d'ensemble

### Ce que fait l'agent

L'agent architecte récupère les opportunités scorées par le détecteur, et pour chacune génère une **spécification technique complète** d'app Shopify : architecture, endpoints API, schéma DB, scopes OAuth justifiés, webhooks GDPR obligatoires, écrans UI Polaris, plan de tests, dépendances, estimation, risques. Le résultat est un contrat machine-lisible (JSON canonique) qui sera consommé par le futur Agent Développeur.

### Pourquoi cet agent existe

Entre identifier une opportunité et coder une app, il y a une étape critique : la **conception technique**. C'est là où les choix structurants se font (Remix ou Express ? GraphQL ou REST ? quels scopes ?), et c'est là où 80% des apps Shopify se font rejeter de l'App Store (oubli des webhooks GDPR, scopes injustifiés, mauvaise gestion des rate limits).

L'agent architecte automatise cette étape avec **toute l'expertise Shopify embedded dans le system prompt** : règles non-négociables, conventions naming, patterns d'authentification, politique App Store. Il ne peut pas oublier les webhooks GDPR — c'est dans la validation business rules.

### Caractéristiques principales

- **Mode hybride** : auto-trigger pour score ≥ 40, manuel sinon
- **Backend LLM interchangeable** : Anthropic API ou Claude Code CLI (même abstraction que le détecteur)
- **Sortie double format** : JSON canonique (source de vérité) + Markdown rendu à la volée
- **Validation stricte multi-niveaux** : JSON Schema (LLM) → Zod (runtime) → règles business (GDPR, scopes)
- **Versioning des specs** : régénération possible, historique conservé
- **Communication HMAC-signed avec le détecteur** : aucun secret ne transite en clair
- **CLI complet** : generate, list, show, render, poll, stats, status
- **API HTTP sécurisée** : 4 couches identiques au détecteur

---

## Démarrage rapide

### Prérequis

- Node.js >= 20
- `opportunity-detector` accessible et fonctionnel (avec son `HMAC_SECRET`)
- Soit une clé Anthropic, soit Claude Code installé avec abonnement Pro/Max

### Installation

```bash
# 1. Cloner le service
cd shopify-micro-saas-factory/opportunity-architecture
npm install

# 2. Configurer
cp .env.example .env
# Éditer .env (voir Configuration)

# 3. Initialiser la base
npm run db:generate
npm run db:push

# 4. Tester la connexion au détecteur
npm run test:detector

# 5. Première génération manuelle (utilise une OPP-XXXX existante)
npm run generate OPP-A1B2
```

Si tout se passe bien :

```
🏗️  Generating spec for OPP-A1B2...

✅ Spec created: SPEC-X7Y2
   Duration: 47.3s
   Cost: $1.2340

   View: npm run show SPEC-X7Y2
```

Puis pour voir le résultat :

```bash
npm run show SPEC-X7Y2                            # résumé
npm run show SPEC-X7Y2 -- --format=markdown       # markdown complet
npm run render SPEC-X7Y2 -- --output=spec.md      # markdown vers fichier
```

---

## Architecture

### Vue générale

```
┌──────────────────────────────────────────────────────────────────────┐
│  opportunity-detector (port 3000)                                    │
│  • Identifie et score les opportunités                               │
│  • Expose API HMAC-protected                                         │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ DetectorClient (HMAC signed)
                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  opportunity-architecture (port 3001)                                │
│                                                                       │
│  Triggers:                                                            │
│   • Auto: poller (cron) → score >= 40                                │
│   • Manuel: CLI npm run generate OPP-XXXX                            │
│   • API: POST /architect/generate                                    │
│                                                                       │
│  Pipeline:                                                            │
│   1. Fetch opportunity (HMAC call to detector)                       │
│   2. Cache locally (OpportunityCache table)                          │
│   3. Build user prompt with full opportunity context                 │
│   4. Call LLM (tool_use forced or --json-schema)                     │
│   5. Validate via Zod                                                │
│   6. Enforce business rules (GDPR, scope justifications)             │
│   7. Persist (ArchitectureSpec table, JSON canonical)                │
│   8. Optionally update detector status to "building"                 │
│                                                                       │
│  Output formats:                                                      │
│   • JSON: stored in DB, returned by API                              │
│   • Markdown: rendered on-demand from JSON                           │
└──────────────────────────────────────────────────────────────────────┘
```

### Structure du projet

```
opportunity-architecture/
├── prisma/
│   └── schema.prisma                  # OpportunityCache + ArchitectureSpec + runs
├── src/
│   ├── api/
│   │   └── server.ts                  # Express HTTP API (HMAC auth)
│   ├── architect/
│   │   ├── prompts/
│   │   │   └── architect-prompt.ts    # System prompt with Shopify expertise
│   │   ├── schemas/
│   │   │   └── spec-schema.ts         # Zod + JSON Schema for the spec
│   │   ├── generators/
│   │   │   └── markdown-renderer.ts   # JSON → Markdown
│   │   └── generator.ts               # LLM call + validation pipeline
│   ├── auth/
│   │   ├── hmac.ts                    # HMAC sign/verify
│   │   └── ip-allowlist.ts            # IP CIDR filtering
│   ├── detector-client/
│   │   ├── client.ts                  # HMAC-signed HTTP client to detector
│   │   └── test-connection.ts         # Smoke test
│   ├── llm/
│   │   ├── provider.ts                # Common interface
│   │   ├── anthropic-api-provider.ts
│   │   ├── claude-code-provider.ts
│   │   ├── factory.ts                 # Backend selection
│   │   └── test-claude-code.ts        # Smoke test
│   ├── scoring/
│   │   ├── orchestrator.ts            # Full pipeline
│   │   └── poller.ts                  # Auto-trigger for score >= 40
│   ├── storage/
│   │   └── repository.ts              # Prisma layer
│   ├── utils/
│   │   ├── id-generator.ts            # SPEC-XXXX
│   │   ├── logger.ts
│   │   └── types.ts
│   └── cli.ts                         # CLI entry point
├── deploy/
│   ├── docker-compose.yml             # Service-only compose
│   ├── architect.Dockerfile
│   ├── caddy/Caddyfile
│   ├── n8n/sign-request.js            # n8n HMAC signing
│   ├── scripts/install.sh
│   └── README.md                      # Deployment guide
├── docs/
│   └── llm-backend-switching.md
├── n8n-workflow.json                  # Daily poll workflow
├── .env.example
├── package.json
├── tsconfig.json
└── README.md                          # ← you are here
```

### Schéma de la spec technique

Chaque spec contient ces sections (toutes obligatoires) :

| Section | Contenu |
|---------|---------|
| `overview` | App name, tagline, description, target merchants, MVP scope |
| `architecture` | Pattern, framework, database, diagramme textuel |
| `shopify` | Scopes (avec justification), webhooks (incluant GDPR), API version, App Bridge, rate limits |
| `apiEndpoints` | Liste exhaustive avec method, path, params, response, error cases |
| `database` | Tables Prisma avec types, indexes, relations |
| `ui` | Écrans avec composants Polaris, actions utilisateur |
| `testing` | Stratégie, target coverage, cas de test |
| `stack` | Runtime, langage, dépendances avec versions |
| `estimation` | Hours, complexity, breakdown, risks, blockers |
| `compliance` | GDPR webhooks, policy checks, App Store category |

### Lifecycle d'une spec

```
draft ──► reviewed ──► approved ──► building ──► (ready for Developer Agent)
   └──► rejected (avec rejectionReason)
   └──► archived
```

### Système de trigger

| Trigger | Quand | Source |
|---------|-------|--------|
| `auto` | Score ≥ 40 (configurable) | Poller cron / n8n |
| `manual` | À la demande | CLI `npm run generate` |
| `api` | À la demande | `POST /architect/generate` |
| `regenerate` | Avec `--force` | CLI ou API |

---

## Configuration

### Backend LLM

Identique au détecteur. Voir [docs/llm-backend-switching.md](./docs/llm-backend-switching.md).

**Tests locaux (Pro/Max gratuit)** :
```bash
LLM_BACKEND="claude-code"
CLAUDE_CODE_USE_BARE="false"  # important pour utiliser ton OAuth
```

**Production** :
```bash
LLM_BACKEND="anthropic-api"
ANTHROPIC_API_KEY="sk-ant-..."
CLAUDE_MODEL="claude-opus-4-7"
```

### Variables d'environnement

| Variable | Requis | Description |
|----------|--------|-------------|
| `LLM_BACKEND` | Oui | `anthropic-api`, `claude-code`, ou `auto` |
| `ANTHROPIC_API_KEY` | Si API | Clé Anthropic |
| `HMAC_SECRET` | Oui | Secret de **ce** service (différent du détecteur) |
| `IP_ALLOWLIST` | Oui | CIDR autorisés |
| `DETECTOR_URL` | Oui | URL du service détecteur (ex: `http://detector:3000`) |
| `DETECTOR_HMAC_SECRET` | Oui | **= `HMAC_SECRET` du détecteur** (pour signer les appels) |
| `AUTO_TRIGGER_SCORE_THRESHOLD` | Non | Seuil auto-trigger (défaut: 40) |
| `POLL_LIMIT` | Non | Max opportunités par poll (défaut: 50) |

⚠️ **Important** : `HMAC_SECRET` (le secret de **cet** API) et `DETECTOR_HMAC_SECRET` (le secret du détecteur, utilisé pour l'appeler) doivent être **deux valeurs différentes**. C'est le principe du moindre privilège — chaque service a son propre secret.

### Génération des secrets

```bash
# HMAC secret du service
npm run secret:generate
```

---

## Utilisation

### Mode CLI

**Générer une spec manuellement** :
```bash
# Génération basique
npm run generate OPP-A1B2

# Forcer la régénération (écrase la version active)
npm run generate OPP-A1B2 -- --force

# Synchroniser avec le détecteur (status → "building")
npm run generate OPP-A1B2 -- --sync-status
```

**Lister les specs** :
```bash
# Specs actives uniquement
npm run list

# Toutes versions confondues
npm run list -- --all

# Filtrer par status
npm run list -- --status=approved

# Filtrer par opportunité
npm run list -- --opportunity=OPP-A1B2
```

**Voir une spec** :
```bash
# Résumé
npm run show SPEC-X7Y2

# Markdown complet
npm run show SPEC-X7Y2 -- --format=markdown

# JSON brut
npm run show SPEC-X7Y2 -- --format=json
```

**Exporter en Markdown** :
```bash
npm run render SPEC-X7Y2 -- --output=specs/SPEC-X7Y2.md
```

**Lancer un poll manuel** :
```bash
npm run poll
```

**Mettre à jour le statut** :
```bash
tsx src/cli.ts status SPEC-X7Y2 reviewed
tsx src/cli.ts status SPEC-X7Y2 approved
tsx src/cli.ts status SPEC-X7Y2 rejected --reason="MVP trop ambitieux pour 1ère release"
```

**Stats** :
```bash
npm run stats
```

### Mode API

**Démarrer le serveur** :
```bash
npm run dev          # dev avec hot reload
npm run build && npm start    # production
```

**Endpoints disponibles** :

| Méthode | Endpoint | Description | Auth |
|---------|----------|-------------|------|
| GET | `/health` | Health check | Aucune |
| POST | `/architect/generate` | Générer une spec | HMAC |
| POST | `/architect/poll` | Poll détecteur + auto-trigger | HMAC |
| GET | `/specs` | Liste paginée | HMAC |
| GET | `/specs/:id` | Détail (`?format=json|markdown`) | HMAC |
| PATCH | `/specs/:id` | Update statut | HMAC |
| GET | `/runs/recent` | Historique | HMAC |
| GET | `/polls/recent` | Polls récents | HMAC |
| GET | `/stats` | Stats globales | HMAC |

### Mode workflow n8n

1. Importer `n8n-workflow.json`
2. Variables n8n :
   - `ARCHITECT_URL` = `http://architect:3001` ou domaine Tailscale
   - `ARCHITECT_HMAC_SECRET` = valeur du `HMAC_SECRET` côté architecte
   - `NOTIFICATION_FROM_EMAIL` / `NOTIFICATION_TO_EMAIL`
3. Activer

Le workflow poll quotidien à 9h, déclenche les générations auto pour score ≥ 40, envoie un digest.

---

## Sécurité

Identique au détecteur : 4 couches indépendantes (Tailscale + Caddy + IP allowlist + HMAC).

**Spécificité architecte** : la communication **architecte → détecteur** est elle aussi HMAC-signée. Le `DetectorClient` utilise `DETECTOR_HMAC_SECRET` pour signer chaque requête sortante.

```
Architect Caller (DetectorClient)
   │ signs with DETECTOR_HMAC_SECRET
   ▼
Detector API
   │ verifies with its HMAC_SECRET (= DETECTOR_HMAC_SECRET)
   ▼
Returns opportunity data
```

Les deux secrets sont distincts :
- `HMAC_SECRET` = secret pour **recevoir** les appels (depuis n8n)
- `DETECTOR_HMAC_SECRET` = secret pour **émettre** vers le détecteur

Voir [deploy/README.md](./deploy/README.md) pour le détail.

---

## Déploiement

Trois options comme pour le détecteur.

### Option 1 — Local sur Mac (tests)

```bash
LLM_BACKEND="claude-code"
DETECTOR_URL="http://localhost:3000"
# Lance le détecteur sur :3000 et l'architecte sur :3001
npm run dev
```

### Option 2 — VPS Hetzner (production)

Si le détecteur tourne déjà sur le VPS :

```bash
ssh root@TON_VPS
cd /opt
git clone https://github.com/ghilesfeghoul/shopify-micro-saas-factory.git msf-architect
cd msf-architect/opportunity-architecture

bash deploy/scripts/install.sh

nano .env  # configurer ANTHROPIC_API_KEY + DETECTOR_HMAC_SECRET

cd deploy && docker compose up -d
```

### Option 3 — Hybride

Architect sur ton Mac (Claude Code, gratuit), détecteur sur le VPS (cron 24/7), poll manuel ou cron local.

Voir [deploy/README.md](./deploy/README.md) pour le détail.

---

## Coûts

### En mode Claude Code (tests)

| Item | Coût |
|------|------|
| Claude Pro existant | 0€ marginal |
| **Total** | **0€** |

Quotas hebdo Pro/Max à respecter.

### En mode API Anthropic (production)

| Item | Coût mensuel |
|------|--------------|
| VPS (mutualisé avec détecteur) | 0€ supplémentaire |
| API Anthropic (~10-15 specs/mois × 2-5€) | ~30-75€ |
| **Total** | **~30-75€** |

### Optimisations

- **Threshold plus haut** : `AUTO_TRIGGER_SCORE_THRESHOLD=45` réduit le volume auto
- **Claude Sonnet** au lieu d'Opus : -80% de coût, qualité légèrement inférieure pour les specs complexes
- **Mode manuel uniquement** : désactiver le cron auto, génération à la demande

Pour les premières semaines, recommandé : **Claude Code en local**, génération manuelle pour les top 3-5 opportunités, validation humaine de chaque spec avant approval.

---

## Maintenance

### Voir les logs

```bash
tail -f logs/combined.log
docker compose logs architect --tail 100
```

### Inspecter la base

```bash
npm run db:studio
```

### Régénérer une spec après changement de prompt

```bash
npm run generate OPP-A1B2 -- --force
```

L'ancienne version est marquée `isActive: false`, la nouvelle prend la place. L'historique reste consultable via `--all`.

### Migration vers PostgreSQL

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

```bash
DATABASE_URL="postgresql://..." npm run db:push
```

### Update des dépendances

```bash
npm audit
npm update
```

---

## Dépannage

### "DETECTOR_URL is required"

Pas de `DETECTOR_URL` configuré dans `.env`. Mettre l'URL du détecteur (par défaut `http://localhost:3000` en dev, `http://detector:3000` en Docker Compose, ou Tailscale hostname).

### "DetectorClient listOpportunities failed: 401"

Le `DETECTOR_HMAC_SECRET` ne matche pas le `HMAC_SECRET` du détecteur. Vérifier :

```bash
# Côté architecte
grep DETECTOR_HMAC_SECRET .env

# Côté détecteur
grep ^HMAC_SECRET= /opt/msf/.env

# Les deux valeurs DOIVENT être identiques
```

### "Spec validation failed: shopify.webhooks: Array must contain at least 3 items"

Le LLM a oublié des webhooks GDPR. C'est rare avec le prompt actuel, mais possible. Re-lance :

```bash
npm run generate OPP-A1B2 -- --force
```

Si ça persiste, augmente le contexte du prompt ou switch sur Opus si tu utilisais Sonnet/Haiku.

### "Mandatory GDPR webhook missing: customers/data_request"

Validation business rule. Le LLM a déclaré moins de 3 webhooks GDPR. Re-lance avec `--force`.

### Les specs sont trop génériques

Le prompt manque de signal sur l'opportunité. Vérifier que `recommendedFeatures` du détecteur est bien rempli — c'est la principale source d'info technique pour l'architecte.

### Specs très longues à générer (>5 min)

Normal pour les apps complexes. La taille moyenne d'une spec est ~10000 tokens output, ce qui prend 2-5 minutes selon le modèle. Si ça dépasse 10 min, vérifier `CLAUDE_CODE_TIMEOUT_MS` ou switcher vers l'API.

---

## Roadmap

### Court terme

- **Validation automatique des scopes contre une whitelist Shopify** (sortir les scopes non valides)
- **Diff de specs** : visualiser ce qui change entre deux versions
- **Export bulk** : tous les specs approuvés en un dossier git pour le futur Agent Développeur

### Moyen terme

- **Agent Développeur** : prend une spec approuvée et génère le code complet
- **Templates par catégorie** : conversion app, marketing app, ops app — chacune avec son boilerplate optimisé
- **A/B sur les prompts** : tester deux variantes du system prompt sur le même OPP, voir laquelle produit la spec la plus consistante

### Long terme

- Support des Shopify Functions (Rust/JS WASM) pour les apps qui modifient le pricing/discount
- Multi-plateforme : adapter le prompt pour WooCommerce / Magento avec mêmes contraintes structurelles

---

## Liens utiles

- [Service détecteur](../opportunity-detector/README.md)
- [Blueprint complet du projet](../micro-saas-factory-blueprint.docx)
- [Guide backend switching](./docs/llm-backend-switching.md)
- [Guide déploiement](./deploy/README.md)
- [Documentation Anthropic API](https://docs.claude.com)

---

## License

Privé. Tous droits réservés. Ce code fait partie du projet Micro-SaaS Factory.

CEO: [Ghiles FEGHOUL](mailto:ghiles.feghoul@gmail.com)

---

*Dernière mise à jour : avril 2026 — version 1.0.0*
