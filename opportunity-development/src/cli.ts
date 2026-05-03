#!/usr/bin/env node
import 'dotenv/config';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getArchitectClient } from './architect-client/client';
import { orchestrate, type ProgressEvent } from './orchestrator/orchestrator';
import { generateAppId } from './utils/id-generator';
import { WorkspaceManager } from './workspace/manager';
import { validateWorkspace, summarizeValidation } from './validation/runner';
import {
  prisma,
  createGenerationRun,
  updateRunStatus,
  recordChunks,
  recordChunkResult,
  getRun,
  listRuns,
  getStats,
} from './storage/repository';
import { logger } from './utils/logger';
import type { GenerationStatus, TriggerMode } from './utils/types';

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
    case 'generate':
      await runGenerate();
      break;
    case 'list':
      await runList();
      break;
    case 'show':
      await runShow();
      break;
    case 'retry':
      await runRetry();
      break;
    case 'validate':
      await runValidate();
      break;
    case 'stats':
      await runStats();
      break;
    default:
      printHelp();
  }

  await prisma.$disconnect();
}

// ─── generate ────────────────────────────────────────────────────

async function runGenerate(): Promise<void> {
  const specId = args[0];
  if (!specId || !/^SPEC-[A-Z0-9]{4}$/.test(specId)) {
    console.error('Usage: npm run generate SPEC-XXXX [-- --force] [--skip-validation]');
    process.exit(1);
  }

  console.log(`\n🛠️  Starting generation for ${specId}...\n`);

  // 1. Fetch spec from architect
  const architect = getArchitectClient();
  const fetched = await architect.getSpec(specId);
  if (!fetched) {
    console.error(`❌ Spec ${specId} not found in architect`);
    process.exit(1);
  }
  const { spec } = fetched;

  // 2. Get markdown rendering for SPEC.md
  let specMarkdown = '';
  try {
    const path = `/specs/${specId}`;
    const headers = (await import('./auth/hmac')).generateSignature(
      process.env.ARCHITECT_HMAC_SECRET!, 'GET', path, ''
    );
    const axios = (await import('axios')).default;
    const { data } = await axios.get(
      `${process.env.ARCHITECT_URL}${path}?format=markdown`,
      { headers }
    );
    specMarkdown = data;
  } catch (err) {
    logger.warn('Could not fetch markdown rendering — using JSON', {
      error: (err as Error).message,
    });
  }

  // 3. Create DB run
  const appId = generateAppId();
  const workspace = new WorkspaceManager();
  const workspacePath = workspace.pathFor(specId);
  const triggerMode: TriggerMode = 'manual';

  const runId = await createGenerationRun({
    appId,
    specId,
    opportunityId: spec.opportunityId,
    workspacePath,
    triggerMode,
    triggeredBy: 'cli',
  });

  await updateRunStatus(runId, 'planning');

  console.log(`📂 Workspace: ${workspacePath}`);
  console.log(`🆔 App ID:    ${appId}`);
  console.log(`📋 Run ID:    ${runId}\n`);

  // 4. Orchestrate
  let chunkCount = 0;
  let successfulChunks = 0;
  let failedChunks = 0;

  const onProgress = (event: ProgressEvent): void => {
    switch (event.type) {
      case 'plan_ready':
        chunkCount = event.chunkCount;
        console.log(`📐 Plan ready: ${event.chunkCount} chunks\n`);
        break;
      case 'chunk_started':
        console.log(`▶️  [${event.chunkId}] ${event.role.padEnd(10)} ${event.title}`);
        break;
      case 'chunk_completed': {
        const icon = event.result.status === 'completed' ? '✅' :
                     event.result.status === 'timeout' ? '⏱️ ' : '❌';
        const cost = event.result.costUsd !== undefined
          ? ` ($${event.result.costUsd.toFixed(3)})`
          : '';
        console.log(`${icon} [${event.chunkId}] ${event.result.status} in ${(event.result.durationMs / 1000).toFixed(0)}s${cost}`);
        if (event.result.errorMessage) {
          console.log(`   ⚠️  ${event.result.errorMessage.slice(0, 150)}`);
        }
        if (event.result.status === 'completed') successfulChunks++;
        else failedChunks++;
        recordChunkResult(runId, event.result).catch(() => {});
        break;
      }
      case 'phase_changed':
        console.log(`\n━━━ Phase: ${event.phase.toUpperCase()} ━━━\n`);
        break;
      case 'validation_result':
        if (event.passed) {
          console.log(`\n✅ Validation passed`);
        } else {
          console.log(`\n❌ Validation failed: ${event.failedSteps.join(', ')}`);
        }
        break;
      case 'repair_attempt':
        console.log(`\n🔧 Repair attempt ${event.attempt} (${event.remaining} remaining)\n`);
        break;
    }
  };

  try {
    const result = await orchestrate({
      spec,
      specMarkdown,
      triggerMode,
      triggeredBy: 'cli',
      force: getFlag('force'),
      skipValidation: getFlag('skip-validation'),
      onProgress,
    });

    // Record chunks if not already recorded
    try {
      const planJson = require(join(workspacePath, 'GENERATION_PLAN.json'));
      if (planJson.chunks) {
        await recordChunks(runId, planJson.chunks).catch(() => {});
      }
    } catch {
      /* ignore */
    }

    await updateRunStatus(runId, result.status as GenerationStatus, {
      totalChunks: result.totalChunks,
      successfulChunks: result.successfulChunks,
      failedChunks: result.failedChunks,
      validationPassed: result.validationPassed,
      complianceReportMd: result.complianceReport,
      compliancePassed: result.complianceReport.includes('0 failed'),
      repairAttempts: result.repairAttempts,
      totalCostUsd: result.totalCostUsd,
      totalDurationMs: result.totalDurationMs,
      hasGitRepo: true,
      ...(result.errorReport && { errorMessage: result.errorReport }),
    });

    // Update architect's spec status
    if (result.status === 'completed') {
      try {
        await architect.updateSpecStatus(specId, 'building');
      } catch {
        /* non-fatal */
      }
    }

    // Summary
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Status:        ${statusIcon(result.status)} ${result.status}`);
    console.log(`App ID:        ${appId}`);
    console.log(`Workspace:     ${result.workspacePath}`);
    console.log(`Chunks:        ${result.successfulChunks}/${result.totalChunks} successful`);
    console.log(`Duration:      ${(result.totalDurationMs / 1000 / 60).toFixed(1)} min`);
    if (result.totalCostUsd > 0) {
      console.log(`Cost:          $${result.totalCostUsd.toFixed(3)}`);
    }
    console.log(`Repair runs:   ${result.repairAttempts}`);
    if (result.errorReport) {
      console.log(`\n⚠️  Issues: ${result.errorReport.slice(0, 200)}`);
    }
    console.log('\nNext steps:');
    console.log(`  cd ${result.workspacePath}`);
    console.log(`  npm run dev`);
    console.log(`  cat README.md`);
    console.log('');
  } catch (error) {
    await updateRunStatus(runId, 'failed', {
      errorMessage: (error as Error).message,
    });
    console.error(`\n❌ Generation failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

// ─── list ────────────────────────────────────────────────────────

async function runList(): Promise<void> {
  const status = getArg('status') as GenerationStatus | undefined;
  const limit = parseInt(getArg('limit', '20')!, 10);

  const runs = await listRuns({ status, limit });

  console.log(`\n📋 ${runs.length} runs:\n`);
  console.log('─'.repeat(120));

  for (const r of runs) {
    console.log(`${statusIcon(r.status as GenerationStatus)} [${r.appId}] ${r.specId} (${r.opportunityId})`);
    console.log(`   Status: ${r.status} | Chunks: ${r.successfulChunks}/${r.totalChunks} | Repair: ${r.repairAttempts}`);
    console.log(`   Started: ${r.startedAt.toISOString()}${r.completedAt ? ` | Completed: ${r.completedAt.toISOString()}` : ' (running)'}`);
    if (r.totalCostUsd) console.log(`   Cost: $${r.totalCostUsd.toFixed(3)} | Duration: ${((r.totalDurationMs ?? 0) / 1000 / 60).toFixed(1)} min`);
    if (r.errorMessage) console.log(`   ⚠️  ${r.errorMessage.slice(0, 100)}`);
    console.log('');
  }
  console.log('─'.repeat(120));
}

// ─── show ────────────────────────────────────────────────────────

async function runShow(): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: npm run show APP-XXXX | <runId>');
    process.exit(1);
  }

  const run = await getRun(id);
  if (!run) {
    console.error(`Run not found: ${id}`);
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`📌 ${run.appId} — Generation Run`);
  console.log('═'.repeat(80));
  console.log(`\nMETADATA:`);
  console.log(`  Internal ID:     ${run.id}`);
  console.log(`  Spec ID:         ${run.specId}`);
  console.log(`  Opportunity:     ${run.opportunityId}`);
  console.log(`  Status:          ${statusIcon(run.status as GenerationStatus)} ${run.status}`);
  console.log(`  Trigger:         ${run.triggerMode} (${run.triggeredBy ?? 'unknown'})`);
  console.log(`  Started:         ${run.startedAt.toISOString()}`);
  if (run.completedAt) console.log(`  Completed:       ${run.completedAt.toISOString()}`);

  console.log(`\nWORKSPACE:`);
  console.log(`  Path:            ${run.workspacePath}`);
  console.log(`  Git initialized: ${run.hasGitRepo ? 'yes' : 'no'}`);
  console.log(`  Exists on disk:  ${existsSync(run.workspacePath) ? 'yes' : 'no'}`);

  console.log(`\nEXECUTION:`);
  console.log(`  Total chunks:    ${run.totalChunks}`);
  console.log(`  Successful:      ${run.successfulChunks}`);
  console.log(`  Failed:          ${run.failedChunks}`);
  console.log(`  Repair attempts: ${run.repairAttempts}/${run.maxRepairAttempts}`);

  console.log(`\nVALIDATION:`);
  console.log(`  Tests passed:    ${run.validationPassed ? '✅' : '❌'}`);
  console.log(`  Compliance:      ${run.compliancePassed ? '✅' : '❌'}`);
  if (run.validationFailures) {
    try {
      const failures = JSON.parse(run.validationFailures);
      if (failures.length > 0) console.log(`  Failed steps:    ${failures.join(', ')}`);
    } catch { /* ignore */ }
  }

  if (run.totalCostUsd !== null && run.totalCostUsd !== undefined) {
    console.log(`\nLLM TELEMETRY:`);
    console.log(`  Total cost:      $${run.totalCostUsd.toFixed(4)}`);
    console.log(`  Duration:        ${((run.totalDurationMs ?? 0) / 1000 / 60).toFixed(2)} min`);
  }

  if (run.errorMessage) {
    console.log(`\n⚠️  ERROR:`);
    console.log(`  ${run.errorMessage}`);
  }

  if (run.chunks.length > 0) {
    console.log(`\nCHUNKS (${run.chunks.length}):`);
    for (const chunk of run.chunks) {
      const icon = chunk.status === 'completed' ? '✅' :
                   chunk.status === 'failed' ? '❌' :
                   chunk.status === 'timeout' ? '⏱️' : '⏸️';
      const dur = chunk.durationMs ? ` (${(chunk.durationMs / 1000).toFixed(0)}s)` : '';
      const cost = chunk.costUsd ? ` $${chunk.costUsd.toFixed(3)}` : '';
      console.log(`  ${icon} [${chunk.chunkId}] ${chunk.role.padEnd(10)} ${chunk.title}${dur}${cost}`);
      if (chunk.errorMessage) console.log(`     ⚠️  ${chunk.errorMessage.slice(0, 100)}`);
    }
  }

  console.log(`\n${'═'.repeat(80)}\n`);
}

