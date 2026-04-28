# 🎯 Opportunity Detector

Premier agent du système **Micro-SaaS Factory**. Détecte les opportunités de micro-apps Shopify rentables en analysant l'écosystème (App Store Shopify, Shopify Community, Product Hunt) avec Claude.

[![Version](https://img.shields.io/badge/version-1.2.0-blue)]()
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

L'agent détecteur scrape automatiquement plusieurs sources e-commerce, identifie les pain points récurrents des marchands Shopify, et utilise Claude pour scorer chaque opportunité sur 5 dimensions (taille de marché, urgence, faisabilité, monétisation, concurrence). Le résultat : une liste priorisée d'opportunités de micro-apps à construire, mise à jour automatiquement.

### Pourquoi cet agent existe

Construire un micro-SaaS rentable demande deux compétences distinctes : identifier le bon problème, et exécuter techniquement. Cet agent automatise la première — la plus chronophage et la plus subjective — pour que tu puisses concentrer ton énergie sur la seconde.

### Caractéristiques principales

- **4 sources de données** : App Store Shopify (reviews négatives), Shopify Community (Discourse API), Reddit (multi-subreddit + recherche par mots-clés), Product Hunt (10 catégories Atom)
- **Backend LLM interchangeable** : Anthropic API ou Claude Code CLI selon ton contexte
- **Scoring structuré sur 50 points** : 5 dimensions × 10, avec priorité automatique (low/medium/high/critical)
- **Sécurité multi-couches** : HMAC + IP allowlist + Tailscale + Caddy reverse proxy
- **Stockage portable** : SQLite par défaut, migration PostgreSQL en 1 ligne
- **Orchestration n8n** : workflow hebdomadaire avec digest email
- **CLI complet** : scan, list, show, stats pour usage interactif
- **API HTTP sécurisée** : pour intégration n8n ou autres services

---

## Démarrage rapide

### Prérequis minimum

- Node.js >= 20
- Soit une clé API Anthropic, soit Claude Code installé avec abonnement Pro/Max
- 5 minutes

### Installation

```bash
# 1. Décompresser l'archive
tar -xzf opportunity-detector-v3-multi-backend.tar.gz
cd opportunity-detector-v3

# 2. Installer les dépendances
npm install
npx playwright install chromium

# 3. Configurer
cp .env.example .env
# Éditer .env (voir section Configuration ci-dessous)

# 4. Initialiser la base
npm run db:generate
npm run db:push

# 5. Premier scan de validation
npm run scan -- --source=appstore
```

Si tout se passe bien, tu verras dans les logs :
```
🚀 Starting scan run cm5xy12ab
📥 Scraped 47 signals total
🧠 Analyzing 47 signals via anthropic-api...
💾 Saved 6 new opportunities
✅ Scan completed in 67.2s
```

Puis pour voir les résultats :
```bash
npm run list
```

---

## Architecture

### Vue générale

```
┌──────────────────────────────────────────────────────────────┐
│                  Sources externes                            │
│  App Store Shopify  │  Community  │  Product Hunt  │  ...   │
└────────────┬─────────────────────────────────────────────────┘
             │ scraping (Playwright + axios)
             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│              Couche Scrapers (src/scrapers/)                             │
│  shopify-appstore.ts │ shopify-community.ts │ producthunt.ts │ reddit.ts │
└────────────┬─────────────────────────────────────────────────────────────┘
             │ RawSignal[]
             ▼
┌──────────────────────────────────────────────────────────────┐
│           Storage (Prisma → SQLite/PostgreSQL)               │
│  - Déduplication par sourceUrl                               │
│  - Tracking processed/unprocessed                            │
└────────────┬─────────────────────────────────────────────────┘
             │ Unprocessed signals
             ▼
┌──────────────────────────────────────────────────────────────┐
│           LLM Provider (src/llm/)                            │
│  ┌────────────────────┐  ┌────────────────────────────┐    │
│  │ AnthropicAPI       │  │ ClaudeCode CLI             │    │
│  │ (tool_use forced)  │  │ (--json-schema forced)     │    │
│  └────────────────────┘  └────────────────────────────┘    │
└────────────┬─────────────────────────────────────────────────┘
             │ Structured opportunities (validated by Zod)
             ▼
┌──────────────────────────────────────────────────────────────┐
│           Storage (opportunities table)                      │
│  + linkage to source signals (audit trail)                   │
└────────────┬─────────────────────────────────────────────────┘
             │
             ▼
   ┌─────────────────────────┐
   │  CLI                    │   ┌──────────────────┐
   │  • npm run list         │   │  HTTP API        │
   │  • npm run show OPP-X   │   │  (HMAC + IP)     │
   │  • npm run stats        │   │  ← n8n cron      │
   └─────────────────────────┘   └──────────────────┘
```

### Structure du projet

```
opportunity-detector/
├── prisma/
│   └── schema.prisma              # DB schema (SQLite, PostgreSQL ready)
├── src/
│   ├── api/
│   │   └── server.ts              # Express HTTP API (HMAC auth)
│   ├── auth/
│   │   ├── hmac.ts                # HMAC verification middleware
│   │   └── ip-allowlist.ts        # IP CIDR filtering
│   ├── llm/
│   │   ├── provider.ts            # Common interface
│   │   ├── anthropic-api-provider.ts
│   │   ├── claude-code-provider.ts
│   │   ├── factory.ts             # Backend selection logic
│   │   └── test-claude-code.ts    # Smoke test
│   ├── prompts/
│   │   └── detector-prompt.ts     # Claude system prompt
│   ├── scoring/
│   │   ├── analyzer.ts            # Main analysis orchestration
│   │   └── orchestrator.ts        # Full scan pipeline
│   ├── scrapers/
│   │   ├── shopify-appstore.ts    # Negative reviews scraper
│   │   ├── shopify-community.ts   # Forum scraper
│   │   ├── producthunt.ts         # Product launches scraper
│   │   └── reddit.ts              # Reddit scraper (optional)
│   ├── storage/
│   │   └── repository.ts          # Prisma layer
│   ├── utils/
│   │   ├── logger.ts              # Winston logger
│   │   └── types.ts               # Zod schemas + TS types
│   └── cli.ts                     # CLI entry point
├── deploy/
│   ├── docker-compose.yml         # Full stack: n8n + detector + Caddy
│   ├── Caddyfile                  # Reverse proxy config
│   ├── detector.Dockerfile
│   ├── n8n/
│   │   └── sign-request.js        # HMAC signing for n8n
│   ├── scripts/
│   │   └── install.sh             # Auto-install on Hetzner VPS
│   └── README.md                  # Deployment guide
├── docs/
│   └── llm-backend-switching.md   # Backend selection guide
├── n8n-workflow.json              # Importable n8n workflow
├── .env.example
├── package.json
├── tsconfig.json
└── README.md                      # ← you are here
```

### Système de scoring

Chaque opportunité est notée sur 5 dimensions par Claude (0-10 chacune) :

| Dimension | Question posée à Claude |
|-----------|-------------------------|
| **market_size** | Combien de marchands Shopify ont ce problème ? |
| **urgency** | À quel point ce problème est-il douloureux/bloquant ? |
| **feasibility** | Un agent IA peut-il coder ça en moins de 3 semaines ? |
| **monetization** | Combien les marchands paieraient-ils pour cette solution ? |
| **competition** | Inversé : 10 = peu de concurrence, 0 = marché saturé |

Le total sur 50 détermine la priorité automatique :

| Score | Priorité | Action recommandée |
|-------|----------|--------------------|
| 40-50 | 🔥 **critical** | Lancer en priorité absolue |
| 35-39 | ⭐ **high** | Build dans la roadmap court terme |
| 30-34 | · **medium** | Évaluer manuellement |
| 25-29 | low | Surveiller |
| <25 | filtré | Pas sauvegardé en DB |

---

## Configuration

### Backend LLM

Le détecteur supporte deux backends LLM, interchangeables via `.env`. Voir [docs/llm-backend-switching.md](./docs/llm-backend-switching.md) pour le détail complet.

**Pour les tests locaux (gratuit avec Pro/Max)** :
```bash
LLM_BACKEND="claude-code"
```
Pré-requis : `npm install -g @anthropic-ai/claude-code` puis `claude` une fois pour s'authentifier.

**Pour la production (VPS, autonome)** :
```bash
LLM_BACKEND="anthropic-api"
ANTHROPIC_API_KEY="sk-ant-..."
CLAUDE_MODEL="claude-opus-4-7"
```

**Mode auto (intelligent)** :
```bash
LLM_BACKEND="auto"
# Utilise Claude Code si pas d'API key, sinon API
```

### Variables d'environnement principales

| Variable | Requis | Description |
|----------|--------|-------------|
| `LLM_BACKEND` | Oui | `anthropic-api`, `claude-code`, ou `auto` |
| `ANTHROPIC_API_KEY` | Si API | Clé Anthropic API |
| `HMAC_SECRET` | Oui | Secret pour signer les requêtes (32+ chars) |
| `IP_ALLOWLIST` | Oui | CIDR autorisés (ex: `100.64.0.0/10,127.0.0.1`) |
| `DATABASE_URL` | Oui | URL Prisma (défaut: SQLite) |
| `MAX_SIGNALS_PER_SCAN` | Non | Plafond de signaux par scan (défaut: 200) |
| `MAX_OPPORTUNITIES_PER_SCAN` | Non | Plafond d'opportunités sauvegardées par scan (défaut: 15) |
| `MIN_SCORE_THRESHOLD` | Non | Score minimum pour sauvegarder (défaut: 25) |
| `PRODUCT_HUNT_TOKEN` | Non | Token API Product Hunt. Sans lui, utilise les flux Atom (~413 signaux/scan, fonctionne bien) |
| `REDDIT_USER_AGENT` | Non | Override du User-Agent Reddit. Doit être descriptif — les UAs de type Googlebot sont bloqués (403) |

Voir `.env.example` pour la liste complète avec descriptions.

### Génération des secrets

```bash
# HMAC secret (32 bytes hex)
npm run secret:generate

# Ou directement
openssl rand -hex 32
```

---

## Utilisation

### Mode CLI (interactif)

**Lancer un scan** :
```bash
# Toutes les sources
npm run scan

# Une source spécifique
npm run scan -- --source=appstore
npm run scan -- --source=reddit
npm run scan -- --source=community
npm run scan -- --source=producthunt

# Avec paramètres custom
npm run scan -- --source=appstore --min-score=30 --max-opps=10
```

**Lister les opportunités** :
```bash
# Top 20
npm run list

# Filtrer par score
npm run list -- --min-score=35

# Filtrer par statut
npm run list -- --status=detected
```

**Voir le détail d'une opportunité** :
```bash
npm run show OPP-A1B2
```

Output :
```
════════════════════════════════════════════════════════════════════════════════
📌 OPP-A1B2 — Bulk metafield editor with CSV import for collections
════════════════════════════════════════════════════════════════════════════════

Many merchants struggle to update metafields across hundreds of products. 
Existing apps require manual entry per product or expensive enterprise plans...

SCORES:
  Market size:  8/10
  Urgency:      7/10
  Feasibility:  9/10
  Monetization: 7/10
  Competition:  6/10
  ─────────────────
  TOTAL:        37/50  (priority: high)

PRICING:        freemium + $19/month
DEV TIME:       1-2 weeks
STATUS:         detected

COMPETITOR ANALYSIS:
  3 existing apps but all rated 3.2-3.8 with complaints about UX...

MVP FEATURES:
  • CSV import/export with column mapping
  • Bulk find-and-replace across metafields
  • Preview changes before commit
  • Undo last bulk operation
  • Filter products by tag/collection

SOURCE SIGNALS (4):
  - [shopify_appstore] Bulk Editor Pro - 1 star review...
  - [shopify_community] How to update metafields in bulk?...
  ...
```

**Statistiques** :
```bash
tsx src/cli.ts stats
```

### Mode API (pour n8n et automatisation)

**Démarrer le serveur** :
```bash
npm run dev          # mode développement
npm run build && npm start   # production
```

**Endpoints disponibles** :

| Méthode | Endpoint | Description | Auth |
|---------|----------|-------------|------|
| GET | `/health` | Health check | Aucune |
| POST | `/scan` | Déclencher un scan | HMAC |
| GET | `/opportunities` | Liste paginée | HMAC |
| GET | `/opportunities/:id` | Détail | HMAC |
| PATCH | `/opportunities/:id` | Mettre à jour statut | HMAC |
| GET | `/scans/recent` | Historique des scans | HMAC |
| GET | `/stats` | Stats globales | HMAC |

Toutes les routes protégées exigent les headers HMAC (timestamp, nonce, signature). Voir `deploy/n8n/sign-request.js` pour le code de signature à coller dans n8n.

### Mode workflow n8n

1. Importer `n8n-workflow.json` dans ton instance n8n
2. Stocker `DETECTOR_HMAC_SECRET` en variable n8n (Settings → Variables)
3. Activer le workflow

Le workflow lance un scan tous les lundis à 8h, parse les résultats, et envoie un email digest avec les opportunités du jour.

---

## Sécurité

Le détecteur implémente une sécurité multi-couches indépendantes pour la communication n8n ↔ API :

| Couche | Mécanisme | Protège contre |
|--------|-----------|----------------|
| 1 | **Tailscale VPN** | Exposition publique, scan de ports |
| 2 | **Caddy + HTTPS** | Sniffing, MITM |
| 3 | **IP allowlist** (réseau + applicatif) | Source IP non autorisée |
| 4 | **HMAC + timestamp + nonce** | Replay, tampering, vol de secret |

Le secret HMAC ne transite **jamais** sur le réseau. Chaque requête a une signature unique liée au timestamp, au nonce, à la méthode, au path, et au hash du body. Une requête capturée ne peut être rejouée (nonce déjà utilisé), modifiée (signature invalide), ni utilisée après 5 minutes (timestamp hors fenêtre).

Voir [deploy/README.md](./deploy/README.md) pour le détail du modèle de menaces et les tests de sécurité à effectuer.

---

## Déploiement

### Option 1 — Local sur ton Mac (tests)

C'est le mode recommandé pour les premières semaines. Tu valides la qualité du détecteur, tu itères sur le prompt, le tout sans aucun coût marginal en utilisant Claude Code avec ton abonnement Pro.

```bash
# .env
LLM_BACKEND="claude-code"

# Lancer
npm run dev
```

### Option 2 — VPS Hetzner avec Docker Compose (production)

Pour le mode autonome 24/7 avec n8n cron, déploie la stack complète sur un VPS Hetzner CX21 (5€/mois).

```bash
# Sur ton Mac, copie le repo sur le VPS
scp -r opportunity-detector-v3 root@TON_VPS:/opt/msf

# SSH sur le VPS
ssh root@TON_VPS
cd /opt/msf

# Bootstrap automatique
bash deploy/scripts/install.sh

# Configurer les secrets
nano .env

# Démarrer
cd deploy && docker compose up -d
```

Le script `install.sh` configure : SSH hardening, fail2ban, UFW, Docker, Tailscale, génération de tous les secrets cryptographiquement forts.

Voir [deploy/README.md](./deploy/README.md) pour le guide complet.

### Option 3 — Hybride

Tu peux laisser le détecteur sur ton Mac (Claude Code, gratuit) et n8n sur le VPS (cron 24/7 qui ping ton Mac via Tailscale). C'est plus complexe mais coût zéro hors VPS.

---

## Coûts

### En mode Claude Code (tests)

| Item | Coût |
|------|------|
| Abonnement Claude Pro | 20€/mois (que tu paies déjà) |
| Coût marginal par scan | 0€ (inclus dans l'abo) |
| **Total marginal** | **0€** |

Limitation : quotas hebdo Pro/Max, et nécessite ton Mac allumé.

### En mode API Anthropic (production)

| Item | Coût mensuel |
|------|--------------|
| VPS Hetzner CX21 | ~5€ |
| Tailscale (gratuit perso) | 0€ |
| Domaine (optionnel) | ~1€ |
| API Anthropic (1 scan/sem, ~150 signaux) | ~3-6€ |
| **Total** | **~10-12€** |

### Optimisations possibles

- **Utiliser Claude Haiku** au lieu d'Opus pour la classification basique : -90% de coût LLM, qualité légèrement inférieure
- **Réduire `MAX_SIGNALS_PER_SCAN`** à 100 : -50% de coût LLM
- **Scan toutes les 2 semaines** au lieu de chaque semaine : -50% de coût LLM
- Combiné, on peut descendre à 1-2€/mois en API

---

## Maintenance

### Voir les logs

```bash
# Logs détecteur
tail -f logs/combined.log

# Logs Caddy (si Docker Compose)
docker exec msf-caddy cat /data/detector-access.log | jq

# Logs n8n
docker compose logs n8n --tail 100
```

### Inspecter la base

```bash
# UI graphique Prisma Studio
npm run db:studio
# → http://localhost:5555
```

### Rotation des secrets

Si tu suspectes une fuite du secret HMAC :

```bash
# Générer un nouveau secret
NEW=$(npm run --silent secret:generate)

# Mettre à jour .env
sed -i.bak "s/HMAC_SECRET=.*/HMAC_SECRET=\"$NEW\"/" .env

# Redémarrer
docker compose up -d --force-recreate detector

# Mettre à jour la variable n8n correspondante
```

### Migration vers PostgreSQL

Quand SQLite devient limitant (>10000 opportunités, ou multi-instance) :

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"  // était "sqlite"
  url      = env("DATABASE_URL")
}
```

```bash
# .env
DATABASE_URL="postgresql://user:pass@host:5432/detector"

# Appliquer
npm run db:push
```

Le code applicatif ne change pas d'une ligne grâce à Prisma.

### Update des dépendances

```bash
# Audit sécurité
npm audit

# Update mineur
npm update

# Update majeur (avec breaking changes possibles)
npx npm-check-updates -u && npm install
```

---

## Dépannage

### "Claude Code CLI not found"

Le binaire `claude` n'est pas dans le PATH.

```bash
# Vérifier
which claude

# Si rien
npm install -g @anthropic-ai/claude-code

# Ajouter au PATH si nécessaire (dans .zshrc ou .bashrc)
export PATH="$PATH:$(npm config get prefix)/bin"
```

### "ANTHROPIC_API_KEY is required"

Soit tu n'as pas configuré la clé, soit tu veux utiliser Claude Code mais le backend est sur API.

```bash
# Vérifier
grep LLM_BACKEND .env
grep ANTHROPIC_API_KEY .env

# Pour utiliser Claude Code à la place
echo 'LLM_BACKEND="claude-code"' >> .env
```

### "structured_output missing or malformed"

Le LLM a renvoyé du JSON non conforme au schéma. Causes possibles :

1. Version ancienne de Claude Code → `npm update -g @anthropic-ai/claude-code`
2. Quota Pro/Max saturé → patienter ou switcher temporairement sur API
3. Bug dans le prompt → le code a un fallback, mais si ça persiste, augmenter `LOG_LEVEL=debug` et inspecter

### "401 Unauthorized" sur l'API

Les signatures HMAC ne matchent pas. Vérifier :

1. Même `HMAC_SECRET` côté n8n et côté détecteur
2. Horloge synchronisée (timestamp dans la fenêtre 5 min) → `timedatectl status`
3. Le body envoyé n'est pas modifié par un middleware n8n entre la signature et l'envoi
4. Le `Content-Type: application/json` est bien présent

### "Forbidden" (403) sur l'API

L'IP source n'est pas dans `IP_ALLOWLIST`. Vérifier :

```bash
# Voir l'IP qui appelle (côté détecteur)
docker compose logs detector --tail 20 | grep "rejected"

# Ajouter le CIDR au .env
IP_ALLOWLIST="100.64.0.0/10,172.16.0.0/12,127.0.0.1,NOUVELLE_IP"
```

### Le scraper App Store retourne 0 signaux

Shopify a peut-être changé son DOM. Lancer en mode debug pour inspecter :

```bash
LOG_LEVEL=debug npm run scan -- --source=appstore
```

Si Playwright n'arrive plus à trouver les éléments, les sélecteurs CSS dans `src/scrapers/shopify-appstore.ts` doivent être mis à jour. C'est l'inconvénient du scraping web sans API officielle.

### Scans très lents (>5 minutes)

Causes habituelles :

- **Trop de signaux** : réduire `MAX_SIGNALS_PER_SCAN`
- **App Store rate limit** : le scraper attend volontairement entre les requêtes pour rester poli
- **Claude Code subprocess** : la première invocation est plus lente (warmup), les suivantes ~30-60s

---

## Roadmap

### Court terme (déjà spec'd dans le blueprint)

- **Agent Architecte** : prend une opportunité scorée et génère la spec technique complète
- **Agent Développeur** : génère le code de l'app à partir de la spec
- **Agent QA** : valide tests, lint, build, et déploie
- **Agent Marketing** : génère ASO, articles SEO, scripts vidéo

### Moyen terme

- **Agent Support L1/L2** : gestion automatique des tickets marchands
- **Agent Documentation** : génération auto de docs marchand
- **Agent Maintenance** : monitoring, hotfix, updates dépendances
- **Agent Feedback** : analyse continue des reviews et roadmap auto

### Long terme

- Multi-plateforme (WooCommerce, PrestaShop)
- Bundle pricing inter-apps
- Marketplace de thèmes Shopify auto-générés
- White-label du pipeline pour autres développeurs

---

## Liens utiles

- [Blueprint complet du projet](../micro-saas-factory-blueprint.docx) — vision et roadmap des 12 mois
- [Guide backend switching](./docs/llm-backend-switching.md)
- [Guide déploiement sécurisé](./deploy/README.md)
- [Documentation Anthropic API](https://docs.claude.com)
- [Documentation Claude Code](https://docs.claude.com/en/docs/claude-code)

---

## License

Privé. Tous droits réservés. Ce code fait partie du projet Micro-SaaS Factory.
CEO: [Ghiles FEGHOUL](ghiles.feghoul@gmail.com)
---

*Dernière mise à jour : avril 2026 — version 1.2.0*