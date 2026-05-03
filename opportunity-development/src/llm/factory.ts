import { logger } from '../utils/logger';
import { AnthropicAPIProvider } from './anthropic-api-provider';
import { ClaudeCodeProvider } from './claude-code-provider';
import type { LLMProvider } from './provider';

export type LLMBackend = 'anthropic-api' | 'claude-code' | 'auto';

/**
 * Default for the development agent: claude-code preferred, anthropic-api as fallback.
 * (Per architecture decision Q2.)
 */
export function createLLMProvider(): LLMProvider {
  // Default to "auto" (which prefers claude-code if available) to encourage Claude Code use
  const backend = (process.env.LLM_BACKEND || 'auto') as LLMBackend;

  switch (backend) {
    case 'claude-code':
      return new ClaudeCodeProvider({
        claudeBinary: process.env.CLAUDE_CODE_BINARY,
        timeoutMs: process.env.CLAUDE_CODE_TIMEOUT_MS
          ? parseInt(process.env.CLAUDE_CODE_TIMEOUT_MS, 10)
          : undefined,
        model: process.env.CLAUDE_CODE_MODEL,
        useBare: process.env.CLAUDE_CODE_USE_BARE === 'true',
      });

    case 'anthropic-api':
      return new AnthropicAPIProvider({
        apiKey: requireEnv('ANTHROPIC_API_KEY'),
        model: process.env.CLAUDE_MODEL,
      });

    case 'auto': {
      // Try Claude Code first (the development agent's preferred mode).
      // Only fall back to API if Claude Code is unavailable AND we have an API key.
      try {
        return new ClaudeCodeProvider({
          claudeBinary: process.env.CLAUDE_CODE_BINARY,
          model: process.env.CLAUDE_CODE_MODEL,
          useBare: process.env.CLAUDE_CODE_USE_BARE === 'true',
        });
      } catch (err) {
        logger.warn('Claude Code unavailable, falling back to API', {
          error: (err as Error).message,
        });
        if (!process.env.ANTHROPIC_API_KEY) {
          throw new Error(
            'LLM_BACKEND=auto: Claude Code unavailable and no ANTHROPIC_API_KEY for fallback'
          );
        }
        return new AnthropicAPIProvider({
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: process.env.CLAUDE_MODEL,
        });
      }
    }

    default:
      throw new Error(`Unknown LLM_BACKEND: "${backend}"`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
