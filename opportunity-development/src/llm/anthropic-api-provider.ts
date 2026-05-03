import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';
import type { LLMProvider, LLMRequest, LLMResponse } from './provider';

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
    const toolName = request.toolName || 'submit_output';

    const tool: Anthropic.Tool = {
      name: toolName,
      description: 'Submit the structured output.',
      input_schema: request.jsonSchema as Anthropic.Tool.InputSchema,
    };

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 8000,
      system: request.systemPrompt,
      tools: [tool],
      tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content: request.userMessage }],
    });

    const toolUseBlock = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    if (!toolUseBlock) {
      throw new Error('Anthropic API: no tool_use block in response');
    }

    return {
      data: toolUseBlock.input as Record<string, unknown>,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        durationMs: Date.now() - startTime,
      },
      backend: 'anthropic-api',
      model: this.model,
    };
  }
}
