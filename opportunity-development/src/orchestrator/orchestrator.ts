import { logger } from '../utils/logger';
import { ClaudeCodeSpawner } from '../spawn/claude-code-spawner';
import { ParallelPool } from '../spawn/parallel-pool';
import { SubAgent } from '../spawn/sub-agent';
import { WorkspaceManager } from '../workspace/manager';
import { decomposeSpec, type DecomposedPlan } from './task-decomposer';
import { detectSkills } from '../skills/detector';
import { validateWorkspace, summarizeValidation } from '../validation/runner';
import { runShopifyComplianceChecks, formatComplianceReport } from '../validation/shopify-checks';
import { BACKEND_AGENT_PROMPT } from '../prompts/backend-agent-prompt';
import { UI_AGENT_PROMPT } from '../prompts/ui-agent-prompt';
import { DATABASE_AGENT_PROMPT } from '../prompts/database-agent-prompt';
import { TESTS_AGENT_PROMPT } from '../prompts/tests-agent-prompt';
import { CONFIG_AGENT_PROMPT } from '../prompts/config-agent-prompt';
import {
  DOCS_AGENT_PROMPT,
  INTEGRATOR_AGENT_PROMPT,
  REPAIR_AGENT_PROMPT,
} from '../prompts/specialized-agents-prompts';
import type { TechnicalSpec, SubAgentResult, SubAgentRole, TaskChunk } from '../utils/types';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROLE_PROMPTS: Record<SubAgentRole, string> = {
  backend: BACKEND_AGENT_PROMPT,
  ui: UI_AGENT_PROMPT,
  database: DATABASE_AGENT_PROMPT,
  tests: TESTS_AGENT_PROMPT,
  config: CONFIG_AGENT_PROMPT,
  docs: DOCS_AGENT_PROMPT,
  integrator: INTEGRATOR_AGENT_PROMPT,
  repair: REPAIR_AGENT_PROMPT,
};

export interface OrchestrateOptions {
  spec: TechnicalSpec;
  specMarkdown?: string;
  triggerMode: 'manual' | 'auto' | 'api' | 'retry';
  triggeredBy?: string;
  /** Force regeneration even if workspace exists */
  force?: boolean;
  /** Skip the validation phase (faster but less safe) */
  skipValidation?: boolean;
  /** Maximum repair attempts after validation failure (default 3) */
  maxRepairAttempts?: number;
  /** Callback fired after each chunk completes (for progress reporting) */
  onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEvent =
  | { type: 'plan_ready'; chunkCount: number }
  | { type: 'chunk_started'; chunkId: string; role: SubAgentRole; title: string }
  | { type: 'chunk_completed'; chunkId: string; result: SubAgentResult }
  | { type: 'phase_changed'; phase: string }
  | { type: 'validation_result'; passed: boolean; failedSteps: string[] }
  | { type: 'repair_attempt'; attempt: number; remaining: number };

export interface OrchestrateResult {
  status: 'completed' | 'needs_human_review' | 'failed';
  specId: string;
  workspacePath: string;
  totalChunks: number;
  successfulChunks: number;
  failedChunks: number;
  validationPassed: boolean;
  complianceReport: string;
  totalCostUsd: number;
  totalDurationMs: number;
  repairAttempts: number;
  errorReport?: string;
}

/**
 * The full development pipeline.
 */
export async function orchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const startTime = Date.now();
  const { spec, specMarkdown, force = false, maxRepairAttempts = 3 } = options;

  // ─── 1. Setup workspace ──────────────────────────────────────
  const workspace = new WorkspaceManager();
  const workspacePath = workspace.create(spec.specId, { force });
  workspace.initGit(spec.specId);

  if (specMarkdown) {
    workspace.writeSpecMarkdown(spec.specId, specMarkdown);
  } else {
    // Write a minimal SPEC.md from the JSON if no markdown provided
    workspace.writeSpecMarkdown(
      spec.specId,
      `# ${spec.overview.appName}\n\n${spec.overview.tagline}\n\n## JSON Spec\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`
    );
  }

  workspace.commit(spec.specId, 'chore: write spec markdown');

  // ─── 2. Detect skills ────────────────────────────────────────
  const skills = detectSkills();
  logger.info(`Found ${skills.length} skills available to sub-agents`);

  // ─── 3. Decompose ────────────────────────────────────────────
  options.onProgress?.({ type: 'phase_changed', phase: 'planning' });
  let plan: DecomposedPlan;
  try {
    plan = await decomposeSpec(spec);
  } catch (error) {
    logger.error('Decomposition failed', { error: (error as Error).message });
    return {
      status: 'failed',
      specId: spec.specId,
      workspacePath,
      totalChunks: 0,
      successfulChunks: 0,
      failedChunks: 0,
      validationPassed: false,
      complianceReport: '',
      totalCostUsd: 0,
      totalDurationMs: Date.now() - startTime,
      repairAttempts: 0,
      errorReport: `Planning failed: ${(error as Error).message}`,
    };
  }

