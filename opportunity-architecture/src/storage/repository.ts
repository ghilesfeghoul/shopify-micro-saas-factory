import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import type { OpportunityFromDetector, SpecStatus, TriggerMode } from '../utils/types';
import type { TechnicalSpec } from '../architect/schemas/spec-schema';

export const prisma = new PrismaClient({
  log: process.env.LOG_LEVEL === 'debug' ? ['query', 'error'] : ['error'],
});

// ─── Opportunity cache ────────────────────────────────────────────

/**
 * Sync an opportunity from the detector into our local cache.
 * Updates if exists, creates otherwise.
 */
export async function upsertOpportunityCache(opp: OpportunityFromDetector): Promise<void> {
  await prisma.opportunityCache.upsert({
    where: { opportunityId: opp.opportunityId },
    create: {
      opportunityId: opp.opportunityId,
      title: opp.title,
      problemStatement: opp.problemStatement,
      totalScore: opp.totalScore,
      priority: opp.priority,
      suggestedPricing: opp.suggestedPricing,
      estimatedDevTime: opp.estimatedDevTime,
      competitorAnalysis: opp.competitorAnalysis,
      recommendedFeatures: opp.recommendedFeatures,
      detectorStatus: opp.status,
    },
    update: {
      title: opp.title,
      problemStatement: opp.problemStatement,
      totalScore: opp.totalScore,
      priority: opp.priority,
      suggestedPricing: opp.suggestedPricing,
      estimatedDevTime: opp.estimatedDevTime,
      competitorAnalysis: opp.competitorAnalysis,
      recommendedFeatures: opp.recommendedFeatures,
      detectorStatus: opp.status,
      lastSeenAt: new Date(),
    },
  });
}

export async function getOpportunityCache(opportunityId: string) {
  return prisma.opportunityCache.findUnique({
    where: { opportunityId },
  });
}

export async function listCachedOpportunities(filter: {
  hasActiveSpec?: boolean;
  minScore?: number;
  priority?: string;
  limit?: number;
} = {}) {
  return prisma.opportunityCache.findMany({
    where: {
      ...(filter.hasActiveSpec !== undefined && { hasActiveSpec: filter.hasActiveSpec }),
      ...(filter.minScore !== undefined && { totalScore: { gte: filter.minScore } }),
      ...(filter.priority && { priority: filter.priority }),
    },
    orderBy: [{ totalScore: 'desc' }, { lastSeenAt: 'desc' }],
    take: filter.limit ?? 50,
  });
}

// ─── Architecture specs ───────────────────────────────────────────

export interface SaveSpecParams {
  spec: TechnicalSpec;
  triggerMode: TriggerMode;
  triggeredBy?: string;
  llmBackend: string;
  llmModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs: number;
}

/**
 * Save a generated spec. Marks previous active versions inactive.
 */
export async function saveSpec(params: SaveSpecParams): Promise<{ id: string; specId: string }> {
  const { spec } = params;

  // Determine version: increment if previous specs exist for this opportunity
  const existingCount = await prisma.architectureSpec.count({
    where: { opportunityId: spec.opportunityId },
  });

  // Mark all previous specs inactive
  if (existingCount > 0) {
    await prisma.architectureSpec.updateMany({
      where: { opportunityId: spec.opportunityId, isActive: true },
      data: { isActive: false },
    });
  }

  const created = await prisma.architectureSpec.create({
    data: {
      specId: spec.specId,
      opportunityId: spec.opportunityId,
      specJson: JSON.stringify(spec),
      appName: spec.overview.appName,
      shortDescription: spec.overview.tagline,
      estimatedHours: spec.estimation.totalHours,
      complexityScore: spec.estimation.complexityScore,
      version: existingCount + 1,
      isActive: true,
      status: 'draft',
      triggerMode: params.triggerMode,
      triggeredBy: params.triggeredBy,
      llmBackend: params.llmBackend,
      llmModel: params.llmModel,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      costUsd: params.costUsd,
      durationMs: params.durationMs,
      specSchemaVersion: spec.schemaVersion,
    },
  });

  // Update cache flag
  await prisma.opportunityCache.update({
    where: { opportunityId: spec.opportunityId },
    data: { hasActiveSpec: true },
  });

  return { id: created.id, specId: created.specId };
}