// ─── retry ───────────────────────────────────────────────────────

async function runRetry(): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: npm run retry APP-XXXX');
    process.exit(1);
  }

  const run = await getRun(id);
  if (!run) {
    console.error(`Run not found: ${id}`);
    process.exit(1);
  }

  console.log(`\n🔁 Retrying generation for ${run.specId} (previous app ${run.appId})...\n`);

  // Re-trigger generate with --force
  process.argv = [
    process.argv[0]!, process.argv[1]!,
    'generate', run.specId, '--force',
  ];
  await runGenerate();
}

// ─── validate ────────────────────────────────────────────────────

async function runValidate(): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: npm run validate APP-XXXX');
    process.exit(1);
  }

  const run = await getRun(id);
  if (!run) {
    console.error(`Run not found: ${id}`);
    process.exit(1);
  }

  if (!existsSync(run.workspacePath)) {
    console.error(`Workspace no longer exists: ${run.workspacePath}`);
    process.exit(1);
  }

  console.log(`\n🔍 Validating workspace ${run.workspacePath}...\n`);

  const results = await validateWorkspace(run.workspacePath);
  const summary = summarizeValidation(results);

  for (const r of results) {
    const icon = r.status === 'passed' ? '✅' : r.status === 'failed' ? '❌' : '⏭️ ';
    console.log(`${icon} ${r.step.padEnd(20)} ${r.status} (${(r.durationMs / 1000).toFixed(1)}s)`);
    if (r.status === 'failed' && r.errorOutput) {
      console.log(`   ${r.errorOutput.slice(0, 200)}`);
    }
  }

  console.log(`\nOverall: ${summary.overallStatus}`);
  if (summary.failedRequired.length > 0) {
    console.log(`Failed (required): ${summary.failedRequired.join(', ')}`);
  }
  if (summary.failedOptional.length > 0) {
    console.log(`Failed (optional): ${summary.failedOptional.join(', ')}`);
  }
  console.log('');
}

