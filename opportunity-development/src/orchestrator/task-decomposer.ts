import { logger } from '../utils/logger';
import { createLLMProvider } from '../llm/factory';
import { ORCHESTRATOR_SYSTEM_PROMPT } from '../prompts/orchestrator-prompt';
import { generateChunkId } from '../utils/id-generator';
import type { TaskChunk, TechnicalSpec } from '../utils/types';

const DECOMPOSITION_SCHEMA = {
  type: 'object',
  required: ['chunks'],
  properties: {
    chunks: {
      type: 'array',
      minItems: 5,
      maxItems: 12,
      items: {
        type: 'object',
        required: ['role', 'title', 'instruction', 'expectedOutputs', 'dependencies', 'timeoutMs'],
        properties: {
          role: {
            type: 'string',
            enum: ['backend', 'ui', 'database', 'tests', 'config', 'docs'],
          },
          title: { type: 'string', minLength: 5, maxLength: 100 },
          instruction: { type: 'string', minLength: 50 },
          expectedOutputs: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
          },
          dependencies: {
            type: 'array',
            items: { type: 'string' },
            description: 'Indices (as strings, "0"-based) of chunks this depends on',
          },
          timeoutMs: { type: 'integer', minimum: 60_000, maximum: 3_600_000 },
        },
      },
    },
  },
};

export interface DecomposedPlan {
  chunks: TaskChunk[];
  /** Adjacency list: chunkId → [chunkIds it blocks] (reverse of deps) */
  blockedBy: Map<string, string[]>;
}

/**
 * Decompose a TechnicalSpec into an executable DAG of chunks.
 * Calls an LLM (Claude Code or API) to produce the plan.
 */
export async function decomposeSpec(spec: TechnicalSpec): Promise<DecomposedPlan> {
  const provider = createLLMProvider();
  logger.info(`Decomposing spec ${spec.specId} via ${provider.name}`);

  const userMessage = buildPlannerMessage(spec);

  const response = await provider.analyze({
    systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    userMessage,
    jsonSchema: DECOMPOSITION_SCHEMA,
    toolName: 'submit_decomposition',
    maxTokens: 8000,
  });

  const raw = response.data as { chunks: Array<Omit<TaskChunk, 'id'> & { dependencies: string[] }> };

  // Assign chunk IDs and remap dependencies (which are LLM-provided as positional indices)
  const chunks: TaskChunk[] = raw.chunks.map((c, idx) => ({
    id: `${idx.toString().padStart(2, '0')}-${generateChunkId()}`,
    role: c.role,
    title: c.title,
    instruction: c.instruction,
    expectedOutputs: c.expectedOutputs,
    dependencies: [], // remapped below
    timeoutMs: c.timeoutMs,
  }));

  // Remap deps: LLM gives "0", "1", etc. (string indices). We resolve to actual chunk IDs.
  for (let i = 0; i < raw.chunks.length; i++) {
    const depIndices = raw.chunks[i]!.dependencies || [];
    chunks[i]!.dependencies = depIndices
      .map((depIdx) => {
        const idxNum = parseInt(depIdx, 10);
        if (isNaN(idxNum) || idxNum < 0 || idxNum >= chunks.length || idxNum === i) return null;
        return chunks[idxNum]!.id;
      })
      .filter((x): x is string => x !== null);
  }

  // Validate DAG (no cycles)
  if (hasCycle(chunks)) {
    throw new Error('Decomposition produced a cyclic dependency graph');
  }

  // Build reverse adjacency
  const blockedBy = new Map<string, string[]>();
  for (const chunk of chunks) {
    for (const dep of chunk.dependencies) {
      const list = blockedBy.get(dep) ?? [];
      list.push(chunk.id);
      blockedBy.set(dep, list);
    }
  }

  logger.info(`Decomposed into ${chunks.length} chunks`, {
    roles: chunks.map((c) => c.role),
    hasUnblocked: chunks.filter((c) => c.dependencies.length === 0).length,
  });

  return { chunks, blockedBy };
}

function buildPlannerMessage(spec: TechnicalSpec): string {
  return `Voici la spécification technique à décomposer en chunks d'exécution.

# SPEC

\`\`\`json
${JSON.stringify(spec, null, 2)}
\`\`\`

# CONSIGNES

Décompose cette spec en 5-12 chunks que des sous-agents spécialisés (backend, ui, database, tests, config, docs) pourront exécuter en parallèle quand leurs dépendances sont satisfaites.

Réfère-toi à \`overview.mvpScope\` pour identifier les features à livrer en MVP.
Réfère-toi à \`apiEndpoints\`, \`database.tables\`, \`ui.screens\` pour quantifier le travail par module.
Réfère-toi à \`estimation.totalHours\` pour calibrer la granularité.

Appelle maintenant \`submit_decomposition\` avec ton plan.`;
}

/** Cycle detection via DFS. */
function hasCycle(chunks: TaskChunk[]): boolean {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const c of chunks) color.set(c.id, WHITE);

  function dfs(id: string): boolean {
    color.set(id, GRAY);
    const node = byId.get(id);
    if (!node) return false;
    for (const dep of node.dependencies) {
      const c = color.get(dep);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(dep)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const c of chunks) {
    if (color.get(c.id) === WHITE && dfs(c.id)) return true;
  }
  return false;
}

/**
 * Compute the topological order (just the ready order, useful for sequential mode).
 * Returns chunk IDs in the order they would run if concurrency were 1.
 */
export function topologicalOrder(plan: DecomposedPlan): string[] {
  const inDegree = new Map<string, number>();
  for (const chunk of plan.chunks) {
    inDegree.set(chunk.id, chunk.dependencies.length);
  }

  const ready: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) ready.push(id);
  }

  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    const blocked = plan.blockedBy.get(id) ?? [];
    for (const blockedId of blocked) {
      const newDeg = (inDegree.get(blockedId) ?? 0) - 1;
      inDegree.set(blockedId, newDeg);
      if (newDeg === 0) ready.push(blockedId);
    }
  }

  return order;
}