/**
 * Get a spec by its SPEC-XXXX ID.
 */
export async function getSpec(specId: string) {
  return prisma.architectureSpec.findUnique({
    where: { specId },
    include: { cache: true },
  });
}

/**
 * Get the active spec for an opportunity.
 */
export async function getActiveSpecForOpportunity(opportunityId: string) {
  return prisma.architectureSpec.findFirst({
    where: { opportunityId, isActive: true },
    orderBy: { version: 'desc' },
    include: { cache: true },
  });
}

/**
 * List specs with filters.
 */
export async function listSpecs(filter: {
  status?: SpecStatus;
  isActive?: boolean;
  opportunityId?: string;
  limit?: number;
} = {}) {
  return prisma.architectureSpec.findMany({
    where: {
      ...(filter.status && { status: filter.status }),
      ...(filter.isActive !== undefined && { isActive: filter.isActive }),
      ...(filter.opportunityId && { opportunityId: filter.opportunityId }),
    },
    orderBy: { generatedAt: 'desc' },
    take: filter.limit ?? 50,
    include: { cache: { select: { title: true, totalScore: true, priority: true } } },
  });
}

/**
 * Update spec status (lifecycle transitions).
 */
export async function updateSpecStatus(
  specId: string,
  status: SpecStatus,
  options: { rejectionReason?: string } = {}
) {
  const update: Record<string, unknown> = { status };
  if (status === 'reviewed') update.reviewedAt = new Date();
  if (status === 'approved') update.approvedAt = new Date();
  if (status === 'rejected' && options.rejectionReason) {
    update.rejectionReason = options.rejectionReason;
  }

  return prisma.architectureSpec.update({
    where: { specId },
    data: update,
  });
}

// ─── Run tracking ─────────────────────────────────────────────────

export async function createArchitectRun(opportunityId: string, triggerMode: TriggerMode, triggerSource?: string): Promise<string> {
  const run = await prisma.architectRun.create({
    data: {
      opportunityId,
      triggerMode,
      triggerSource,
      status: 'running',
    },
  });
  return run.id;
}

export async function completeArchitectRun(
  runId: string,
  data: { specId?: string; error?: string }
): Promise<void> {
  await prisma.architectRun.update({
    where: { id: runId },
    data: {
      completedAt: new Date(),
      status: data.error ? 'failed' : 'completed',
      specId: data.specId,
      errorMessage: data.error,
    },
  });
}

export async function listRecentRuns(limit = 20) {
  return prisma.architectRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

// ─── Poll runs ────────────────────────────────────────────────────

export async function createPollRun(): Promise<string> {
  const run = await prisma.pollRun.create({ data: { status: 'running' } });
  return run.id;
}

export async function completePollRun(
  runId: string,
  data: {
    opportunitiesFetched: number;
    opportunitiesNew: number;
    autoTriggered: number;
    error?: string;
  }
): Promise<void> {
  await prisma.pollRun.update({
    where: { id: runId },
    data: {
      completedAt: new Date(),
      status: data.error ? 'failed' : 'completed',
      opportunitiesFetched: data.opportunitiesFetched,
      opportunitiesNew: data.opportunitiesNew,
      autoTriggered: data.autoTriggered,
      errorMessage: data.error,
    },
  });
}

export async function listRecentPolls(limit = 10) {
  return prisma.pollRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

// ─── Stats ────────────────────────────────────────────────────────

export async function getStats() {
  const [totalSpecs, activeSpecs, byStatus, totalCached, withSpec] = await Promise.all([
    prisma.architectureSpec.count(),
    prisma.architectureSpec.count({ where: { isActive: true } }),
    prisma.architectureSpec.groupBy({ by: ['status'], _count: true, where: { isActive: true } }),
    prisma.opportunityCache.count(),
    prisma.opportunityCache.count({ where: { hasActiveSpec: true } }),
  ]);

  const totalCost = await prisma.architectureSpec.aggregate({
    _sum: { costUsd: true },
  });

  return {
    totalSpecs,
    activeSpecs,
    byStatus,
    cachedOpportunities: totalCached,
    opportunitiesWithSpec: withSpec,
    totalCostUsd: totalCost._sum.costUsd ?? 0,
  };
}

logger.debug('Repository module loaded');