// ─── stats ───────────────────────────────────────────────────────

async function runStats(): Promise<void> {
  const stats = await getStats();
  console.log('\n📊 STATS\n');
  console.log(`Total runs:         ${stats.totalRuns}`);
  console.log(`Total LLM cost:     $${stats.totalCostUsd.toFixed(4)}`);
  console.log(`Avg duration:       ${(stats.avgDurationMs / 1000 / 60).toFixed(2)} min`);
  console.log('\nBy status:');
  for (const s of stats.byStatus) {
    console.log(`  ${statusIcon(s.status as GenerationStatus)} ${s.status.padEnd(20)} ${s._count}`);
  }
  console.log('');
}

// ─── helpers ─────────────────────────────────────────────────────

function statusIcon(status: GenerationStatus): string {
  switch (status) {
    case 'completed': return '✅';
    case 'failed': return '❌';
    case 'needs_human_review': return '⚠️ ';
    case 'pending': return '⏸️';
    case 'planning':
    case 'generating':
    case 'integrating':
    case 'validating':
    case 'repairing':
      return '🔄';
    default: return '•';
  }
}

function printHelp(): void {
  console.log(`
Opportunity Development CLI

Usage:
  npm run generate SPEC-XXXX [-- --force] [--skip-validation]
      Generate a Shopify app from an architect spec

  npm run list [-- --status=completed] [--limit=20]
      List generation runs

  npm run show APP-XXXX | <runId>
      Show run details and chunk breakdown

  npm run retry APP-XXXX
      Retry a previous generation (force-overwrites workspace)

  npm run validate APP-XXXX
      Re-run validation on an existing workspace

  npm run stats
      Global statistics
  `);
}

main().catch((error) => {
  logger.error('CLI error', { error: (error as Error).message, stack: (error as Error).stack });
  process.exit(1);
});
