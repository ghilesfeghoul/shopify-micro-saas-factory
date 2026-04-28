import { logger } from '../utils/logger';
import { AnthropicAPIProvider } from './anthropic-api-provider';
import { ClaudeCodeProvider } from './claude-code-provider';
import type { LLMProvider } from './provider';

export type LLMBackend = 'anthropic-api' | 'claude-code' | 'auto';

/**
 * Select an LLM provider based on environment configuration.
 *
 * `LLM_BACKEND` values:
 *   - "anthropic-api"  → always use the API (production default)
 *   - "claude-code"    → always use the Claude Code CLI (local testing)
 *   - "auto"           → pick claude-code if `claude` is available AND no
 *                        ANTHROPIC_API_KEY, otherwise fall back to API
 *
 * Defaults to "anthropic-api" if unset.
 */
export function createLLMProvider(): LLMProvider {
  const backend = (process.env.LLM_BACKEND || 'anthropic-api') as LLMBackend;

  switch (backend) {
    case 'claude-code':
      return new ClaudeCodeProvider({
        claudeBinary: process.env.CLAUDE_CODE_BINARY,
        timeoutMs: process.env.CLAUDE_CODE_TIMEOUT_MS
          ? parseInt(process.env.CLAUDE_CODE_TIMEOUT_MS, 10)
          : undefined,
        model: process.env.CLAUDE_CODE_MODEL,
      });

    case 'anthropic-api':
      return new AnthropicAPIProvider({
        apiKey: requireEnv('ANTHROPIC_API_KEY'),
        model: process.env.CLAUDE_MODEL,
      });

    case 'auto': {
      // Auto-detect: if no API key but `claude` exists, prefer Claude Code
      const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
      if (!hasApiKey) {
        logger.info('LLM_BACKEND=auto: no API key found, using Claude Code CLI');
        return new ClaudeCodeProvider({
          claudeBinary: process.env.CLAUDE_CODE_BINARY,
          model: process.env.CLAUDE_CODE_MODEL,
        });
      }
      logger.info('LLM_BACKEND=auto: API key found, using Anthropic API');
      return new AnthropicAPIProvider({
        apiKey: process.env.ANTHROPIC_API_KEY!,
        model: process.env.CLAUDE_MODEL,
      });
    }

    default:
      throw new Error(
        `Unknown LLM_BACKEND: "${backend}". Use "anthropic-api", "claude-code", or "auto".`
      );
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required. Set it in .env or switch LLM_BACKEND to "claude-code".`
    );
  }
  return value;
}
