# 🚀 Déploiement — Opportunity Architecture

Le service architecture suit la **même architecture sécurité** que le détecteur (HMAC + Tailscale + Caddy + IP allowlist). Si tu as déjà déployé le détecteur, ajouter l'architecte est trivial.

## Pré-requis

- `opportunity-detector` déjà déployé et fonctionnel
- Connaître la valeur de `HMAC_SECRET` du détecteur (à mettre dans `DETECTOR_HMAC_SECRET` côté architecte)

## Communication entre les deux services

```
┌─────────────────┐                          ┌─────────────────┐
│   Architecte    │                          │   Détecteur     │
│   port 3001     │ ──HMAC signed HTTPS──►   │   port 3000     │
│                 │                          │                 │
│ HMAC_SECRET (A) │                          │ HMAC_SECRET (D) │
└─────────────────┘                          └─────────────────┘

Côté Architecte:
  HMAC_SECRET="xxx"           # secret PROPRE pour son API
  DETECTOR_HMAC_SECRET="yyy"  # = HMAC_SECRET du détecteur

Côté Détecteur:
  HMAC_SECRET="yyy"           # = DETECTOR_HMAC_SECRET de l'architecte
```

Les deux services ont **chacun leur secret HMAC** pour leur propre API. Quand l'architecte appelle le détecteur, il signe avec le secret du détecteur (qu'il connaît via `DETECTOR_HMAC_SECRET`).

## Déploiement étape par étape

### 1. Sur le VPS (où tourne déjà le détecteur)

```bash
# Cloner le service
cd /opt
git clone https://github.com/ghilesfeghoul/shopify-micro-saas-factory.git msf-architect-tmp
mv msf-architect-tmp/opportunity-architecture msf-architect
rm -rf msf-architect-tmp

cd msf-architect
```

### 2. Configurer .env

```bash
cp .env.example .env

# Générer un secret HMAC propre à l'architecte
NEW_HMAC=$(openssl rand -hex 32)
sed -i "s|^HMAC_SECRET=.*|HMAC_SECRET=\"$NEW_HMAC\"|" .env

# Récupérer le secret HMAC du détecteur
DETECTOR_HMAC=$(grep '^HMAC_SECRET=' /opt/msf/.env | cut -d'"' -f2)
sed -i "s|^DETECTOR_HMAC_SECRET=.*|DETECTOR_HMAC_SECRET=\"$DETECTOR_HMAC\"|" .env

# Si détecteur sur le même réseau Docker
sed -i "s|^DETECTOR_URL=.*|DETECTOR_URL=\"http://detector:3000\"|" .env

# Mettre la clé Anthropic
nano .env  # remplir ANTHROPIC_API_KEY
```

### 3. Démarrer

Si tu utilises le `docker-compose.yml` du détecteur (qui crée déjà le réseau `msf-network`) :

```bash
cd deploy
docker compose up -d
```

Le service est joignable depuis le détecteur via `http://architect:3001`, et depuis Tailscale via `architect.YOUR_DOMAIN.com` si tu as configuré le Caddyfile.

### 4. Tester

```bash
# Health check
curl http://localhost:3001/health

# Test connexion vers détecteur
docker exec msf-architect npx tsx src/detector-client/test-connection.ts

# Premier scan
docker exec msf-architect npm run poll
```

## Stack complète : detector + architect ensemble

Si tu veux un docker-compose qui démarre les deux services ensemble, voir `deploy/docker-compose.full.yml` (à composer en agrégeant les deux compose files).

## Workflow n8n

Importer `n8n-workflow.json` puis configurer dans n8n → Settings → Variables :

```
ARCHITECT_HMAC_SECRET = (la valeur de HMAC_SECRET de l'architecte)
ARCHITECT_URL = http://architect:3001  (ou https://architect.YOUR_DOMAIN.com)
NOTIFICATION_FROM_EMAIL = ...
NOTIFICATION_TO_EMAIL = ...
```

Le workflow lance un poll quotidien à 9h, génère automatiquement les specs pour les opportunités score ≥ 40, et envoie un digest email avec le résumé.

## Coûts mensuels

En supposant le poll quotidien et 2-3 nouvelles opportunités score ≥ 40 par semaine :

| Item | Coût mensuel |
|------|--------------|
| Architecte VPS (déjà inclus si même VPS que détecteur) | 0€ |
| Anthropic API (~10-15 specs/mois × 2-5€) | ~30-75€ |

Si tu veux baisser ces coûts pendant les premières semaines :
- Garder le service en mode `LLM_BACKEND="claude-code"` sur ton Mac (gratuit)
- Désactiver le cron n8n auto-poll
- Lancer manuellement `npm run generate OPP-XXXX` pour les opportunités prometteuses

## Modèle de menaces couvert

Identique au détecteur (voir son `deploy/README.md`). Les 4 couches HMAC + IP + Caddy + Tailscale s'appliquent.

**Spécifique à l'architecte** : la communication architecte → détecteur est elle aussi signée HMAC, donc même si quelqu'un compromet le réseau Docker, il ne peut pas se faire passer pour l'architecte auprès du détecteur sans connaître `DETECTOR_HMAC_SECRET`.
