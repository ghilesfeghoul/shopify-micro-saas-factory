import { logger } from '../utils/logger';
import { getDetectorClient } from '../detector-client/client';
import { generateSpec } from '../architect/generator';
import {
  upsertOpportunityCache,
  getActiveSpecForOpportunity,
  saveSpec,
  createArchitectRun,
  completeArchitectRun,
} from '../storage/repository';
import type { TriggerMode } from '../utils/types';
import type { TechnicalSpec } from '../architect/schemas/spec-schema';

export interface OrchestrateOptions {
  opportunityId: string;
  triggerMode: TriggerMode;
  triggeredBy?: string;
  triggerSource?: string;
  forceRegenerate?: boolean;
  syncDetectorStatus?: boolean; // if true, set detector opportunity to "building"
}

export interface OrchestrateResult {
  status: 'created' | 'skipped' | 'failed';
  specId?: string;
  spec?: TechnicalSpec;
  reason?: string;
  costUsd?: number;
  durationMs?: number;
}

/**
 * The full pipeline:
 *   1. Fetch the opportunity from the detector (fresh data)
 *   2. Cache it locally
 *   3. Check if we already have an active spec (unless forceRegenerate)
 *   4. Call the LLM to generate the spec
 *   5. Validate, persist, and update detector status
 */
export async function orchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const startTime = Date.now();
  const runId = await createArchitectRun(options.opportunityId, options.triggerMode, options.triggerSource);

  try {
    // ─── 1. Fetch opportunity from detector ──────────────────
    const client = getDetectorClient();
    const opportunity = await client.getOpportunity(options.opportunityId);
    if (!opportunity) {
      const reason = `Opportunity ${options.opportunityId} not found in detector`;
      await completeArchitectRun(runId, { error: reason });
      return { status: 'failed', reason };
    }

    // ─── 2. Cache locally ────────────────────────────────────
    await upsertOpportunityCache(opportunity);

    // ─── 3. Check existing active spec ───────────────────────
    if (!options.forceRegenerate) {
      const existing = await getActiveSpecForOpportunity(options.opportunityId);
      if (existing) {
        await completeArchitectRun(runId, { specId: existing.specId, error: undefined });
        return {
          status: 'skipped',
          specId: existing.specId,
          reason: `Active spec ${existing.specId} already exists. Use forceRegenerate=true to override.`,
        };
      }
    }

    // ─── 4. Generate spec ────────────────────────────────────
    const generation = await generateSpec(opportunity, {
      triggerMode: options.triggerMode,
      triggeredBy: options.triggeredBy,
      forceRegenerate: options.forceRegenerate,
    });

    // ─── 5. Persist ──────────────────────────────────────────
    const saved = await saveSpec({
      spec: generation.spec,
      triggerMode: options.triggerMode,
      triggeredBy: options.triggeredBy,
      llmBackend: generation.llmBackend,
      llmModel: generation.llmModel,
      inputTokens: generation.inputTokens,
      outputTokens: generation.outputTokens,
      costUsd: generation.costUsd,
      durationMs: generation.durationMs,
    });

    // ─── 6. Optionally update detector status ────────────────
    if (options.syncDetectorStatus) {
      try {
        await client.updateOpportunityStatus(options.opportunityId, {
          status: 'building',
          reviewNotes: `Spec generated: ${saved.specId}`,
        });
      } catch (err) {
        logger.warn('Failed to sync detector status (non-fatal)', { error: (err as Error).message });
      }
    }

    await completeArchitectRun(runId, { specId: saved.specId });

    const durationMs = Date.now() - startTime;
    logger.info(`Orchestration completed`, {
      specId: saved.specId,
      opportunityId: options.opportunityId,
      durationMs,
    });

    return {
      status: 'created',
      specId: saved.specId,
      spec: generation.spec,
      costUsd: generation.costUsd,
      durationMs,
    };
  } catch (error) {
    const errMsg = (error as Error).message;
    logger.error('Orchestration failed', { error: errMsg, opportunityId: options.opportunityId });
    await completeArchitectRun(runId, { error: errMsg });
    return { status: 'failed', reason: errMsg, durationMs: Date.now() - startTime };
  }
}
