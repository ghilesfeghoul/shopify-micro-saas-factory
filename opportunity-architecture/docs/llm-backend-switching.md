# 🔄 LLM Backend Switching

Le service architecture supporte les deux mêmes backends que `opportunity-detector` :
- **Anthropic API** : production, payé au token
- **Claude Code CLI** : tests locaux, gratuit avec Pro/Max

## Configuration rapide

### Mode tests locaux (Claude Code)

```bash
# Pré-requis
npm install -g @anthropic-ai/claude-code
claude   # auth interactive (Pro/Max OAuth)

# .env
LLM_BACKEND="claude-code"
CLAUDE_CODE_USE_BARE="false"   # important: false pour OAuth Pro

# Test
npm run test:claude-code
```

### Mode production (API)

```bash
# .env
LLM_BACKEND="anthropic-api"
ANTHROPIC_API_KEY="sk-ant-..."
CLAUDE_MODEL="claude-opus-4-7"
```

## Différences vs detector

Aucune différence d'API entre les deux services — l'abstraction `LLMProvider` est identique.

Seule différence pratique : les specs sont **plus longues que les analyses du détecteur** (typiquement 8000-12000 tokens output), donc les coûts à l'opération sont 3-5x supérieurs (compter ~2-5€ par spec en API).

| Item | Coût |
|------|------|
| 1 spec via Claude Code (Pro/Max) | 0€ |
| 1 spec via Anthropic API | ~2-5€ |
| 10 specs/mois via API | ~20-50€ |

## Recommandation

- **Tests/itérations sur le prompt** → Claude Code (gratuit)
- **Production cron quotidien** → API (autonome 24/7)
- **Hybride** → Claude Code en local, API en CI/cron

## Limites de l'usage Claude Code en autonome

Claude Code lié à OAuth ne peut pas tourner sur un VPS sans toi. Pour la prod 24/7, il **faut** l'API. Voir le doc équivalent dans `opportunity-detector` pour les détails techniques.
