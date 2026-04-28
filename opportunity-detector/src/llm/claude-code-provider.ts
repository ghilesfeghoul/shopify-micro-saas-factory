import { spawn } from 'node:child_process';
import { logger } from '../utils/logger';
import type { LLMProvider, LLMRequest, LLMResponse } from './provider';

/**
 * Backend 2: Claude Code CLI in headless mode.
 *
 * How it works: spawns `claude -p` as a subprocess, pipes the user message
 * via stdin, parses the JSON output. Authentication uses whatever is set up
 * for the local `claude` install — typically an OAuth session tied to a
 * Pro/Max subscription.
 *
 * Why it works for testing:
 * - No per-call charge if you have a Pro/Max subscription
 * - Same Claude model under the hood
 * - --json-schema gives the same structured-output guarantee as API tool_use
 *
 * Limitations:
 * - Requires `claude` CLI installed and authenticated on the host
 * - Subscription quotas can throttle high-volume usage
 * - --bare mode strongly recommended to skip CLAUDE.md / hooks / MCP discovery
 */
export class ClaudeCodeProvider implements LLMProvider {
  readonly name = 'claude-code' as const;

  private claudeBinary: string;
  private timeoutMs: number;
  private model: string | undefined;

  constructor(opts: { claudeBinary?: string; timeoutMs?: number; model?: string } = {}) {
    this.claudeBinary = opts.claudeBinary || 'claude';
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000; // 5 minutes default
    this.model = opts.model;
    logger.info(`ClaudeCodeProvider initialized (binary: ${this.claudeBinary})`);
  }

  async analyze(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();

    // Compose the full prompt: system context comes via --append-system-prompt,
    // and the user message is what we pipe in via stdin
    const args = [
      '-p', // print/headless mode
      '--output-format', 'json',
      '--append-system-prompt', request.systemPrompt,
      '--json-schema', JSON.stringify(request.jsonSchema),
      '--permission-mode', 'bypassPermissions', // analysis only, no tool execution
      '--tools', '', // disable all tools — analysis only
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', // no MCP servers
    ];

    if (this.model) {
      args.push('--model', this.model);
    }

    logger.debug(`Spawning: ${this.claudeBinary} ${args.slice(0, 4).join(' ')} ...`);

    const result = await this.spawnClaude(args, request.userMessage);

    // Output format `json` returns:
    //   { type: "result", subtype: "success", result: "...", session_id, total_cost_usd,
    //     duration_ms, structured_output: {...} }
    // When --json-schema is used, the parsed structure goes into structured_output.
    let parsed: {
      structured_output?: { opportunities: unknown[] };
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
        stderr: result.stderr.slice(0, 500),
      });
      throw new Error(`Claude Code returned invalid JSON: ${(err as Error).message}`);
    }

    if (parsed.is_error) {
      throw new Error(`Claude Code error: ${parsed.result || 'unknown'}`);
    }

    const data = parsed.structured_output;
    if (!data || !Array.isArray(data.opportunities)) {
      // Fallback: try to parse `result` as JSON in case --json-schema wasn't honored
      // (older CLI versions, or schema rejected)
      try {
        const fallback = JSON.parse(parsed.result || '{}') as { opportunities?: unknown[] };
        if (Array.isArray(fallback.opportunities)) {
          return {
            data: { opportunities: fallback.opportunities },
            usage: {
              costUsd: parsed.total_cost_usd,
              durationMs: parsed.duration_ms ?? Date.now() - startTime,
            },
            backend: 'claude-code',
          };
        }
      } catch {
        // ignore; will throw below
      }
      throw new Error('Claude Code: structured_output missing or malformed');
    }

    return {
      data,
      usage: {
        costUsd: parsed.total_cost_usd,
        durationMs: parsed.duration_ms ?? Date.now() - startTime,
      },
      backend: 'claude-code',
    };
  }

  private spawnClaude(
    args: string[],
    stdin: string
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.claudeBinary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // NODE_TLS_REJECT_UNAUTHORIZED=0: the spawned claude binary uses a different
        // SSL trust store than the parent process (system keychain vs bundled certs),
        // causing SSL verification failures when running as a subprocess.
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Force kill if still alive after 5s
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, this.timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              `Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code`
            )
          );
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
        if (code !== 0) {
          logger.warn('Claude Code exited non-zero', { code, stderr: stderr.slice(0, 300) });
        }
        resolve({ stdout, stderr, code: code ?? 0 });
      });

      // Feed the user prompt via stdin and close it
      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}
