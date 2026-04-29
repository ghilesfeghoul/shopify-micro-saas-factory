import { logger } from '../utils/logger';
import { getDetectorClient } from '../detector-client/client';
import {
  upsertOpportunityCache,
  getActiveSpecForOpportunity,
  createPollRun,
  completePollRun,
} from '../storage/repository';
import { orchestrate } from './orchestrator';

const AUTO_TRIGGER_THRESHOLD = parseInt(process.env.AUTO_TRIGGER_SCORE_THRESHOLD || '40', 10);
const POLL_LIMIT = parseInt(process.env.POLL_LIMIT || '50', 10);

export interface PollResult {
  fetched: number;
  newOpportunities: number;
  autoTriggered: number;
  errors: string[];
}

/**
 * Poll the detector for new high-score opportunities and auto-generate specs
 * for those above the threshold (default 40).
 *
 * - Score >= 40 + status="detected" → auto-generate
 * - Score < 40 → just cache, wait for manual trigger
 * - Already has active spec → skip
 */
export async function pollAndAutoTrigger(): Promise<PollResult> {
  const runId = await createPollRun();
  const result: PollResult = {
    fetched: 0,
    newOpportunities: 0,
    autoTriggered: 0,
    errors: [],
  };

  try {
    const client = getDetectorClient();

    logger.info(`Polling detector (threshold: ${AUTO_TRIGGER_THRESHOLD})...`);

    // Fetch all detected opportunities (we'll filter in-memory)
    const opportunities = await client.listOpportunities({
      status: 'detected',
      limit: POLL_LIMIT,
    });

    result.fetched = opportunities.length;
    logger.info(`Fetched ${opportunities.length} opportunities from detector`);

    for (const opp of opportunities) {
      try {
        // Sync to cache
        await upsertOpportunityCache(opp);

        // Skip if below threshold (cache only, no auto-trigger)
        if (opp.totalScore < AUTO_TRIGGER_THRESHOLD) {
          continue;
        }

        // Skip if already has an active spec
        const existing = await getActiveSpecForOpportunity(opp.opportunityId);
        if (existing) {
          continue;
        }

        // Trigger generation
        logger.info(`Auto-triggering spec for ${opp.opportunityId} (score: ${opp.totalScore})`);
        result.newOpportunities++;

        const orchResult = await orchestrate({
          opportunityId: opp.opportunityId,
          triggerMode: 'auto',
          triggeredBy: 'system',
          triggerSource: 'poller',
        });

        if (orchResult.status === 'created') {
          result.autoTriggered++;
        } else if (orchResult.status === 'failed') {
          result.errors.push(`${opp.opportunityId}: ${orchResult.reason}`);
        }
      } catch (error) {
        const msg = `${opp.opportunityId}: ${(error as Error).message}`;
        logger.error('Per-opportunity error during poll', { error: msg });
        result.errors.push(msg);
      }
    }

    await completePollRun(runId, {
      opportunitiesFetched: result.fetched,
      opportunitiesNew: result.newOpportunities,
      autoTriggered: result.autoTriggered,
    });

    logger.info(`Poll completed`, result);
    return result;
  } catch (error) {
    const msg = (error as Error).message;
    logger.error('Poll failed', { error: msg });
    await completePollRun(runId, {
      opportunitiesFetched: result.fetched,
      opportunitiesNew: result.newOpportunities,
      autoTriggered: result.autoTriggered,
      error: msg,
    });
    throw error;
  }
}
