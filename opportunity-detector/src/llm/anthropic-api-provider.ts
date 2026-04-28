import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';
import type { LLMProvider, LLMRequest, LLMResponse } from './provider';

/**
 * Backend 1: direct Anthropic API calls.
 *
 * Pricing model: pay per input/output token.
 * Pros: no machine setup beyond a key, works on any VPS, predictable cost.
 * Cons: costs accumulate with usage.
 */
export class AnthropicAPIProvider implements LLMProvider {
  readonly name = 'anthropic-api' as const;

  private client: Anthropic;
  private model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    if (!opts.apiKey) throw new Error('AnthropicAPIProvider: apiKey is required');
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model || 'claude-opus-4-7';
    logger.info(`AnthropicAPIProvider initialized with model ${this.model}`);
  }

  async analyze(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();

    // Use tool_use to force structured output — far more reliable than parsing prose
    const tool: Anthropic.Tool = {
      name: 'report_opportunities',
      description: 'Submit detected opportunities.',
      input_schema: request.jsonSchema as Anthropic.Tool.InputSchema,
    };

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 8000,
      system: request.systemPrompt,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'report_opportunities' },
      messages: [{ role: 'user', content: request.userMessage }],
    });

    const toolUseBlock = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    if (!toolUseBlock) {
      throw new Error('Anthropic API: no tool_use block in response');
    }

    return {
      data: toolUseBlock.input as { opportunities: unknown[] },
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        durationMs: Date.now() - startTime,
      },
      backend: 'anthropic-api',
    };
  }
}
