# 🔄 LLM Backend Switching

Le détecteur supporte deux backends LLM, interchangeables via une variable d'environnement.

## Pourquoi cette abstraction ?

- **Coût zéro pendant les tests** : tu utilises ton abonnement Claude Pro/Max via Claude Code
- **Production fiable** : tu bascules sur l'API Anthropic pour le déploiement VPS 24/7
- **Mêmes prompts, mêmes garanties** : `tool_use` côté API et `--json-schema` côté CLI produisent tous deux du JSON validé
- **Une seule variable à changer** : `LLM_BACKEND` dans `.env`

## Comparatif rapide

| Critère | Anthropic API | Claude Code CLI |
|---------|---------------|-----------------|
| Coût marginal | ~0.50€/scan | 0€ (inclus dans Pro/Max) |
| Setup machine | Juste une clé | Install + auth interactive |
| Fonctionne sur VPS sans toi | ✅ | ❌ (auth liée à ton compte) |
| Quotas | Spending limit configurable | Quotas hebdo Pro/Max |
| Latence par scan | ~30-60s | ~30-60s (similaire) |
| Streaming JSON | Oui (tool_use) | Oui (`--json-schema`) |
| Idéal pour | Production 24/7 | Tests locaux, dev itératif |

## Configuration

### Mode Claude Code (tests locaux)

**Pré-requis** : tu as un abonnement Claude Pro ou Max actif.

**1. Installer Claude Code** :
```bash
npm install -g @anthropic-ai/claude-code
```

**2. S'authentifier** (une seule fois, interactif) :
```bash
claude
```
Au premier lancement, tu choisis "Sign in with Claude.ai" et tu suis le flow OAuth dans ton navigateur. Cette session est persistée localement et réutilisée par tous les `claude -p` ultérieurs.

**3. Tester l'install** :
```bash
claude -p "say hello in 3 words" --bare --output-format json
```
Tu devrais voir un JSON avec `"result": "Hello, hello world!"` ou similaire et un `total_cost_usd` à 0 (puisque c'est consommé sur ton abonnement).

**4. Configurer le détecteur** :
```bash
# .env
LLM_BACKEND="claude-code"
# ANTHROPIC_API_KEY peut rester vide
```

**5. Lancer un scan** :
```bash
npm run scan -- --source=appstore
```

Tu devrais voir dans les logs :
```
ClaudeCodeProvider initialized (binary: claude)
Analyzing 47 signals via claude-code...
LLM usage: backend=claude-code, duration=42.3s, cost=$0.0000
```

### Mode Anthropic API (production)

**1. Récupérer une clé** sur [console.anthropic.com](https://console.anthropic.com/settings/keys).

**2. Configurer le détecteur** :
```bash
# .env
LLM_BACKEND="anthropic-api"
ANTHROPIC_API_KEY="sk-ant-..."
CLAUDE_MODEL="claude-opus-4-7"
```

**3. Optionnel : limiter les coûts** dans la console Anthropic, section "Plans & Billing" → "Spending limits". Mets une limite mensuelle (par exemple 20€) pour dormir tranquille.

**4. Lancer un scan** :
```bash
npm run scan
```

Logs attendus :
```
AnthropicAPIProvider initialized with model claude-opus-4-7
Analyzing 47 signals via anthropic-api...
LLM usage: backend=anthropic-api, duration=38.1s, input=12450t, output=2103t
```

### Mode "auto" (intelligent fallback)

Pratique en dev quand tu jongles entre les deux setups :

```bash
LLM_BACKEND="auto"
```

Comportement :
- Si `ANTHROPIC_API_KEY` est définie → utilise l'API
- Sinon → tente Claude Code CLI

C'est utile si tu veux un seul `.env` qui marche sur ton Mac (sans clé API → fallback Claude Code) et sur le VPS (clé API présente → API utilisée).

## Cas d'usage typique

```
┌─────────────────────────────────────────────────────────────┐
│  Phase de validation (semaines 1-4)                         │
│  ─────────────────────────────────                          │
│  • Tu lances 20-30 scans pour valider la qualité            │
│  • Tu itères sur le prompt, les sources, les seuils         │
│  • LLM_BACKEND=claude-code → 0€ dépensé                     │
│  • Tu utilises ton Mac, déclenché manuellement              │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase de production (semaine 5+)                           │
│  ─────────────────────────────                              │
│  • Le système tourne 24/7 sur le VPS                        │
│  • LLM_BACKEND=anthropic-api → ~5-10€/mois                  │
│  • Cron n8n hebdomadaire, alertes email                     │
└─────────────────────────────────────────────────────────────┘
```

## Limitations connues

### Claude Code CLI

- **Authentification liée à un humain** : impossible d'utiliser sur un VPS sans être connecté avec ton compte. Si tu veux faire tourner Claude Code sur Hetzner, il faudrait que tu te connectes en SSH et lances `claude` manuellement, ce qui n'est pas du tout autonome.
- **Quotas Pro/Max** : Anthropic a des limites d'usage hebdo non-publiées. Si tu fais 50 scans dans une journée, tu peux les saturer et bloquer ton chat Claude.ai en parallèle.
- **Subprocess overhead** : chaque appel spawne un process Node + boot la CLI (~1-2s), donc latence légèrement supérieure à l'API pure pour beaucoup de petits appels. Pour notre cas (1 gros appel par scan), c'est négligeable.
- **Logs moins riches** : tu n'as pas accès aux compteurs `input_tokens` / `output_tokens` séparés, juste à `total_cost_usd`.

### Anthropic API

- **Coût direct** : chaque appel facturé. Un scan complet sur 200 signaux avec Opus = ~0.50-1.50€.
- **Setup billing** : il faut une carte bancaire et accepter les TOS commerciales.
- **Spending peut déraper** : si tu boucles une analyse en bug et appelles l'API 1000 fois, ça pique. Toujours mettre un spending limit.

## Dépannage

### "Claude Code CLI not found. Install it with..."

Le binaire `claude` n'est pas dans le PATH. Vérifie :
```bash
which claude
# /Users/ghiles/.npm-global/bin/claude  (ou similaire)
```

Si rien : `npm install -g @anthropic-ai/claude-code`.
Si install OK mais pas dans le PATH : ajoute `export PATH="$PATH:$(npm config get prefix)/bin"` à ton `.zshrc` / `.bashrc`.

### "Claude Code: structured_output missing or malformed"

Le modèle a renvoyé du JSON mais pas conforme au schéma. Trois causes possibles :
1. Tu utilises une version ancienne de Claude Code qui n'honore pas `--json-schema`. Mets à jour : `npm update -g @anthropic-ai/claude-code`.
2. Le prompt système et le schéma sont incohérents. Le code a un fallback qui parse le `result` brut, donc ça devrait passer quand même.
3. Le modèle a été distrait par un autre fichier dans le contexte. Le flag `--bare` est censé prévenir ça — vérifie qu'il est bien présent dans `claude-code-provider.ts`.

### "Claude Code timed out after 300000ms"

Un scan de 200 signaux peut prendre du temps. Augmente :
```bash
CLAUDE_CODE_TIMEOUT_MS="600000"  # 10 minutes
```

### Quotas Pro saturés

Symptôme : `claude -p` retourne une erreur sur le quota. Solutions :
- Attendre la réinitialisation hebdo
- Passer temporairement à `LLM_BACKEND="anthropic-api"` avec une clé
- Réduire `MAX_SIGNALS_PER_SCAN` pour faire des scans plus petits
