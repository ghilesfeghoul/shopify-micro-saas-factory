# 🔒 Déploiement sécurisé — Micro-SaaS Factory

Guide complet pour installer n8n + l'agent détecteur sur un VPS Hetzner avec une sécurité multi-couches.

## Pourquoi un secret partagé HTTP n'est pas suffisant

Un simple header `x-webhook-secret` a 5 failles concrètes :

| Faille | Conséquence |
|--------|-------------|
| Secret en clair sur le réseau | Sniffable sans HTTPS, et fuite définitive si exposé une fois |
| Pas de protection replay | Une requête capturée peut être rejouée à l'infini |
| Pas d'intégrité du payload | Attaquant peut modifier le body sans invalider le secret |
| Aucun audit trail | Impossible de tracer qui a fait quoi |
| Surface d'exposition publique | API scannable par bots |

## La solution : 4 couches indépendantes

```
n8n ──► [Tailscale] ──► [Caddy + IP filter] ──► [HMAC + nonce] ──► Détecteur
        Couche 1         Couches 2 et 3            Couche 4
```

Chaque couche échoue indépendamment. Pour compromettre le système, un attaquant doit casser les 4.

### Couche 1 — Réseau privé Tailscale

n8n et le détecteur sont sur un VPN maillé chiffré (WireGuard sous le capot). L'API n'est tout simplement pas joignable depuis l'internet public. Aucune IP publique exposée.

### Couche 2 — Reverse proxy Caddy avec HTTPS automatique

Même sur le réseau Tailscale, on chiffre le trafic. Caddy gère Let's Encrypt automatiquement. Optionnel : mTLS pour exiger un certificat client signé.

### Couche 3 — IP allowlist (en double)

Caddy filtre par CIDR Tailscale (`100.64.0.0/10`) au niveau réseau. Le serveur Node.js refait le filtre au niveau applicatif (defense in depth).

### Couche 4 — HMAC signé avec timestamp + nonce

Chaque requête est signée. Le secret HMAC ne transite **jamais**. La signature couvre méthode + path + timestamp + nonce + hash du body.

- **Timestamp** dans une fenêtre de 5 minutes → bloque le replay tardif
- **Nonce** unique par requête → bloque le replay immédiat
- **Hash du body** → bloque la modification du payload
- **timingSafeEqual** → bloque les attaques par timing

## Setup rapide (10 minutes)

### Prérequis

