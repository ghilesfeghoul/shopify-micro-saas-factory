import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import type { GenerationStatus, SubAgentResult, TaskChunk, TriggerMode } from '../utils/types';

export const prisma = new PrismaClient({
  log: process.env.LOG_LEVEL === 'debug' ? ['query', 'error'] : ['error'],
});

// ─── Generation runs ──────────────────────────────────────────────

export interface CreateRunParams {
  appId: string;
  specId: string;
  opportunityId: string;
  workspacePath: string;
  triggerMode: TriggerMode;
  triggeredBy?: string;
  maxRepairAttempts?: number;
}

export async function createGenerationRun(params: CreateRunParams): Promise<string> {
  const run = await prisma.generationRun.create({
    data: {
      appId: params.appId,
      specId: params.specId,
      opportunityId: params.opportunityId,
      workspacePath: params.workspacePath,
      triggerMode: params.triggerMode,
      triggeredBy: params.triggeredBy,
      status: 'pending',
      maxRepairAttempts: params.maxRepairAttempts ?? 3,
    },
  });
  return run.id;
}

export async function updateRunStatus(
  runId: string,
  status: GenerationStatus,
  data: Partial<{
    totalChunks: number;
    successfulChunks: number;
    failedChunks: number;
    validationPassed: boolean;
    validationFailures: string[];
    complianceReportMd: string;
    compliancePassed: boolean;
    repairAttempts: number;
    totalCostUsd: number;
    totalDurationMs: number;
    errorMessage: string;
    hasGitRepo: boolean;
  }> = {}
): Promise<void> {
  const update: Record<string, unknown> = { status };
  if (data.totalChunks !== undefined) update.totalChunks = data.totalChunks;
  if (data.successfulChunks !== undefined) update.successfulChunks = data.successfulChunks;
  if (data.failedChunks !== undefined) update.failedChunks = data.failedChunks;
  if (data.validationPassed !== undefined) update.validationPassed = data.validationPassed;
  if (data.validationFailures) update.validationFailures = JSON.stringify(data.validationFailures);
  if (data.complianceReportMd !== undefined) update.complianceReportMd = data.complianceReportMd;
  if (data.compliancePassed !== undefined) update.compliancePassed = data.compliancePassed;
  if (data.repairAttempts !== undefined) update.repairAttempts = data.repairAttempts;
  if (data.totalCostUsd !== undefined) update.totalCostUsd = data.totalCostUsd;
  if (data.totalDurationMs !== undefined) update.totalDurationMs = data.totalDurationMs;
  if (data.errorMessage !== undefined) update.errorMessage = data.errorMessage;
  if (data.hasGitRepo !== undefined) update.hasGitRepo = data.hasGitRepo;

  if (status === 'completed' || status === 'failed' || status === 'needs_human_review') {
    update.completedAt = new Date();
  }

  await prisma.generationRun.update({ where: { id: runId }, data: update });
}

export async function getRun(appIdOrInternalId: string) {
  return prisma.generationRun.findFirst({
    where: {
      OR: [{ appId: appIdOrInternalId }, { id: appIdOrInternalId }],
    },
    include: {
      chunks: {
        orderBy: { startedAt: 'asc' },
      },
    },
  });
}

export async function listRuns(filter: {
  status?: GenerationStatus;
  specId?: string;
  limit?: number;
} = {}) {
  return prisma.generationRun.findMany({
    where: {
      ...(filter.status && { status: filter.status }),
      ...(filter.specId && { specId: filter.specId }),
    },
    orderBy: { startedAt: 'desc' },
    take: filter.limit ?? 50,
    include: {
      chunks: {
        select: {
          id: true,
          chunkId: true,
          role: true,
          status: true,
          durationMs: true,
        },
      },
    },
  });
}

// ─── Sub-agent tasks ──────────────────────────────────────────────

export async function recordChunks(runId: string, chunks: TaskChunk[]): Promise<void> {
  await prisma.subAgentTask.createMany({
    data: chunks.map((c) => ({
      chunkId: c.id,
      generationRunId: runId,
      role: c.role,
      title: c.title,
      instruction: c.instruction.slice(0, 10_000),
      dependencies: JSON.stringify(c.dependencies),
      expectedOutputs: JSON.stringify(c.expectedOutputs),
      status: 'pending',
    })),
  });
}

export async function recordChunkResult(
  runId: string,
  result: SubAgentResult
): Promise<void> {
  await prisma.subAgentTask.updateMany({
    where: { generationRunId: runId, chunkId: result.chunkId },
    data: {
      status: result.status,
      filesCreated: JSON.stringify(result.filesCreated),
      filesModified: JSON.stringify(result.filesModified),
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      completedAt: new Date(),
      errorMessage: result.errorMessage?.slice(0, 5000),
    },
  });
}

// ─── Stats ────────────────────────────────────────────────────────

export async function getStats() {
  const [total, byStatus, totalCost, totalDuration] = await Promise.all([
    prisma.generationRun.count(),
    prisma.generationRun.groupBy({ by: ['status'], _count: true }),
    prisma.generationRun.aggregate({ _sum: { totalCostUsd: true } }),
    prisma.generationRun.aggregate({ _avg: { totalDurationMs: true } }),
  ]);

  return {
    totalRuns: total,
    byStatus,
    totalCostUsd: totalCost._sum.totalCostUsd ?? 0,
    avgDurationMs: totalDuration._avg.totalDurationMs ?? 0,
  };
}

logger.debug('Repository module loaded');
