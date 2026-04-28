import { logger } from '../utils/logger';
import { scrapeShopifyAppStore } from '../scrapers/shopify-appstore';
import { scrapeReddit } from '../scrapers/reddit';
import { scrapeShopifyCommunity } from '../scrapers/shopify-community';
import { scrapeProductHunt } from '../scrapers/producthunt';
import { analyzeSignals } from '../scoring/analyzer';
import {
  saveSignals,
  getUnprocessedSignals,
  markSignalsProcessed,
  saveOpportunities,
  createScanRun,
  completeScanRun,
} from '../storage/repository';
import type { RawSignal } from '../utils/types';

export type ScanSource = 'all' | 'appstore' | 'reddit' | 'community' | 'producthunt';

export interface ScanOptions {
  source?: ScanSource;
  maxSignals?: number;
  maxOpportunities?: number;
  minScore?: number;
  skipAnalysis?: boolean;
}

export interface ScanResult {
  runId: string;
  signalsScraped: number;
  signalsAnalyzed: number;
  opportunitiesFound: number;
  opportunitiesSaved: number;
  durationMs: number;
}

/**
 * Run a complete scan : scrape → save → analyze → store opportunities.
 */
export async function runScan(options: ScanOptions = {}): Promise<ScanResult> {
  const source = options.source ?? 'all';
  const maxSignals = options.maxSignals ?? parseInt(process.env.MAX_SIGNALS_PER_SCAN || '200', 10);
  const maxOpportunities = options.maxOpportunities ?? parseInt(process.env.MAX_OPPORTUNITIES_PER_SCAN || '15', 10);
  const minScore = options.minScore ?? parseInt(process.env.MIN_SCORE_THRESHOLD || '25', 10);

  const startTime = Date.now();
  const runId = await createScanRun(source);

  logger.info(`🚀 Starting scan run ${runId}`, { source, maxSignals, maxOpportunities, minScore });

  try {
    // ─── Phase 1: Scrape ──────────────────────────────────────────
    const allSignals: RawSignal[] = [];

    const tasks: Array<Promise<RawSignal[]>> = [];

    if (source === 'all' || source === 'appstore') {
      tasks.push(
        scrapeShopifyAppStore(100, 250).catch((e) => {
          logger.error('App Store scraper failed', { error: (e as Error).message });
          return [] as RawSignal[];
        })
      );
    }
    if (source === 'all' || source === 'reddit') {
      tasks.push(
        scrapeReddit().catch((e) => {
          logger.error('Reddit scraper failed', { error: (e as Error).message });
          return [] as RawSignal[];
        })
      );
    }
    if (source === 'all' || source === 'community') {
      tasks.push(
        scrapeShopifyCommunity().catch((e) => {
          logger.error('Community scraper failed', { error: (e as Error).message });
          return [] as RawSignal[];
        })
      );
    }
    if (source === 'all' || source === 'producthunt') {
      tasks.push(
        scrapeProductHunt(20).catch((e) => {
          logger.error('Product Hunt scraper failed', { error: (e as Error).message });
          return [] as RawSignal[];
        })
      );
    }

    const results = await Promise.all(tasks);
    for (const r of results) allSignals.push(...r);

    logger.info(`📥 Scraped ${allSignals.length} signals total`);

    // ─── Phase 2: Save signals ────────────────────────────────────
    const { signals: savedSignals } = await saveSignals(allSignals);

    if (options.skipAnalysis) {
      const result: ScanResult = {
        runId,
        signalsScraped: allSignals.length,
        signalsAnalyzed: 0,
        opportunitiesFound: 0,
        opportunitiesSaved: 0,
        durationMs: Date.now() - startTime,
      };
      await completeScanRun(runId, { signalsScraped: result.signalsScraped, opportunitiesFound: 0 });
      return result;
    }

    // ─── Phase 3: Analyze with Claude ─────────────────────────────
    const unprocessed = await getUnprocessedSignals(maxSignals);
    logger.info(`🧠 Analyzing ${unprocessed.length} unprocessed signals with Claude...`);

    const opportunities = await analyzeSignals(unprocessed, { maxOpportunities, minScore });

    // ─── Phase 4: Save opportunities ──────────────────────────────
    const { saved, skipped } = await saveOpportunities(opportunities);
    logger.info(`💾 Saved ${saved} new opportunities (${skipped} duplicates skipped)`);

    // Mark signals as processed
    await markSignalsProcessed(unprocessed.map((s) => s.id));

    // ─── Done ──────────────────────────────────────────────────────
    const durationMs = Date.now() - startTime;
    const result: ScanResult = {
      runId,
      signalsScraped: allSignals.length,
      signalsAnalyzed: unprocessed.length,
      opportunitiesFound: opportunities.length,
      opportunitiesSaved: saved,
      durationMs,
    };

    await completeScanRun(runId, {
      signalsScraped: result.signalsScraped,
      opportunitiesFound: result.opportunitiesSaved,
    });

    logger.info(`✅ Scan completed in ${(durationMs / 1000).toFixed(1)}s`, result);
    return result;
  } catch (error) {
    const msg = (error as Error).message;
    logger.error(`❌ Scan failed`, { error: msg });
    await completeScanRun(runId, {
      signalsScraped: 0,
      opportunitiesFound: 0,
      error: msg,
    });
    throw error;
  }
}