  options.onProgress?.({ type: 'plan_ready', chunkCount: plan.chunks.length });

  // Persist the plan to the workspace for traceability
  writeFileSync(
    join(workspacePath, 'GENERATION_PLAN.json'),
    JSON.stringify({ chunks: plan.chunks }, null, 2)
  );

  // ─── 4. Execute chunks (DAG with parallelism) ────────────────
  options.onProgress?.({ type: 'phase_changed', phase: 'generating' });

  const spawner = new ClaudeCodeSpawner();
  const pool = new ParallelPool();
  const subAgent = new SubAgent(spawner, workspace, spec.specId, skills, ROLE_PROMPTS);

  const chunkResults = await runDagWithConcurrency(plan, subAgent, pool, options.onProgress);

  workspace.commit(spec.specId, 'feat: generated initial code from spec');

  // Compute totals
  let totalCost = 0;
  for (const r of chunkResults.values()) {
    if (r.costUsd) totalCost += r.costUsd;
  }

  const successful = [...chunkResults.values()].filter((r) => r.status === 'completed').length;
  const failed = plan.chunks.length - successful;

  // ─── 5. Integration ──────────────────────────────────────────
  if (failed === 0) {
    options.onProgress?.({ type: 'phase_changed', phase: 'integrating' });
    await runIntegrationPass(spec, spawner, workspace, skills);
    workspace.commit(spec.specId, 'fix: integration pass');
  }

  // ─── 6. Validation ───────────────────────────────────────────
  let validationPassed = false;
  let validationFailedSteps: string[] = [];

  if (!options.skipValidation && failed === 0) {
    options.onProgress?.({ type: 'phase_changed', phase: 'validating' });
    const validation = await validateWorkspace(workspacePath);
    const summary = summarizeValidation(validation);
    validationPassed = summary.overallStatus !== 'failed';
    validationFailedSteps = [...summary.failedRequired, ...summary.failedOptional];
    options.onProgress?.({
      type: 'validation_result',
      passed: validationPassed,
      failedSteps: validationFailedSteps,
    });

    // ─── 7. Repair loop (if validation failed) ─────────────
    let repairAttempts = 0;
    while (!validationPassed && repairAttempts < maxRepairAttempts) {
      repairAttempts++;
      options.onProgress?.({
        type: 'repair_attempt',
        attempt: repairAttempts,
        remaining: maxRepairAttempts - repairAttempts,
      });

      const repairOk = await runRepairPass(spec, spawner, workspace, skills, summary.errorReport);
      if (!repairOk) break;

      const revalidation = await validateWorkspace(workspacePath);
      const newSummary = summarizeValidation(revalidation);
      validationPassed = newSummary.overallStatus !== 'failed';
      validationFailedSteps = [...newSummary.failedRequired, ...newSummary.failedOptional];

      if (validationPassed) {
        workspace.commit(spec.specId, `fix: repair pass ${repairAttempts}`);
      }
    }

    // ─── 8. Run Shopify compliance checks ──────────────────
    const compliance = runShopifyComplianceChecks(workspacePath, spec);
    const complianceReport = formatComplianceReport(compliance);
    writeFileSync(join(workspacePath, 'COMPLIANCE_REPORT.md'), complianceReport);
    workspace.commit(spec.specId, 'docs: add compliance report');

    // Determine final status
    let finalStatus: OrchestrateResult['status'];
    if (validationPassed && compliance.every((c) => c.passed)) {
      finalStatus = 'completed';
    } else if (repairAttempts >= maxRepairAttempts) {
      finalStatus = 'needs_human_review';
    } else {
      finalStatus = 'needs_human_review';
    }

    return {
      status: finalStatus,
      specId: spec.specId,
      workspacePath,
      totalChunks: plan.chunks.length,
      successfulChunks: successful,
      failedChunks: failed,
      validationPassed,
      complianceReport,
      totalCostUsd: totalCost,
      totalDurationMs: Date.now() - startTime,
      repairAttempts,
      errorReport: validationPassed ? undefined : validationFailedSteps.join(', '),
    };
  }

  // No validation path
  return {
    status: failed === 0 ? 'completed' : 'failed',
    specId: spec.specId,
    workspacePath,
    totalChunks: plan.chunks.length,
    successfulChunks: successful,
    failedChunks: failed,
    validationPassed: false,
    complianceReport: '',
    totalCostUsd: totalCost,
    totalDurationMs: Date.now() - startTime,
    repairAttempts: 0,
    errorReport: failed > 0 ? `${failed} chunks failed` : undefined,
  };
}

