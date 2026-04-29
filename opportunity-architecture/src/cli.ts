#!/usr/bin/env node
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { orchestrate } from './scoring/orchestrator';
import { pollAndAutoTrigger } from './scoring/poller';
import {
  prisma,
  listSpecs,
  getSpec,
  getStats,
  listRecentRuns,
  listRecentPolls,
  updateSpecStatus,
} from './storage/repository';
import { renderSpecAsMarkdown } from './architect/generators/markdown-renderer';
import type { TechnicalSpec } from './architect/schemas/spec-schema';
import { logger } from './utils/logger';
import type { SpecStatus } from './utils/types';

const command = process.argv[2];
const args = process.argv.slice(3);

function getArg(name: string, defaultValue?: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : defaultValue;
}

function getFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

async function main(): Promise<void> {
  switch (command) {
    case 'generate': {
      const opportunityId = args[0];
      if (!opportunityId) {
        console.error('Usage: npm run generate OPP-XXXX [--force] [--sync-status]');
        process.exit(1);
      }

      console.log(`\n🏗️  Generating spec for ${opportunityId}...\n`);

      const result = await orchestrate({
        opportunityId,
        triggerMode: 'manual',
        triggeredBy: 'cli',
        triggerSource: 'cli',
        forceRegenerate: getFlag('force'),
        syncDetectorStatus: getFlag('sync-status'),
      });

      if (result.status === 'created') {
        console.log(`✅ Spec created: ${result.specId}`);
        console.log(`   Duration: ${(result.durationMs! / 1000).toFixed(1)}s`);
        if (result.costUsd !== undefined) {
          console.log(`   Cost: $${result.costUsd.toFixed(4)}`);
        }
        console.log(`\n   View: npm run show ${result.specId}`);
      } else if (result.status === 'skipped') {
        console.log(`⏭️  Skipped: ${result.reason}`);
      } else {
        console.error(`❌ Failed: ${result.reason}`);
        process.exit(1);
      }
      break;
    }

    case 'list': {
      const status = getArg('status') as SpecStatus | undefined;
      const opportunityId = getArg('opportunity');
      const limit = parseInt(getArg('limit', '20')!, 10);
      const activeOnly = !getFlag('all');

      const specs = await listSpecs({
        status,
        opportunityId,
        isActive: activeOnly ? true : undefined,
        limit,
      });

      console.log(`\n📋 ${specs.length} specs found:\n`);
      console.log('─'.repeat(110));

      for (const spec of specs) {
        const statusIcon = spec.status === 'approved' ? '✅' : spec.status === 'rejected' ? '❌' : spec.status === 'reviewed' ? '👀' : '📝';
        console.log(`${statusIcon} [${spec.specId}] ${spec.appName}`);
        console.log(`   Opportunity: ${spec.opportunityId} (${spec.cache.title.substring(0, 60)})`);
        console.log(`   Score: ${spec.cache.totalScore}/50 (${spec.cache.priority}) | Hours: ${spec.estimatedHours}h | Complexity: ${spec.complexityScore}/10`);
        console.log(`   Status: ${spec.status} | Version: ${spec.version}${spec.isActive ? ' (active)' : ''} | Trigger: ${spec.triggerMode}`);
        console.log(`   Generated: ${spec.generatedAt.toISOString()}`);
        console.log('');
      }
      console.log('─'.repeat(110));
      break;
    }

    case 'show': {
      const specId = args[0];
      if (!specId) {
        console.error('Usage: npm run show SPEC-XXXX [--format=summary|markdown|json]');
        process.exit(1);
      }

      const spec = await getSpec(specId);
      if (!spec) {
        console.error(`Spec ${specId} not found`);
        process.exit(1);
      }

      const format = getArg('format', 'summary');
      const fullSpec = JSON.parse(spec.specJson) as TechnicalSpec;

      if (format === 'markdown') {
        console.log(renderSpecAsMarkdown(fullSpec));
      } else if (format === 'json') {
        console.log(JSON.stringify(fullSpec, null, 2));
      } else {
        // summary
        console.log(`\n${'═'.repeat(80)}`);
        console.log(`📌 ${spec.specId} — ${spec.appName}`);
        console.log('═'.repeat(80));
        console.log(`\n${fullSpec.overview.tagline}\n`);
        console.log('METADATA:');
        console.log(`  Opportunity:     ${spec.opportunityId} (score ${fullSpec.metadata.sourceOpportunityScore}/50)`);
        console.log(`  Schema version:  ${fullSpec.schemaVersion}`);
        console.log(`  Status:          ${spec.status} | Version ${spec.version}${spec.isActive ? ' (active)' : ''}`);
        console.log(`  Generated:       ${spec.generatedAt.toISOString()}`);
        console.log(`  Trigger:         ${spec.triggerMode} (${spec.triggeredBy ?? 'unknown'})`);
        console.log(`\nESTIMATION:`);
        console.log(`  Total hours:     ${spec.estimatedHours}h`);
        console.log(`  Complexity:      ${spec.complexityScore}/10`);
        console.log(`\nLLM:`);
        console.log(`  Backend:         ${spec.llmBackend}${spec.llmModel ? ` (${spec.llmModel})` : ''}`);
        if (spec.inputTokens) console.log(`  Tokens:          input=${spec.inputTokens}, output=${spec.outputTokens}`);
        if (spec.costUsd !== null) console.log(`  Cost:            $${spec.costUsd?.toFixed(4) ?? '0'}`);
        console.log(`  Duration:        ${(spec.durationMs / 1000).toFixed(1)}s`);

        console.log(`\nMVP SCOPE:`);
        for (const item of fullSpec.overview.mvpScope) console.log(`  • ${item}`);

        console.log(`\nSHOPIFY:`);
        console.log(`  API version:     ${fullSpec.shopify.apiVersion}`);
        console.log(`  Auth:            ${fullSpec.shopify.authMethod}`);
        console.log(`  Scopes:          ${fullSpec.shopify.requiredScopes.join(', ')}`);
        console.log(`  Webhooks:        ${fullSpec.shopify.webhooks.length} (${fullSpec.shopify.webhooks.filter((w) => w.category === 'gdpr').length} GDPR)`);

        console.log(`\nDATABASE:`);
        for (const t of fullSpec.database.tables) console.log(`  • ${t.name} (${t.fields.length} fields)`);

        console.log(`\nUI SCREENS:`);
        for (const s of fullSpec.ui.screens) console.log(`  • ${s.path} — ${s.name}`);

        console.log(`\nAPI ENDPOINTS:`);
        for (const e of fullSpec.apiEndpoints) console.log(`  • ${e.method} ${e.path}`);

        console.log(`\nRISKS:`);
        for (const r of fullSpec.estimation.risks) {
          const icon = r.severity === 'critical' ? '🔥' : r.severity === 'high' ? '⚠️' : r.severity === 'medium' ? '🟡' : '🟢';
          console.log(`  ${icon} [${r.severity}] ${r.description}`);
        }

        if (fullSpec.estimation.blockers?.length) {
          console.log(`\nBLOCKERS (need human review):`);
          for (const b of fullSpec.estimation.blockers) console.log(`  ⚠️  ${b}`);
        }

        console.log(`\nView full Markdown: npm run show ${spec.specId} -- --format=markdown`);
        console.log(`View JSON:          npm run show ${spec.specId} -- --format=json`);
        console.log(`\n${'═'.repeat(80)}\n`);
      }
      break;
    }

    case 'render': {
      const specId = args[0];
      const outputPath = getArg('output');
      if (!specId) {
        console.error('Usage: npm run render SPEC-XXXX [--output=path/to/file.md]');
        process.exit(1);
      }

      const spec = await getSpec(specId);
      if (!spec) {
        console.error(`Spec ${specId} not found`);
        process.exit(1);
      }

      const fullSpec = JSON.parse(spec.specJson) as TechnicalSpec;
      const markdown = renderSpecAsMarkdown(fullSpec);

      if (outputPath) {
        writeFileSync(outputPath, markdown);
        console.log(`✅ Markdown written to ${outputPath}`);
      } else {
        console.log(markdown);
      }
      break;
    }

    case 'status': {
      const specId = args[0];
      const newStatus = args[1] as SpecStatus | undefined;
      const reason = getArg('reason');

      if (!specId || !newStatus) {
        console.error('Usage: tsx src/cli.ts status SPEC-XXXX <draft|reviewed|approved|building|rejected|archived> [--reason="..."]');
        process.exit(1);
      }

      const updated = await updateSpecStatus(specId, newStatus, { rejectionReason: reason });
      console.log(`✅ ${specId} status: ${updated.status}`);
      break;
    }

    case 'poll': {
      console.log('\n🔄 Polling detector for new high-score opportunities...\n');
      const result = await pollAndAutoTrigger();
      console.log('\nResult:');
      console.log(`  Fetched: ${result.fetched}`);
      console.log(`  New (above threshold): ${result.newOpportunities}`);
      console.log(`  Auto-triggered specs: ${result.autoTriggered}`);
      if (result.errors.length > 0) {
        console.log(`  Errors: ${result.errors.length}`);
        for (const err of result.errors) console.log(`    - ${err}`);
      }
      console.log('');
      break;
    }

    case 'stats': {
      const stats = await getStats();
      const recentRuns = await listRecentRuns(5);
      const recentPolls = await listRecentPolls(5);

      console.log('\n📊 STATS\n');
      console.log(`Total specs:               ${stats.totalSpecs}`);
      console.log(`Active specs:              ${stats.activeSpecs}`);
      console.log(`Cached opportunities:      ${stats.cachedOpportunities}`);
      console.log(`Opportunities with spec:   ${stats.opportunitiesWithSpec}`);
      console.log(`Total LLM cost:            $${stats.totalCostUsd.toFixed(4)}\n`);
      console.log('By status:');
      for (const s of stats.byStatus) console.log(`  ${s.status}: ${s._count}`);

      console.log('\nRecent generations:');
      for (const r of recentRuns) {
        const dur = r.completedAt ? `${((r.completedAt.getTime() - r.startedAt.getTime()) / 1000).toFixed(0)}s` : 'running';
        console.log(`  ${r.startedAt.toISOString()} | ${r.opportunityId} | ${r.status} | ${r.triggerMode} | ${dur}`);
      }

      console.log('\nRecent polls:');
      for (const p of recentPolls) {
        const dur = p.completedAt ? `${((p.completedAt.getTime() - p.startedAt.getTime()) / 1000).toFixed(0)}s` : 'running';
        console.log(`  ${p.startedAt.toISOString()} | fetched=${p.opportunitiesFetched}, new=${p.opportunitiesNew}, triggered=${p.autoTriggered} | ${p.status} | ${dur}`);
      }
      console.log('');
      break;
    }

    default:
      console.log(`
Opportunity Architecture CLI

Usage:
  npm run generate OPP-XXXX [-- --force] [--sync-status]
      Generate a spec for an opportunity (manual mode)

  npm run list [-- --status=draft] [--limit=20] [--all]
      List specs (active only by default)

  npm run show SPEC-XXXX [-- --format=summary|markdown|json]
      Show spec details (default: summary)

  npm run render SPEC-XXXX [-- --output=path/file.md]
      Render Markdown to stdout or file

  npm run poll
      Poll detector and auto-trigger specs for score >= 40

  npm run stats
      Global statistics

  tsx src/cli.ts status SPEC-XXXX <new-status> [--reason="..."]
      Update spec lifecycle (draft|reviewed|approved|building|rejected|archived)
      `);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  logger.error('CLI error', { error: (error as Error).message, stack: (error as Error).stack });
  process.exit(1);
});