- Un VPS Ubuntu 22.04+ (Hetzner CX21 à 5€/mois fait largement le job)
- Un compte [Tailscale](https://tailscale.com) (gratuit jusqu'à 100 devices)
- Une clé API Anthropic
- (Optionnel) Un nom de domaine, sinon on utilise les hostnames Tailscale

### Étape 1 — Installer Tailscale sur ta machine locale

Sur ton Mac/PC où tu travailles :

```bash
# macOS
brew install --cask tailscale

# Linux
curl -fsSL https://tailscale.com/install.sh | sh

# Authentifie-toi
sudo tailscale up
```

### Étape 2 — Provisionner le VPS

Sur Hetzner Cloud, crée une instance Ubuntu 22.04. Récupère son IP publique.

### Étape 3 — Bootstrap automatique

```bash
ssh root@TON_IP_VPS

# Une seule commande qui fait tout
curl -fsSL https://raw.githubusercontent.com/TON_USER/micro-saas-factory/main/deploy/scripts/install.sh | bash
```

Le script :
1. Installe les paquets de base (curl, ufw, fail2ban)
2. Crée un utilisateur non-root
3. Durcit SSH (clé seulement, pas de mot de passe)
4. Configure le firewall UFW (deny all + ports 80/443/22 + interface tailscale)
5. Installe Docker + Compose
6. Installe Tailscale et te demande d'autoriser le device
7. Génère tous les secrets (HMAC, mots de passe, clé d'encryption)
8. Clone le repo
9. T'affiche les credentials générés (note-les !)

### Étape 4 — Configurer la clé Anthropic

```bash
sudo nano /opt/msf/.env
# Remplace ANTHROPIC_API_KEY=sk-ant-REPLACE-ME par ta vraie clé
```

### Étape 5 — Démarrer la stack

```bash
cd /opt/msf/deploy
sudo docker compose up -d

# Vérifier que tout tourne
sudo docker compose ps
sudo docker compose logs -f detector
```

### Étape 6 — Accéder à n8n

Depuis ta machine locale (qui est aussi sur Tailscale) :

```
https://TON_VPS_HOSTNAME.your-tailnet.ts.net
```

Le hostname Tailscale s'affiche avec `tailscale status` sur le VPS.

Tu te logges avec `admin` + le mot de passe généré (cf étape 3).

## Configurer le workflow n8n

### 1. Stocker le secret HMAC dans n8n

Dans n8n → Settings → Variables → ajoute :
- **Name**: `DETECTOR_HMAC_SECRET`
- **Value**: la valeur de `DETECTOR_HMAC_SECRET` dans `/opt/msf/.env`

### 2. Importer le workflow

Dans n8n → Workflows → Import from file → choisis `n8n-workflow-secure.json`.

### 3. Vérifier le node "Sign Request"

Le node "Code" contient le script de signature. Il doit utiliser `$env.DETECTOR_HMAC_SECRET`.

### 4. Tester

Clique sur "Execute Workflow" → tu devrais voir le scan se déclencher et un email arriver avec les résultats.

## Vérifier la sécurité

### Test 1 — L'API n'est pas joignable depuis l'extérieur

Depuis ta machine locale, débranche Tailscale puis essaie :

```bash
curl https://detector.ton-tailnet.ts.net/health
# → Doit échouer (DNS non résolu ou timeout)
```

### Test 2 — HMAC bloque les requêtes non signées

```bash
# Reconnecte Tailscale, puis :
curl -X POST https://detector.ton-tailnet.ts.net/scan \
    -H "Content-Type: application/json" \
    -d '{"source":"reddit"}'

# → HTTP 401 "Missing authentication headers"
```

### Test 3 — Replay impossible

Capture une requête signée valide avec les DevTools, rejoue-la après quelques secondes :

```bash
# La 1ère requête passe
curl -X POST ... # → 200 OK

# La 2ème (replay exact) échoue
curl -X POST ... # → 401 "Nonce already used"
```

### Test 4 — Tampering détecté

Modifie le body après signature :

```bash
# Body original signé : {"source":"reddit"}
# Body modifié envoyé : {"source":"all","maxOpportunities":99999}

# → 401 "Invalid signature"
```

## Maintenance

### Voir les logs d'audit

```bash
# Logs Caddy (toutes les requêtes HTTP entrantes)
sudo docker exec msf-caddy cat /data/detector-access.log | jq

# Logs détecteur (auth tentatives, scans)
sudo docker compose logs detector --tail 100

# Logs n8n
sudo docker compose logs n8n --tail 100
```

### Rotation des secrets

Si le secret HMAC fuite (dump de DB, accès illégitime à `.env`) :

```bash
# 1. Générer un nouveau secret
NEW_SECRET=$(openssl rand -hex 32)

# 2. Mettre à jour .env
sudo sed -i "s/DETECTOR_HMAC_SECRET=.*/DETECTOR_HMAC_SECRET=$NEW_SECRET/" /opt/msf/.env

# 3. Restart la stack
cd /opt/msf/deploy && sudo docker compose up -d --force-recreate

# 4. Mettre à jour la variable n8n (Settings → Variables)
```

### Monitoring

UptimeRobot (gratuit) ou similaire ping `https://detector.ton-tailnet.ts.net/health` toutes les 5 min.

Pour les erreurs applicatives, [Sentry](https://sentry.io) gratuit jusqu'à 5k événements/mois. Ajoute :

```bash
# .env
SENTRY_DSN=https://...
```

Et dans `src/api/server.ts`, ajoute Sentry comme middleware (10 lignes).

## Coûts mensuels

| Service | Coût |
|---------|------|
| VPS Hetzner CX21 | ~5€ |
| Tailscale | 0€ (jusqu'à 100 devices, perso illimité) |
| Caddy + Let's Encrypt | 0€ |
| Domaine (optionnel) | ~1€ |
| Anthropic API (1 scan/semaine) | ~6€ |
| **Total** | **~12€/mois** |

## Modèle de menaces — ce que ce setup couvre

| Menace | Mitigation |
|--------|-----------|
| Scan de ports public | API non exposée publiquement (Tailscale) |
| Brute force du secret | HMAC = 256 bits, impossible à brute force |
| Sniffing du secret en transit | HMAC ne transmet jamais le secret |
| Replay de requêtes capturées | Timestamp + nonce + 5 min window |
| Tampering du payload | Signature couvre tout le body |
| Compromission de n8n → vol secret | Secret en variable n8n chiffrée + rotation rapide |
| DDoS de l'API LLM | Rate limit 10 scans/heure |
| SSH brute force | fail2ban + clé seulement |
| Cryptominer après accès root | UFW deny all + Tailscale only inbound |

## Modèle de menaces — ce que ce setup ne couvre PAS

- **Compromission de ton poste de travail** : si quelqu'un a un shell sur ton Mac, il a Tailscale → il peut atteindre l'API. Mitigation : 2FA Tailscale, ACLs Tailscale par tag.
- **Bug dans Claude/n8n/Caddy/Node.js** : zero-days. Mitigation : updates automatiques (Watchtower pour les images Docker, unattended-upgrades sur l'OS).
- **Compromission d'Anthropic / fuite de la clé API** : ta clé peut être abusée. Mitigation : limites de spending dans la console Anthropic, alertes mail.

## Alternatives plus simples (mais moins sûres)

Si Tailscale te semble trop, voici des fallbacks par ordre décroissant de sécurité :

### Option A — Cloudflare Tunnel (sans Tailscale)
- Tunnel chiffré entre ton VPS et Cloudflare
- Cloudflare Access (gratuit jusqu'à 50 users) authentifie les humains
- L'API reste protégée par HMAC pour n8n

### Option B — VPS public + HMAC seul
- L'API est joignable publiquement mais HMAC protège
- Tu perds la couche réseau privé
- Acceptable si HMAC est correctement implémenté + rate limit aggressive

### Option C — Tout en local sur ton Mac/PC
- n8n + détecteur sur ton poste, jamais exposés
- Convient pour les premiers mois de dev
- Limite : ton poste doit être allumé pour les cron

**Recommandation** : commence avec l'option C pour valider que le détecteur fonctionne, puis migre vers la stack complète Tailscale + Caddy quand tu veux du 24/7.
