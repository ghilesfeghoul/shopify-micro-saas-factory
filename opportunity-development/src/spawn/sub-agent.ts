import { logger } from '../utils/logger';
import { ClaudeCodeSpawner } from './claude-code-spawner';
import type { DetectedSkill } from '../skills/detector';
import { pickRelevantSkills } from '../skills/injector';
import type { TaskChunk, SubAgentResult, SubAgentRole } from '../utils/types';
import { WorkspaceManager } from '../workspace/manager';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A single sub-agent execution. Wraps ClaudeCodeSpawner with:
 *   - role-aware prompt assembly (backend/ui/tests/...)
 *   - workspace verification (did the chunk produce expected files?)
 *   - cost/duration tracking
 */
export class SubAgent {
  constructor(
    private spawner: ClaudeCodeSpawner,
    private workspace: WorkspaceManager,
    private specId: string,
    private allSkills: DetectedSkill[],
    private rolePrompts: Record<SubAgentRole, string>
  ) {}

  /**
   * Run a chunk to completion. Returns the result regardless of success/failure
   * (failures don't throw — they're recorded in `result.status`).
   */
  async run(chunk: TaskChunk): Promise<SubAgentResult> {
    const startTime = Date.now();
    const workspacePath = this.workspace.pathFor(this.specId);

    // Snapshot file tree before run, so we can detect created/modified files
    const beforeSnapshot = this.snapshotFiles(workspacePath);

    // Pick role-appropriate skills
    const skills = pickRelevantSkills(this.allSkills, chunk.role);

    // Assemble system prompt for this role
    const rolePrompt = this.rolePrompts[chunk.role] || this.rolePrompts.backend;

    // Build user message: chunk instruction + context
    const userMessage = this.buildUserMessage(chunk);

    let result;
    try {
      result = await this.spawner.spawn({
        workingDirectory: workspacePath,
        prompt: userMessage,
        appendSystemPrompt: rolePrompt,
        skills,
        timeoutMs: chunk.timeoutMs,
        permissionMode: 'bypassPermissions',
        label: `${chunk.id}-${chunk.role}`,
        transcriptPath: `transcripts/${chunk.id}.txt`,
      });
    } catch (error) {
      logger.error(`Sub-agent spawn failed for ${chunk.id}`, {
        error: (error as Error).message,
      });
      return {
        chunkId: chunk.id,
        status: 'failed',
        filesCreated: [],
        filesModified: [],
        durationMs: Date.now() - startTime,
        errorMessage: (error as Error).message,
      };
    }

    // Diff filesystem to determine created/modified files
    const afterSnapshot = this.snapshotFiles(workspacePath);
    const { created, modified } = this.diffSnapshots(beforeSnapshot, afterSnapshot);

    // Determine status
    let status: SubAgentResult['status'] = 'completed';
    let errorMessage: string | undefined;

    if (result.timedOut) {
      status = 'timeout';
      errorMessage = `Timed out after ${chunk.timeoutMs}ms`;
    } else if (result.exitCode !== 0) {
      status = 'failed';
      errorMessage = `Exit code ${result.exitCode}: ${result.stderr.slice(0, 300)}`;
    } else if (result.result?.is_error) {
      status = 'failed';
      errorMessage = `Claude reported error: ${result.result.result || 'unknown'}`;
    }

    // Verify expected outputs
    if (status === 'completed' && chunk.expectedOutputs.length > 0) {
      const missing = this.workspace.verifyOutputs(this.specId, chunk.expectedOutputs);
      if (missing.length > 0) {
        status = 'failed';
        errorMessage = `Missing expected outputs: ${missing.join(', ')}`;
      }
    }

    return {
      chunkId: chunk.id,
      status,
      filesCreated: created,
      filesModified: modified,
      durationMs: Date.now() - startTime,
      costUsd: result.result?.total_cost_usd,
      errorMessage,
    };
  }

  private buildUserMessage(chunk: TaskChunk): string {
    return `# TÂCHE: ${chunk.title}

${chunk.instruction}

# FICHIERS ATTENDUS

À la fin de cette tâche, les fichiers suivants doivent exister dans le répertoire courant :
${chunk.expectedOutputs.map((p) => `- ${p}`).join('\n')}

# RÈGLES DE TRAVAIL

- Tu travailles dans le répertoire courant qui est le workspace de l'app Shopify (\`${this.specId}\`)
- Tu peux créer/modifier les fichiers nécessaires avec les outils Read/Write/Edit
- Tu peux exécuter des commandes shell avec Bash si tu en as besoin (npm install, git, etc.)
- Le fichier \`SPEC.md\` à la racine contient la spec technique complète de l'app — réfère-toi à lui en permanence
- N'écris PAS de fichiers en dehors du répertoire courant
- Si une compétence (skill) est pertinente pour ta tâche, lis son SKILL.md en premier
- Tes décisions doivent être cohérentes avec la spec — toute déviation doit être justifiée

# QUAND TU AS TERMINÉ

Réponds simplement avec un court résumé de ce que tu as fait. Le workspace sera inspecté automatiquement pour vérifier les fichiers attendus.`;
  }

  /** Take a snapshot of files (path → mtime+size) under a directory. */
  private snapshotFiles(rootPath: string): Map<string, { size: number; mtime: number }> {
    const snap = new Map<string, { size: number; mtime: number }>();
    walkRecursive(rootPath, rootPath, snap);
    return snap;
  }

  private diffSnapshots(
    before: Map<string, { size: number; mtime: number }>,
    after: Map<string, { size: number; mtime: number }>
  ): { created: string[]; modified: string[] } {
    const created: string[] = [];
    const modified: string[] = [];

    for (const [path, info] of after.entries()) {
      const bef = before.get(path);
      if (!bef) {
        created.push(path);
      } else if (bef.size !== info.size || bef.mtime !== info.mtime) {
        modified.push(path);
      }
    }

    return { created, modified };
  }
}

function walkRecursive(
  rootPath: string,
  currentPath: string,
  snap: Map<string, { size: number; mtime: number }>
): void {
  let entries: string[];
  try {
    entries = readdirSync(currentPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'transcripts') continue;
    const full = join(currentPath, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkRecursive(rootPath, full, snap);
    } else {
      const rel = full.substring(rootPath.length + 1);
      snap.set(rel, { size: stat.size, mtime: stat.mtimeMs });
    }
  }
}