/** Execute a DAG of chunks respecting dependencies and the parallel pool. */
async function runDagWithConcurrency(
  plan: DecomposedPlan,
  subAgent: SubAgent,
  pool: ParallelPool,
  onProgress?: (event: ProgressEvent) => void
): Promise<Map<string, SubAgentResult>> {
  const results = new Map<string, SubAgentResult>();
  const completed = new Set<string>();
  const remaining = new Set(plan.chunks.map((c) => c.id));
  const byId = new Map(plan.chunks.map((c) => [c.id, c]));

  // Loop until all chunks complete or no progress can be made
  while (remaining.size > 0) {
    // Find all chunks whose deps are satisfied
    const ready = [...remaining]
      .map((id) => byId.get(id)!)
      .filter((c) => c.dependencies.every((dep) => completed.has(dep)));

    if (ready.length === 0) {
      // Deadlock — shouldn't happen if DAG validated
      logger.error('Deadlock in DAG execution', {
        remaining: [...remaining],
        completed: [...completed],
      });
      // Mark remaining as failed
      for (const id of remaining) {
        results.set(id, {
          chunkId: id,
          status: 'failed',
          filesCreated: [],
          filesModified: [],
          durationMs: 0,
          errorMessage: 'Skipped: dependency failed',
        });
      }
      break;
    }

    // Run all ready chunks in parallel (bounded by pool)
    const tasks = ready.map((chunk) => async () => {
      onProgress?.({
        type: 'chunk_started',
        chunkId: chunk.id,
        role: chunk.role,
        title: chunk.title,
      });

      const result = await subAgent.run(chunk);
      onProgress?.({ type: 'chunk_completed', chunkId: chunk.id, result });

      results.set(chunk.id, result);
      remaining.delete(chunk.id);
      if (result.status === 'completed') {
        completed.add(chunk.id);
      } else {
        // For now, treat failed/timeout as "not completed" — dependents will be skipped
        // The repair pass will handle these.
        logger.warn(`Chunk ${chunk.id} did not complete cleanly`, {
          status: result.status,
          error: result.errorMessage,
        });
      }
    });

    await pool.runAll(tasks);

    // If a wave produced no new completed chunks, abort to avoid infinite loop
    const stillBlocked = [...remaining].filter((id) =>
      byId.get(id)!.dependencies.some((dep) => !completed.has(dep))
    );
    if (stillBlocked.length === remaining.size) {
      // Dependencies cannot be satisfied — mark remaining as skipped
      for (const id of remaining) {
        if (!results.has(id)) {
          results.set(id, {
            chunkId: id,
            status: 'failed',
            filesCreated: [],
            filesModified: [],
            durationMs: 0,
            errorMessage: 'Skipped: blocking dependency failed',
          });
        }
      }
      break;
    }
  }

  return results;
}

/** Run an integration sub-agent that fixes cross-module issues. */
async function runIntegrationPass(
  spec: TechnicalSpec,
  spawner: ClaudeCodeSpawner,
  workspace: WorkspaceManager,
  skills: ReturnType<typeof detectSkills>
): Promise<void> {
  const workspacePath = workspace.pathFor(spec.specId);
  await spawner.spawn({
    workingDirectory: workspacePath,
    prompt: `Tu es l'intégrateur final de l'app Shopify ${spec.specId} (${spec.overview.appName}).

Vérifie et corrige les incohérences entre les modules produits par les sous-agents précédents (backend, ui, database, tests, config, docs).

Ton mandat est dans ton system prompt. Commence par lancer \`npm install\` puis \`npx tsc --noEmit\`, et corrige les erreurs détectées.

Crée \`INTEGRATION_REPORT.md\` à la fin avec un résumé.`,
    appendSystemPrompt: INTEGRATOR_AGENT_PROMPT,
    skills,
    timeoutMs: 30 * 60 * 1000,
    label: `integrator-${spec.specId}`,
    transcriptPath: 'transcripts/integrator.txt',
  });
}

/** Run a repair sub-agent with the validation error report as input. */
async function runRepairPass(
  spec: TechnicalSpec,
  spawner: ClaudeCodeSpawner,
  workspace: WorkspaceManager,
  skills: ReturnType<typeof detectSkills>,
  errorReport: string
): Promise<boolean> {
  const workspacePath = workspace.pathFor(spec.specId);
  try {
    await spawner.spawn({
      workingDirectory: workspacePath,
      prompt: `La validation de l'app ${spec.specId} a échoué. Voici les erreurs à corriger :

\`\`\`
${errorReport.slice(0, 5000)}
\`\`\`

Diagnostique la cause racine et corrige avec des modifications minimales et ciblées. Re-lance la validation après chaque correction.

Ton mandat complet est dans ton system prompt.`,
      appendSystemPrompt: REPAIR_AGENT_PROMPT,
      skills,
      timeoutMs: 20 * 60 * 1000,
      label: `repair-${spec.specId}`,
      transcriptPath: `transcripts/repair-${Date.now()}.txt`,
    });
    return true;
  } catch (err) {
    logger.error('Repair pass spawn failed', { error: (err as Error).message });
    return false;
  }
}
