# 🧠 Intégration des skills

L'agent Développeur exploite les **skills installés sur ta machine** pour produire du meilleur code. C'est ce qui le différencie d'un simple appel API : il a accès à ton expertise locale (Superpowers, skills Shopify officiels, skills custom).

## Ce qui est détecté automatiquement

Au lancement d'une génération, le détecteur scanne ces emplacements :

1. **`~/.claude/skills/`** — skills user-installed (chacun dans son dossier avec `SKILL.md`)
2. **`~/.claude/plugins/`** — plugins comme Superpowers
3. **`$SKILLS_PATH`** — colon-separated extra paths (configurable via .env)

Pour chaque skill détecté, le système extrait :
- Le **nom** (depuis le nom de dossier)
- La **description courte** (depuis le frontmatter ou le premier paragraphe du SKILL.md)
- Les **tags** (depuis le frontmatter, ou inférés par heuristique sur le nom)

Tu peux vérifier ce qui est détecté :
```bash
npm run test:skills
```

Output attendu :
```
✅ Found 7 skills:

  📦 shopify-app-development
     Source: user
     Path:   /Users/ghiles/.claude/skills/shopify-app-development/SKILL.md
     Tags:   shopify, oauth, app-bridge

  📦 superpowers-tdd
     Source: plugin
     Path:   /Users/ghiles/.claude/plugins/superpowers/skills/tdd/SKILL.md
     Tags:   testing, tdd, superpowers

  📦 polaris-components
     ...
```

## Comment les skills sont distribués aux sous-agents

Chaque sous-agent reçoit **uniquement les skills pertinents pour son rôle**. La logique est dans `src/skills/injector.ts` :

```typescript
const tagsForRole = {
  backend: ['shopify', 'backend', 'api', 'oauth', 'superpowers'],
  ui: ['shopify', 'frontend', 'react', 'polaris', 'app-bridge'],
  database: ['shopify', 'prisma', 'database'],
  tests: ['testing', 'jest', 'playwright', 'tdd', 'superpowers'],
  config: ['shopify', 'config', 'cli'],
  docs: ['documentation', 'markdown'],
};
```

Le sous-agent backend reçoit donc tous les skills tagués `shopify` ou `oauth` ou `superpowers`, mais pas ceux tagués uniquement `frontend`.

## Comment les sous-agents utilisent les skills

Quand le sous-agent reçoit son prompt système, il y a une section ajoutée :

```markdown
## Compétences (skills) disponibles

Tu as accès aux 4 skills suivants installés sur la machine. Avant d'écrire
du code, lis le SKILL.md de chaque skill pertinent pour la tâche en cours.

| Nom | Source | Description courte | Tags |
|-----|--------|-------------------|------|
| `shopify-app-development` | user | Patterns OAuth Shopify... | shopify, oauth |
| `superpowers-tdd` | plugin | TDD-driven workflow... | testing, tdd |
...

Chemins absolus des skills:
- `shopify-app-development` : `/Users/ghiles/.claude/skills/shopify-app-development/SKILL.md`
...
```

Le sous-agent a un outil `Read` (Claude Code), donc il peut faire `Read("/Users/ghiles/.claude/skills/shopify-app-development/SKILL.md")` quand il en a besoin.

## Format attendu des skills

Pour qu'un skill soit bien détecté, son `SKILL.md` doit avoir :

```markdown
---
description: Patterns pour développer des apps Shopify avec OAuth + session tokens.
tags: shopify, oauth, app-bridge, backend
---

# Shopify App Development

Use this skill when implementing OAuth flows, session token validation,
or App Bridge integration in a Shopify app.

## Best practices

...
```

Sans frontmatter, le système fait des heuristiques sur le nom de dossier (ex: si le nom contient "shopify", il ajoute le tag `shopify`). Mais le frontmatter est plus précis et recommandé.

## Cas particulier : Superpowers

Superpowers ajoute des patterns TDD que les sous-agents tests utilisent automatiquement quand le tag `superpowers` est détecté. Le prompt du sous-agent test contient :

> Si tu détectes un skill Superpowers (`tags: ['superpowers']`), suis son pattern TDD : écris d'abord les tests, fais-les échouer, puis implémente.

## Skills officiels Shopify

Si tu as installé les skills officiels Shopify (probablement via un repo Anthropic ou un plugin), ils seront détectés automatiquement s'ils sont dans `~/.claude/skills/` ou `~/.claude/plugins/`. Sinon, configure leur emplacement via `SKILLS_PATH` :

```bash
# .env
SKILLS_PATH="/path/to/shopify-official-skills"
```

## Mode dégradé sans skills

Si aucun skill n'est détecté, le système fonctionne quand même : les sous-agents s'appuient uniquement sur les patterns embedded dans leur prompt système (qui couvrent les bases : webhooks GDPR, session tokens, Polaris). Mais la qualité du code sera **moins optimale** qu'avec les skills locaux.

C'est pour ça que le mode "production VPS" (où les skills ne sont pas accessibles) est moins recommandé que le mode "local Mac avec skills".

## Debugging

Si tu soupçonnes qu'un skill n'est pas utilisé :

1. Vérifier qu'il est détecté : `npm run test:skills`
2. Lancer une génération avec un test : `npm run generate SPEC-XXXX`
3. Inspecter le transcript du sous-agent qui aurait dû utiliser le skill : `cat apps/SPEC-XXXX/transcripts/<chunkId>.txt`
4. Tu peux y voir le prompt complet (incluant la section skills) et la réponse de Claude Code
5. Si Claude Code n'a pas appelé `Read` sur le SKILL.md, c'est que la description du skill n'est pas assez claire ou que les tags ne matchent pas le rôle
