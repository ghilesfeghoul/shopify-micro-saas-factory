# ⚡ Parallélisation des sous-agents

L'agent Développeur utilise une stratégie **hybride** (per architecture decision) : un orchestrateur principal qui spawn des sous-agents en parallèle quand leurs dépendances sont satisfaites, puis fait une passe d'intégration finale.

## Schéma général

```
1. PLANIFICATION (orchestrator)
   ├─ Spec → Décomposition en chunks (5-12 selon complexité)
   ├─ Construction du DAG de dépendances
   └─ Validation du graphe (pas de cycle)

2. EXÉCUTION (DAG avec concurrence bornée)
   Vague 1: chunks sans dépendances → exécutés en parallèle (jusqu'à MAX_PARALLEL_SUBAGENTS)
   Vague 2: chunks dont les deps sont satisfaites
   Vague 3: ...
   ↓
   Tous les chunks complétés ou bloqués

3. INTÉGRATION (intégrateur)
   ├─ npm install
   ├─ tsc --noEmit
   ├─ Corrections cross-modules
   └─ INTEGRATION_REPORT.md

4. VALIDATION (runner)
   ├─ Lint
   ├─ Build
   ├─ Tests
   └─ Compliance Shopify

5. REPAIR LOOP (si validation échoue)
   ├─ Spawn repair sub-agent avec rapport d'erreur
   ├─ Re-validation
   └─ Max 3 itérations → sinon "needs_human_review"
```

## Exemple concret avec OPP-STKM

Pour l'app "Stocky Migrator" (estimation ~60h, complexité 6/10), le décomposeur produit typiquement 8 chunks :

```
Chunk 0 (config)        ──┐
                          │
Chunk 1 (database)      ──┼──> Chunk 4 (backend endpoints)  ──┐
                          │                                    │
Chunk 2 (config secondary)┘                                    │
                                                                │
                                  Chunk 5 (UI screens)        ──┤
                                                                │
                                  Chunk 6 (Stocky import)     ──┤
                                                                │
                                                Chunk 7 (tests) ──┐
                                                                  │
                                                Chunk 3 (docs)  ──┘
```

Avec `MAX_PARALLEL_SUBAGENTS=3` :

| Wave | Chunks running | Time |
|------|----------------|------|
| 1 | 0, 1, 2 (config + db + config2) | ~5 min |
| 2 | 3, 4 (docs + backend) | ~15 min |
| 3 | 5, 6 (UI + Stocky import) | ~20 min |
| 4 | 7 (tests) | ~10 min |
| Integration | 1 sub-agent solo | ~5 min |
| Validation | sequential | ~3 min |
| Total | ~58 min | |

Sans parallélisation (séquentiel pur) : ~95 min. Gain ~38%.

## Pourquoi 3 par défaut ?

`MAX_PARALLEL_SUBAGENTS=3` est un compromis :

- **1** : trop lent, ne tire pas parti du DAG
- **3** : sweet spot pour Pro/Max + machines moyennes
- **6+** : risque de saturer les quotas Claude Code Pro, ou la RAM (chaque subprocess = 200-500 MB)
- **10+** : tu vas finir blocké en rate limit côté API si tu utilises l'API mode

Tu peux passer à 5-6 si :
- Tu es sur abonnement Claude Max
- Ta machine a 16+ GB de RAM
- Tu veux maximiser la vitesse

Tu devrais rester à 2-3 si :
- Pro standard
- 8 GB de RAM
- Tu veux préserver tes quotas pour autre chose pendant la génération

## Détection des deadlocks

Le DAG est validé à la planification (cycle detection via DFS). Mais il y a un autre cas de "deadlock soft" : un chunk échoue, et tous ses dépendants sont bloqués.

Comportement actuel :
- Le chunk en échec garde `status: failed`
- Tous ses dépendants sont marqués `status: failed` avec `errorMessage: "Skipped: dependency failed"`
- L'intégration ne tourne PAS si des chunks ont échoué (ça serait perdre du temps sur du code partiel)
- Le run global est marqué `failed`
- Un `npm run retry APP-XXXX` re-fait toute la génération avec `--force`

Possible amélioration future : retry partiel (ne refait que les chunks échoués). Pas implémenté en v1 par souci de simplicité.

## Garde-fous

- **Timeout par chunk** : 10-30 min selon le rôle. Au-delà, le sous-agent est tué (`SIGKILL`)
- **Verification expectedOutputs** : si un chunk dit "je vais créer src/api/server.ts" et que ce fichier n'existe pas à la fin, il est marqué `failed`
- **Snapshot filesystem** : avant/après chaque chunk, on diff les fichiers pour détecter ce qui a vraiment été créé/modifié (utile pour debugging)
- **Transcripts sauvegardés** : `transcripts/<chunkId>.txt` dans le workspace, contient prompt + stdout + stderr du sous-agent
- **Limite repair attempts** : 3 par défaut. Au-delà → `needs_human_review`

## Résumé des coûts par run

Empirique pour une app moyenne (6 sous-agents code + 1 intégrateur + 0-3 repair) :

| Phase | Chunks | Tokens output moyen | Cost (API mode) |
|-------|--------|---------------------|-----------------|
| Planning | 1 | ~3k | ~0.5€ |
| Generation | 6 | 8-15k chacun | ~5-10€ |
| Integration | 1 | ~5k | ~0.5€ |
| Repair (si activé) | 0-3 | 5-10k | 0-3€ |
| **Total** | | | **6-14€ par app** |

En mode Claude Code Pro/Max : **0€ marginal** (consomme tes quotas).
