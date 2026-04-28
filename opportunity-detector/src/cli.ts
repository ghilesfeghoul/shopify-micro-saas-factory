#!/usr/bin/env node
import 'dotenv/config';
import { runScan, type ScanSource } from './scoring/orchestrator';
import { listOpportunities, getOpportunity, prisma } from './storage/repository';
import { logger } from './utils/logger';

const command = process.argv[2];
const args = process.argv.slice(3);

function getArg(name: string, defaultValue?: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : defaultValue;
}

async function main(): Promise<void> {
  switch (command) {
    case 'scan': {
      const source = (getArg('source', 'all') ?? 'all') as ScanSource;
      const minScore = parseInt(getArg('min-score', '25')!, 10);
      const maxOpps = parseInt(getArg('max-opps', '15')!, 10);

      console.log(`\n🔍 Running scan: source=${source}, minScore=${minScore}, maxOpps=${maxOpps}\n`);

      const result = await runScan({
        source,
        minScore,
        maxOpportunities: maxOpps,
      });

      console.log('\n📊 Scan result:');
      console.log(`  Run ID: ${result.runId}`);
      console.log(`  Signals scraped: ${result.signalsScraped}`);
      console.log(`  Signals analyzed: ${result.signalsAnalyzed}`);
      console.log(`  Opportunities found: ${result.opportunitiesFound}`);
      console.log(`  Opportunities saved: ${result.opportunitiesSaved}`);
      console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s\n`);
      break;
    }

    case 'list': {
      const minScore = parseInt(getArg('min-score', '0')!, 10);
      const limit = parseInt(getArg('limit', '20')!, 10);
      const status = getArg('status');

      const opps = await listOpportunities({ minScore, limit, status });

      console.log(`\n📋 ${opps.length} opportunities found:\n`);
      console.log('─'.repeat(100));

      for (const opp of opps) {
        const priorityIcon = opp.priority === 'critical' ? '🔥' : opp.priority === 'high' ? '⭐' : opp.priority === 'medium' ? '·' : ' ';
        console.log(`${priorityIcon} [${opp.opportunityId}] ${opp.title}`);
        console.log(`   Score: ${opp.totalScore}/50  (M:${opp.marketSize} U:${opp.urgency} F:${opp.feasibility} $:${opp.monetization} C:${opp.competition})`);
        console.log(`   Status: ${opp.status} | Priority: ${opp.priority} | Pricing: ${opp.suggestedPricing}`);
        console.log(`   Detected: ${opp.detectedAt.toISOString()}`);
        console.log('');
      }
      console.log('─'.repeat(100));
      break;
    }

    case 'show': {
      const id = args[0];
      if (!id) {
        console.error('Usage: npm run show OPP-XXXX');
        process.exit(1);
      }

      const opp = await getOpportunity(id);
      if (!opp) {
        console.error(`Opportunity ${id} not found`);
        process.exit(1);
      }

      console.log(`\n${'═'.repeat(80)}`);
      console.log(`📌 ${opp.opportunityId} — ${opp.title}`);
      console.log('═'.repeat(80));
      console.log(`\n${opp.problemStatement}\n`);
      console.log('SCORES:');
      console.log(`  Market size:  ${opp.marketSize}/10`);
      console.log(`  Urgency:      ${opp.urgency}/10`);
      console.log(`  Feasibility:  ${opp.feasibility}/10`);
      console.log(`  Monetization: ${opp.monetization}/10`);
      console.log(`  Competition:  ${opp.competition}/10`);
      console.log(`  ─────────────────`);
      console.log(`  TOTAL:        ${opp.totalScore}/50  (priority: ${opp.priority})\n`);
      console.log(`PRICING:        ${opp.suggestedPricing}`);
      console.log(`DEV TIME:       ${opp.estimatedDevTime}`);
      console.log(`STATUS:         ${opp.status}\n`);
      console.log('COMPETITOR ANALYSIS:');
      console.log(`  ${opp.competitorAnalysis}\n`);
      console.log('MVP FEATURES:');
      const features = JSON.parse(opp.recommendedFeatures) as string[];
      features.forEach((f) => console.log(`  • ${f}`));
      console.log(`\nSOURCE SIGNALS (${opp.signals.length}):`);
      for (const sig of opp.signals) {
        console.log(`  - [${sig.rawSignal.source}] ${sig.rawSignal.title.substring(0, 80)}`);
        console.log(`    ${sig.rawSignal.sourceUrl}`);
      }
      console.log(`\n${'═'.repeat(80)}\n`);
      break;
    }

    case 'stats': {
      const total = await prisma.opportunity.count();
      const byStatus = await prisma.opportunity.groupBy({
        by: ['status'],
        _count: true,
      });
      const byPriority = await prisma.opportunity.groupBy({
        by: ['priority'],
        _count: true,
      });
      const totalSignals = await prisma.rawSignal.count();
      const recentRuns = await prisma.scanRun.findMany({ orderBy: { startedAt: 'desc' }, take: 5 });

      console.log('\n📊 STATS\n');
      console.log(`Total opportunities: ${total}`);
      console.log(`Total signals: ${totalSignals}\n`);
      console.log('By status:');
      byStatus.forEach((s) => console.log(`  ${s.status}: ${s._count}`));
      console.log('\nBy priority:');
      byPriority.forEach((p) => console.log(`  ${p.priority}: ${p._count}`));
      console.log('\nRecent scans:');
      recentRuns.forEach((r) => {
        const dur = r.completedAt ? `${((r.completedAt.getTime() - r.startedAt.getTime()) / 1000).toFixed(0)}s` : 'running';
        console.log(`  ${r.startedAt.toISOString()} | ${r.source} | ${r.status} | signals: ${r.signalsScraped}, opps: ${r.opportunitiesFound} | ${dur}`);
      });
      console.log('');
      break;
    }

    default:
      console.log(`
Opportunity Detector CLI

Usage:
  npm run scan [-- --source=appstore|reddit|community|producthunt|all] [--min-score=25] [--max-opps=15]
  npm run list [-- --min-score=30] [--limit=20] [--status=detected]
  npm run show OPP-XXXX
  
Or directly:
  tsx src/cli.ts scan
  tsx src/cli.ts list
  tsx src/cli.ts show OPP-XXXX
  tsx src/cli.ts stats
      `);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  logger.error('CLI error', { error: (error as Error).message, stack: (error as Error).stack });
  process.exit(1);
});
