import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger';

export interface ValidationStep {
  name: string;
  command: string;
  required: boolean;
  /** Optional: skip if a file/dir doesn't exist */
  requiresPath?: string;
}

export interface ValidationResult {
  step: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  output: string;
  errorOutput?: string;
}

const DEFAULT_STEPS: ValidationStep[] = [
  { name: 'npm install', command: 'npm install --silent --no-audit --no-fund', required: true, requiresPath: 'package.json' },
  { name: 'prisma generate', command: 'npx prisma generate', required: false, requiresPath: 'prisma/schema.prisma' },
  { name: 'typecheck', command: 'npx tsc --noEmit', required: true, requiresPath: 'tsconfig.json' },
  { name: 'lint', command: 'npm run lint --if-present', required: false, requiresPath: 'package.json' },
  { name: 'build', command: 'npm run build --if-present', required: false, requiresPath: 'package.json' },
  { name: 'test', command: 'npm test --if-present -- --passWithNoTests', required: false, requiresPath: 'package.json' },
];

/**
 * Run validation in a workspace.
 * Returns one result per step that ran.
 */
export async function validateWorkspace(
  workspacePath: string,
  options: { skipNpmInstall?: boolean; timeoutMs?: number } = {}
): Promise<ValidationResult[]> {
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace does not exist: ${workspacePath}`);
  }

  const stepTimeout = options.timeoutMs ?? 5 * 60 * 1000;
  const results: ValidationResult[] = [];

  for (const step of DEFAULT_STEPS) {
    if (options.skipNpmInstall && step.name === 'npm install') {
      results.push({
        step: step.name,
        status: 'skipped',
        durationMs: 0,
        output: 'Skipped (skipNpmInstall=true)',
      });
      continue;
    }

    if (step.requiresPath && !existsSync(join(workspacePath, step.requiresPath))) {
      results.push({
        step: step.name,
        status: 'skipped',
        durationMs: 0,
        output: `Skipped (${step.requiresPath} not found)`,
      });
      continue;
    }

    const startTime = Date.now();
    logger.info(`Running validation step: ${step.name}`, { workspace: workspacePath });

    try {
      const output = execSync(step.command, {
        cwd: workspacePath,
        timeout: stepTimeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      results.push({
        step: step.name,
        status: 'passed',
        durationMs: Date.now() - startTime,
        output: output.toString().slice(0, 5000),
      });
    } catch (error) {
      const err = error as { stdout?: Buffer; stderr?: Buffer; message: string };
      const stdoutStr = err.stdout ? err.stdout.toString() : '';
      const stderrStr = err.stderr ? err.stderr.toString() : '';
      results.push({
        step: step.name,
        status: 'failed',
        durationMs: Date.now() - startTime,
        output: stdoutStr.slice(0, 5000),
        errorOutput: (stderrStr || err.message).slice(0, 5000),
      });

      if (step.required) {
        logger.warn(`Required validation step failed: ${step.name}`);
      }
    }
  }

  return results;
}

/**
 * Summarize validation results into a single status.
 */
export function summarizeValidation(results: ValidationResult[]): {
  overallStatus: 'passed' | 'partial' | 'failed';
  failedRequired: string[];
  failedOptional: string[];
  errorReport: string;
} {
  const requiredSteps = new Set(['npm install', 'typecheck']);
  const failedRequired: string[] = [];
  const failedOptional: string[] = [];
  const errorParts: string[] = [];

  for (const result of results) {
    if (result.status === 'failed') {
      if (requiredSteps.has(result.step)) {
        failedRequired.push(result.step);
      } else {
        failedOptional.push(result.step);
      }
      errorParts.push(`### ${result.step}\n${result.errorOutput || result.output}`);
    }
  }

  const overallStatus =
    failedRequired.length > 0 ? 'failed' :
    failedOptional.length > 0 ? 'partial' :
    'passed';

  return {
    overallStatus,
    failedRequired,
    failedOptional,
    errorReport: errorParts.join('\n\n').slice(0, 10_000),
  };
}
