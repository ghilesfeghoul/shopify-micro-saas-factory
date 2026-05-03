# 🔄 LLM Backend Switching

L'agent Développeur utilise **Claude Code par défaut**, avec API Anthropic en fallback. C'est différent du détecteur et de l'architecte (qui sont neutres) parce que **générer du code requiert vraiment Claude Code** : sans accès aux outils filesystem natifs et aux skills locaux, la qualité du code chute drastiquement.

## Comment ça marche

```
┌──────────────────────────────────────────────────────────────────┐
│  Orchestrateur principal (planning)                              │
│   - Utilise createLLMProvider() → factory                        │
│   - Choisit backend selon LLM_BACKEND env var                    │
│   - Output structuré JSON Schema (chunks DAG)                    │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  Sous-agents (code generation)                                   │
│   - Utilisent ClaudeCodeSpawner (PAS la factory)                 │
│   - TOUJOURS Claude Code (sans --bare)                           │
│   - Accès filesystem + skills + Bash                             │
└──────────────────────────────────────────────────────────────────┘
```

L'orchestrateur **planifie** via la factory (peut donc utiliser API ou Claude Code selon la config). Mais les **sous-agents** qui génèrent du vrai code utilisent toujours `ClaudeCodeSpawner` directement, qui ne passe **jamais** par l'API. Cette séparation est intentionnelle : la planification est une tâche structurée courte (dépend du backend), tandis que le code generation a besoin des outils Claude Code (Read/Write/Edit/Bash + skills).

## Configuration

### Mode tests locaux (recommandé pour Ghiles avec Claude Pro/Max)

```bash
# .env
LLM_BACKEND="auto"            # Tentera Claude Code en premier
CLAUDE_CODE_USE_BARE="false"  # Important pour OAuth Pro
```

Pré-requis :
```bash
npm install -g @anthropic-ai/claude-code
claude   # auth interactive
```

### Mode production VPS (24/7 autonome)

⚠️ Claude Code OAuth ne fonctionne pas en mode container 24/7 sans toi. Pour la prod autonome, il faut l'API :

```bash
# .env
LLM_BACKEND="anthropic-api"
ANTHROPIC_API_KEY="sk-ant-..."
CLAUDE_MODEL="claude-opus-4-7"
```

**Mais** : si tu utilises l'API, **les sous-agents perdent l'accès aux skills**. C'est un compromis. Solutions :
1. Faire tourner le dev agent **localement sur ton Mac** uniquement (pas en prod VPS), avec Claude Code + skills, et déclencher manuellement
2. Accepter que les apps générées en prod VPS soient légèrement moins polies (pas de Superpowers TDD, pas de skills Shopify natifs)

### Mode hybride (recommandé pour ton cas)

- **Sur ton Mac** : `LLM_BACKEND="auto"` → Claude Code + skills
- **n8n cron sur VPS** : ne déclenche le dev agent **que pour les specs simples**, et te notifie pour les specs complexes
- Tu lances toi-même les specs complexes en local quand tu as 30 minutes devant toi

## Coûts comparés

Pour générer 1 app Shopify de complexité moyenne (50-80h estimées) :

| Mode | Coût direct | Quotas |
|------|-------------|--------|
| Claude Code Pro/Max (local) | 0€ | Consomme tes quotas hebdo (~5-10% par app) |
| Claude Code Max (local) | 0€ | Quotas plus larges |
| Anthropic API (prod) | 5-15€ | Pas de limite |

Pour 12-20 apps/an (objectif Micro-SaaS Factory) :

| Stratégie | Coût annuel |
|-----------|-------------|
| Tout en API | 60-300€ |
| Tout en local (Pro/Max) | 0€ marginal (mais tu y passes du temps) |
| Hybride | 30-150€ |

## Différences avec detector/architect

Le détecteur et l'architecte exposent un backend abstrait neutre (les deux modes donnent une qualité équivalente). Le développeur **ne peut pas** être neutre car :
- Sans accès filesystem, l'API ne peut pas écrire des fichiers (il faudrait reconstruire toute la mécanique de file editing en TypeScript)
- Sans accès aux skills, on perd Superpowers (TDD), les skills Shopify officiels (App Bridge, Polaris patterns)
- Sans Bash, l'agent ne peut pas lancer `npm install`, `npx tsc --noEmit`, `git commit`

C'est pour ça que `ClaudeCodeSpawner` est la pièce critique du dev agent et que le mode `LLM_BACKEND=anthropic-api` n'est utilisé que pour la **planification** (court, structuré, pas besoin de tools).
