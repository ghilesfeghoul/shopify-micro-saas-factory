import pLimit from 'p-limit';
import { logger } from '../utils/logger';

/**
 * Bounded parallel pool for sub-agents.
 *
 * Why we limit concurrency:
 * - Claude Code Pro/Max quotas are limited per-time-window — running 10
 *   sub-agents in parallel would burn through them fast.
 * - Each sub-agent allocates a Claude Code subprocess, which is heavy
 *   (each loads CLAUDE.md, hooks, MCP servers).
 * - Tasks within a single dev run share filesystem state — too many
 *   concurrent writers risk race conditions in package.json or similar.
 *
 * Default: 3. Override via MAX_PARALLEL_SUBAGENTS env var.
 */

const DEFAULT_MAX_PARALLEL = 3;

export class ParallelPool {
  private limit: ReturnType<typeof pLimit>;

  constructor(maxConcurrency?: number) {
    const limit = maxConcurrency
      ?? parseInt(process.env.MAX_PARALLEL_SUBAGENTS || `${DEFAULT_MAX_PARALLEL}`, 10);

    if (limit < 1 || limit > 10) {
      logger.warn(`Invalid concurrency ${limit}, using default ${DEFAULT_MAX_PARALLEL}`);
      this.limit = pLimit(DEFAULT_MAX_PARALLEL);
    } else {
      this.limit = pLimit(limit);
    }

    logger.info(`ParallelPool initialized with concurrency=${limit}`);
  }

  /** Run a task respecting the concurrency limit. */
  run<T>(task: () => Promise<T>): Promise<T> {
    return this.limit(task);
  }

  /** Run an array of tasks in parallel (bounded by concurrency). */
  async runAll<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    return Promise.all(tasks.map((task) => this.limit(task)));
  }

  /** Run all tasks but return both successes and failures (settle). */
  async runAllSettled<T>(
    tasks: Array<() => Promise<T>>
  ): Promise<Array<PromiseSettledResult<T>>> {
    return Promise.allSettled(tasks.map((task) => this.limit(task)));
  }

  /** Number of tasks currently executing. */
  get activeCount(): number {
    return this.limit.activeCount;
  }

  /** Number of tasks waiting for a slot. */
  get pendingCount(): number {
    return this.limit.pendingCount;
  }
}
