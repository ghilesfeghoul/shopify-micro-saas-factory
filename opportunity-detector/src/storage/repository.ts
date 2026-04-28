import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import type { RawSignal, Opportunity } from '../utils/types';

export const prisma = new PrismaClient({
  log: process.env.LOG_LEVEL === 'debug' ? ['query', 'error'] : ['error'],
});

/**
 * Save raw signals, deduplicating by sourceUrl.
 * Returns count of new signals + array of all (new+existing) with IDs.
 */
export async function saveSignals(signals: RawSignal[]): Promise<{
  newCount: number;
  signals: (RawSignal & { id: string })[];
}> {
  const saved: (RawSignal & { id: string })[] = [];
  let newCount = 0;

  for (const signal of signals) {
    try {
      const result = await prisma.rawSignal.upsert({
        where: { sourceUrl: signal.sourceUrl },
        create: {
          source: signal.source,
          sourceUrl: signal.sourceUrl,
          signalType: signal.signalType,
          title: signal.title,
          content: signal.content,
          metadata: JSON.stringify(signal.metadata),
        },
        update: {}, // Don't overwrite existing
      });

      if (result.scrapedAt.getTime() === result.scrapedAt.getTime()) {
        // Check if this was a create (rough heuristic)
        const ageMs = Date.now() - result.scrapedAt.getTime();
        if (ageMs < 60000) newCount++;
      }

      saved.push({ ...signal, id: result.id });
    } catch (error) {
      logger.warn('Failed to save signal', { url: signal.sourceUrl, error: (error as Error).message });
    }
  }

  logger.info(`Signals saved: ${newCount} new, ${saved.length} total in batch`);
  return { newCount, signals: saved };
}

/**
 * Get unprocessed signals for analysis.
 */
export async function getUnprocessedSignals(limit = 200): Promise<(RawSignal & { id: string })[]> {
  const records = await prisma.rawSignal.findMany({
    where: { processed: false },
    orderBy: { scrapedAt: 'desc' },
    take: limit,
  });

  return records.map((r) => ({
    id: r.id,
    source: r.source as RawSignal['source'],
    sourceUrl: r.sourceUrl,
    signalType: r.signalType as RawSignal['signalType'],
    title: r.title,
    content: r.content,
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
  }));
}

/**
 * Mark signals as processed.
 */
export async function markSignalsProcessed(signalIds: string[]): Promise<void> {
  await prisma.rawSignal.updateMany({
    where: { id: { in: signalIds } },
    data: { processed: true, processedAt: new Date() },
  });
}

/**
 * Save opportunities and link to source signals.
 */
export async function saveOpportunities(
  opportunities: Opportunity[]
): Promise<{ saved: number; skipped: number }> {
  let saved = 0;
  let skipped = 0;

  for (const opp of opportunities) {
    try {
      // Determine priority based on total score
      const priority = opp.total_score >= 40 ? 'critical' : opp.total_score >= 35 ? 'high' : opp.total_score >= 30 ? 'medium' : 'low';

      const created = await prisma.opportunity.create({
        data: {
          opportunityId: opp.opportunity_id,
          title: opp.title,
          problemStatement: opp.problem_statement,
          marketSize: opp.scores.market_size,
          urgency: opp.scores.urgency,
          feasibility: opp.scores.feasibility,
          monetization: opp.scores.monetization,
          competition: opp.scores.competition,
          totalScore: opp.total_score,
          suggestedPricing: opp.suggested_pricing,
          estimatedDevTime: opp.estimated_dev_time,
          competitorAnalysis: opp.competitor_analysis,
          recommendedFeatures: JSON.stringify(opp.recommended_features_mvp),
          priority,
        },
      });

      // Link to source signals if provided
      if (opp.source_signal_ids && opp.source_signal_ids.length > 0) {
        const validIds = await prisma.rawSignal.findMany({
          where: { id: { in: opp.source_signal_ids } },
          select: { id: true },
        });

        await prisma.opportunitySignal.createMany({
          data: validIds.map((s) => ({
            opportunityId: created.id,
            rawSignalId: s.id,
          })),
        });
      }

      saved++;
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('Unique constraint')) {
        logger.debug(`Opportunity ${opp.opportunity_id} already exists, skipping`);
        skipped++;
      } else {
        logger.warn(`Failed to save opportunity ${opp.opportunity_id}`, { error: msg });
        skipped++;
      }
    }
  }

  return { saved, skipped };
}

/**
 * Create a scan run record for observability.
 */
export async function createScanRun(source: string): Promise<string> {
  const run = await prisma.scanRun.create({
    data: { source, status: 'running' },
  });
  return run.id;
}

export async function completeScanRun(
  runId: string,
  data: { signalsScraped: number; opportunitiesFound: number; error?: string }
): Promise<void> {
  await prisma.scanRun.update({
    where: { id: runId },
    data: {
      completedAt: new Date(),
      status: data.error ? 'failed' : 'completed',
      signalsScraped: data.signalsScraped,
      opportunitiesFound: data.opportunitiesFound,
      errorMessage: data.error,
    },
  });
}

/**
 * List opportunities, sorted by score desc.
 */
export async function listOpportunities(filter: { status?: string; minScore?: number; limit?: number } = {}) {
  return prisma.opportunity.findMany({
    where: {
      status: filter.status,
      totalScore: filter.minScore ? { gte: filter.minScore } : undefined,
    },
    orderBy: [{ totalScore: 'desc' }, { detectedAt: 'desc' }],
    take: filter.limit ?? 50,
    include: {
      signals: {
        include: { rawSignal: { select: { source: true, sourceUrl: true, title: true } } },
      },
    },
  });
}

/**
 * Get a single opportunity with all signals.
 */
export async function getOpportunity(opportunityId: string) {
  return prisma.opportunity.findUnique({
    where: { opportunityId },
    include: {
      signals: {
        include: { rawSignal: true },
      },
    },
  });
}
