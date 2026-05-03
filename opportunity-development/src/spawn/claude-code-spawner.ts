import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger';
import type { DetectedSkill } from '../skills/detector';
import { formatSkillsForPrompt } from '../skills/injector';

/**
 * The ClaudeCodeSpawner is fundamentally different from llm/claude-code-provider.ts.
 *
 * - claude-code-provider.ts: spawns `claude -p --bare --json-schema` for short
 *   structured outputs (no filesystem tools, no skills).
 *
 * - ClaudeCodeSpawner (this file): spawns `claude -p` WITHOUT `--bare`, with
 *   the working directory set to the app's workspace, so Claude Code has
 *   access to:
 *     - Read/Write/Edit/Bash/Grep/Glob tools (full agent mode)
 *     - User-installed skills (Shopify, Superpowers, etc.)
 *     - The workspace's CLAUDE.md if any
 *
 * This is the right abstraction for actual code generation.
 */

export interface SpawnOptions {
  /** Working directory for the subprocess (typically the app workspace) */
  workingDirectory: string;

  /** The prompt to send to Claude Code (via stdin) */
  prompt: string;

  /** Additional system prompt appended to Claude Code's default */
  appendSystemPrompt?: string;

  /** Skills to make discoverable to this sub-agent */
  skills?: DetectedSkill[];

  /** Soft timeout in ms */
  timeoutMs?: number;

  /** Allowed tools (default: all). Useful for restricting destructive operations. */
  allowedTools?: string[];

  /** Permission mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

  /** Optional model override */
  model?: string;

  /** Optional human label for logging */
  label?: string;

  /** Save the full transcript to this path (relative to working dir) */
  transcriptPath?: string;
}

export interface SpawnResult {
  /** Exit code of the claude subprocess */
  exitCode: number;
  /** Whether the subprocess timed out */
  timedOut: boolean;
  /** The full stdout of the run (Claude Code emits structured JSON when --output-format=json) */
  stdout: string;
  /** Stderr content */
  stderr: string;
  /** Parsed final result if --output-format=json was used */
  result?: {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    result?: string;
    total_cost_usd?: number;
    duration_ms?: number;
  };
  /** Total wall-clock duration in ms */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Spawn a Claude Code sub-agent that can read/write files, run commands, and
 * use installed skills. The subprocess inherits the parent's environment.
 */
export class ClaudeCodeSpawner {
  private claudeBinary: string;

  constructor(opts: { claudeBinary?: string } = {}) {
    this.claudeBinary = opts.claudeBinary || process.env.CLAUDE_CODE_BINARY || 'claude';
  }

  /**
   * Spawn a sub-agent. Returns when the subprocess finishes (or times out).
   *
   * IMPORTANT: this does NOT use --bare so Claude Code has access to:
   *   - Filesystem tools (Read/Write/Edit/Bash/Grep/Glob)
   *   - User skills under ~/.claude/skills/ and ~/.claude/plugins/
   *   - Working-directory CLAUDE.md if present
   */
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const label = options.label || 'sub-agent';

    if (!existsSync(options.workingDirectory)) {
      throw new Error(`Working directory does not exist: ${options.workingDirectory}`);
    }

    // Compose the system prompt fragment with skills info
    let appendSystem = options.appendSystemPrompt ?? '';
    if (options.skills && options.skills.length > 0) {
      const skillsBlock = formatSkillsForPrompt(options.skills);
      appendSystem = `${appendSystem}\n\n${skillsBlock}`;
    }

    const args: string[] = [
      '-p',
      '--output-format', 'json',
      '--permission-mode', options.permissionMode ?? 'bypassPermissions',
    ];

    if (appendSystem) {
      args.push('--append-system-prompt', appendSystem);
    }

    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push('--allowed-tools', options.allowedTools.join(','));
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    logger.info(`[${label}] Spawning Claude Code`, {
      cwd: options.workingDirectory,
      timeoutMs,
      skillCount: options.skills?.length ?? 0,
      promptPreview: options.prompt.slice(0, 100) + '...',
    });

    const result = await this.runProcess({
      cwd: options.workingDirectory,
      args,
      stdin: options.prompt,
      timeoutMs,
      label,
    });

    // Save transcript if requested
    if (options.transcriptPath) {
      this.saveTranscript(options.workingDirectory, options.transcriptPath, result, options);
    }

    // Try to parse Claude's JSON envelope
    let parsedResult: SpawnResult['result'];
    try {
      parsedResult = JSON.parse(result.stdout);
    } catch {
      // It's possible stdout has multiple JSON objects (streaming). Take the last line.
      const lines = result.stdout.split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        try {
          parsedResult = JSON.parse(lastLine);
        } catch {
          /* ignore — leave parsedResult undefined */
        }
      }
    }

    const durationMs = Date.now() - startTime;
    logger.info(`[${label}] Sub-agent finished`, {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs,
      cost: parsedResult?.total_cost_usd,
    });

    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      result: parsedResult,
      durationMs,
    };
  }

  private runProcess(opts: {
    cwd: string;
    args: string[];
    stdin: string;
    timeoutMs: number;
    label: string;
  }): Promise<{ exitCode: number; timedOut: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.claudeBinary, opts.args, {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      } catch (err) {
        reject(err);
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        logger.warn(`[${opts.label}] Timeout after ${opts.timeoutMs}ms — killing subprocess`);
        child.kill('SIGTERM');
        // Force kill if still alive
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 10_000);
      }, opts.timeoutMs);

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              `Claude Code binary not found at "${this.claudeBinary}". Install: npm install -g @anthropic-ai/claude-code`
            )
          );
        } else {
          reject(err);
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 0,
          timedOut,
          stdout,
          stderr,
        });
      });

      // Feed stdin
      try {
        child.stdin?.write(opts.stdin);
        child.stdin?.end();
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  private saveTranscript(
    workingDirectory: string,
    transcriptPath: string,
    result: { stdout: string; stderr: string },
    options: SpawnOptions
  ): void {
    try {
      const fullPath = join(workingDirectory, transcriptPath);
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

      const content = [
        '═════════════════════════════════════════════════════',
        `Sub-agent transcript: ${options.label ?? 'unnamed'}`,
        `Time: ${new Date().toISOString()}`,
        `Working dir: ${workingDirectory}`,
        '═════════════════════════════════════════════════════',
        '',
        '─── PROMPT ──────────────────────────────────────────',
        options.prompt,
        '',
        '─── STDOUT ──────────────────────────────────────────',
        result.stdout,
        '',
        '─── STDERR ──────────────────────────────────────────',
        result.stderr,
      ].join('\n');

      writeFileSync(fullPath, content, 'utf-8');
    } catch (err) {
      logger.warn(`Failed to save transcript: ${(err as Error).message}`);
    }
  }
}
