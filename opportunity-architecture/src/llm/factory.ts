import { logger } from '../utils/logger';
import { AnthropicAPIProvider } from './anthropic-api-provider';
import { ClaudeCodeProvider } from './claude-code-provider';
import type { LLMProvider } from './provider';

export type LLMBackend = 'anthropic-api' | 'claude-code' | 'auto';

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
        useBare: process.env.CLAUDE_CODE_USE_BARE === 'true',
      });

    case 'anthropic-api':
      return new AnthropicAPIProvider({
        apiKey: requireEnv('ANTHROPIC_API_KEY'),
        model: process.env.CLAUDE_MODEL,
      });

    case 'auto': {
      const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
      if (!hasApiKey) {
        logger.info('LLM_BACKEND=auto: no API key, using Claude Code CLI');
        return new ClaudeCodeProvider({
          claudeBinary: process.env.CLAUDE_CODE_BINARY,
          model: process.env.CLAUDE_CODE_MODEL,
          useBare: process.env.CLAUDE_CODE_USE_BARE === 'true',
        });
      }
      logger.info('LLM_BACKEND=auto: API key found, using Anthropic API');
      return new AnthropicAPIProvider({
        apiKey: process.env.ANTHROPIC_API_KEY!,
        model: process.env.CLAUDE_MODEL,
      });
    }

    default:
      throw new Error(`Unknown LLM_BACKEND: "${backend}"`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Set it in .env or use LLM_BACKEND=claude-code.`);
  }
  return value;
}
