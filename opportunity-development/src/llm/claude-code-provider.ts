import { spawn } from 'node:child_process';
import { logger } from '../utils/logger';
import type { LLMProvider, LLMRequest, LLMResponse } from './provider';

/**
 * Lightweight Claude Code wrapper for short, structured outputs.
 * NOT the same as ClaudeCodeSpawner (which manages full code-generation
 * sub-agents with tool access). This one only does --json-schema calls.
 */
export class ClaudeCodeProvider implements LLMProvider {
  readonly name = 'claude-code' as const;

  private claudeBinary: string;
  private timeoutMs: number;
  private model: string | undefined;
  private useBare: boolean;

  constructor(opts: { claudeBinary?: string; timeoutMs?: number; model?: string; useBare?: boolean } = {}) {
    this.claudeBinary = opts.claudeBinary || 'claude';
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    this.model = opts.model;
    this.useBare = opts.useBare ?? false;
    logger.info(`ClaudeCodeProvider initialized (binary: ${this.claudeBinary}, bare: ${this.useBare})`);
  }

  async analyze(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();

    const args: string[] = [];
    if (this.useBare) args.push('--bare');
    args.push('-p', '--output-format', 'json');
    args.push('--append-system-prompt', request.systemPrompt);
    args.push('--json-schema', JSON.stringify(request.jsonSchema));
    args.push('--permission-mode', 'bypassPermissions');

    if (this.model) args.push('--model', this.model);

    const result = await this.spawnClaude(args, request.userMessage);

    let parsed: {
      structured_output?: Record<string, unknown>;
      result?: string;
      total_cost_usd?: number;
      duration_ms?: number;
      is_error?: boolean;
    };

    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      logger.error('ClaudeCodeProvider: failed to parse JSON output', {
        stdout: result.stdout.slice(0, 500),
      });
      throw new Error(`Claude Code returned invalid JSON: ${(err as Error).message}`);
    }

    if (parsed.is_error) {
      throw new Error(`Claude Code error: ${parsed.result || 'unknown'}`);
    }

    let data = parsed.structured_output;
    if (!data) {
      try {
        data = JSON.parse(parsed.result || '{}');
      } catch {
        throw new Error('Claude Code: structured_output missing and result is not parseable JSON');
      }
    }

    return {
      data: data as Record<string, unknown>,
      usage: {
        costUsd: parsed.total_cost_usd,
        durationMs: parsed.duration_ms ?? Date.now() - startTime,
      },
      backend: 'claude-code',
      model: this.model,
    };
  }

  private spawnClaude(args: string[], stdin: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.claudeBinary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, this.timeoutMs);

      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      child.on('error', (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code'));
        } else {
          reject(err);
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Claude Code timed out after ${this.timeoutMs}ms`));
          return;
        }
        resolve({ stdout, stderr, code: code ?? 0 });
      });

      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}
