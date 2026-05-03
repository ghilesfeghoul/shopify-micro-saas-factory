import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { logger } from '../utils/logger';

/**
 * Manages the /apps/SPEC-XXXX/ workspaces where generated Shopify apps live.
 *
 * Layout:
 *   apps/
 *     SPEC-X7Y2/          ← one per spec (also a Git repo)
 *       .git/
 *       package.json
 *       src/...
 *       tests/...
 *       README.md
 *       SPEC.md           ← the original markdown spec, committed for traceability
 */

export interface WorkspaceInfo {
  specId: string;
  rootPath: string;
  exists: boolean;
  isEmpty: boolean;
  hasGit: boolean;
}

export class WorkspaceManager {
  private appsRoot: string;

  constructor(appsRoot?: string) {
    this.appsRoot = appsRoot
      || process.env.APPS_ROOT
      || resolve(process.cwd(), 'apps');

    if (!existsSync(this.appsRoot)) {
      mkdirSync(this.appsRoot, { recursive: true });
      logger.info(`Created apps root directory: ${this.appsRoot}`);
    }
  }

  /**
   * Get info about a workspace without creating it.
   */
  inspect(specId: string): WorkspaceInfo {
    const rootPath = this.pathFor(specId);
    const exists = existsSync(rootPath);
    let isEmpty = true;
    let hasGit = false;

    if (exists) {
      try {
        const entries = readdirSync(rootPath);
        isEmpty = entries.length === 0;
        hasGit = entries.includes('.git');
      } catch {
        /* permissions issue, treat as not empty */
        isEmpty = false;
      }
    }

    return { specId, rootPath, exists, isEmpty, hasGit };
  }

  /**
   * Get the absolute path for a given spec ID, regardless of existence.
   */
  pathFor(specId: string): string {
    if (!/^SPEC-[A-Z0-9]{4}$/.test(specId)) {
      throw new Error(`Invalid specId format: ${specId}`);
    }
    return join(this.appsRoot, specId);
  }

  /**
   * Ensure a fresh workspace exists. Throws if the directory exists and is non-empty
   * (unless `force=true`, which wipes it first).
   */
  create(specId: string, options: { force?: boolean } = {}): string {
    const rootPath = this.pathFor(specId);
    const info = this.inspect(specId);

    if (info.exists && !info.isEmpty) {
      if (!options.force) {
        throw new Error(
          `Workspace ${rootPath} already exists and is non-empty. Use force=true to wipe.`
        );
      }
      logger.warn(`Wiping existing workspace ${rootPath}`);
      rmSync(rootPath, { recursive: true, force: true });
    }

    mkdirSync(rootPath, { recursive: true });
    logger.info(`Created workspace: ${rootPath}`);
    return rootPath;
  }

  /**
   * Initialize a git repo in the workspace and make the first empty commit.
   * This gives sub-agents a clean repo to commit into incrementally.
   */
  initGit(specId: string, opts: { authorName?: string; authorEmail?: string } = {}): void {
    const rootPath = this.pathFor(specId);
    if (!existsSync(rootPath)) {
      throw new Error(`Workspace ${rootPath} does not exist`);
    }

    const authorName = opts.authorName || process.env.GIT_AUTHOR_NAME || 'MSF Dev Agent';
    const authorEmail = opts.authorEmail || process.env.GIT_AUTHOR_EMAIL || 'dev@micro-saas-factory.local';

    try {
      execSync('git init -q', { cwd: rootPath });
      execSync(`git config user.name "${authorName}"`, { cwd: rootPath });
      execSync(`git config user.email "${authorEmail}"`, { cwd: rootPath });

      // Create a baseline .gitignore so node_modules etc. are excluded from
      // the very first commit.
      writeFileSync(
        join(rootPath, '.gitignore'),
        ['node_modules/', 'dist/', '.env', '.env.local', '*.log', '.DS_Store', ''].join('\n')
      );

      execSync('git add .gitignore', { cwd: rootPath });
      execSync(
        `git -c commit.gpgsign=false commit -q -m "chore: initialize workspace"`,
        { cwd: rootPath }
      );

      logger.info(`Git initialized: ${rootPath}`);
    } catch (error) {
      throw new Error(`Git init failed: ${(error as Error).message}`);
    }
  }

  /**
   * Make a commit on the workspace's repo. Used after each major sub-agent completes.
   */
  commit(specId: string, message: string): void {
    const rootPath = this.pathFor(specId);
    try {
      execSync('git add -A', { cwd: rootPath });
      // Skip if nothing staged
      try {
        execSync('git diff --cached --quiet --exit-code', { cwd: rootPath });
        logger.debug(`Nothing to commit in ${specId}`);
        return;
      } catch {
        // diff exited non-zero → there are staged changes
      }
      execSync(
        `git -c commit.gpgsign=false commit -q -m ${JSON.stringify(message)}`,
        { cwd: rootPath }
      );
      logger.info(`Committed in ${specId}: ${message}`);
    } catch (error) {
      logger.warn(`Commit failed (non-fatal): ${(error as Error).message}`);
    }
  }

  /**
   * Write the spec markdown into the workspace for traceability.
   */
  writeSpecMarkdown(specId: string, markdown: string): string {
    const rootPath = this.pathFor(specId);
    const specPath = join(rootPath, 'SPEC.md');
    writeFileSync(specPath, markdown, 'utf-8');
    return specPath;
  }

  /**
   * Verify expected files exist after a sub-agent run.
   * Returns a list of missing paths (empty if everything is present).
   */
  verifyOutputs(specId: string, expectedRelativePaths: string[]): string[] {
    const rootPath = this.pathFor(specId);
    const missing: string[] = [];
    for (const rel of expectedRelativePaths) {
      const full = join(rootPath, rel);
      if (!existsSync(full)) missing.push(rel);
    }
    return missing;
  }

  /**
   * List all spec IDs present under apps/.
   */
  listAll(): string[] {
    if (!existsSync(this.appsRoot)) return [];
    return readdirSync(this.appsRoot)
      .filter((entry) => /^SPEC-[A-Z0-9]{4}$/.test(entry))
      .filter((entry) => {
        try {
          return statSync(join(this.appsRoot, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  }

  /**
   * Compute total size of a workspace (rough estimate, excluding node_modules).
   */
  workspaceSizeBytes(specId: string): number {
    const rootPath = this.pathFor(specId);
    if (!existsSync(rootPath)) return 0;
    return walkSize(rootPath);
  }
}

function walkSize(dir: string): number {
  let total = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) total += walkSize(full);
    else total += stat.size;
  }
  return total;
}
