import { logger } from '../utils/logger';
import { DETECTOR_SYSTEM_PROMPT } from '../prompts/detector-prompt';
import { OpportunitySchema, type Opportunity, type RawSignal } from '../utils/types';
import { createLLMProvider } from '../llm/factory';
import type { LLMProvider } from '../llm/provider';

/**
 * The JSON schema describing a valid analysis output. Used by both backends:
 * - Anthropic API: passed as `tool.input_schema` to force tool_use
 * - Claude Code:   passed as `--json-schema` to force structured output
 */
const REPORT_OPPORTUNITIES_SCHEMA = {
  type: 'object',
  properties: {
    opportunities: {
      type: 'array',
      description: 'Array of opportunities. Empty array if no signal meets the threshold.',
      items: {
        type: 'object',
        required: [
          'opportunity_id',
          'title',
          'problem_statement',
          'evidence',
          'scores',
          'total_score',
          'suggested_pricing',
          'estimated_dev_time',
          'competitor_analysis',
          'recommended_features_mvp',
        ],
        properties: {
          opportunity_id: { type: 'string', pattern: '^OPP-[A-Z0-9]{4}$' },
          title: { type: 'string', minLength: 5, maxLength: 100 },
          problem_statement: { type: 'string', minLength: 20 },
          evidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
          scores: {
            type: 'object',
            required: ['market_size', 'urgency', 'feasibility', 'monetization', 'competition'],
            properties: {
              market_size: { type: 'integer', minimum: 0, maximum: 10 },
              urgency: { type: 'integer', minimum: 0, maximum: 10 },
              feasibility: { type: 'integer', minimum: 0, maximum: 10 },
              monetization: { type: 'integer', minimum: 0, maximum: 10 },
              competition: { type: 'integer', minimum: 0, maximum: 10 },
            },
          },
          total_score: { type: 'integer', minimum: 0, maximum: 50 },
          suggested_pricing: { type: 'string' },
          estimated_dev_time: { type: 'string' },
          competitor_analysis: { type: 'string' },
          recommended_features_mvp: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 7,
          },
          source_signal_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  required: ['opportunities'],
} as const;

let cachedProvider: LLMProvider | null = null;
function getProvider(): LLMProvider {
  if (!cachedProvider) cachedProvider = createLLMProvider();
  return cachedProvider;
}

function formatSignalsForAnalysis(signals: (RawSignal & { id: string })[]): string {
  return signals
    .map((s, i) => {
      const meta = JSON.stringify(s.metadata).substring(0, 300);
      const content = s.content.substring(0, 800);
      return `--- SIGNAL ${i + 1} (id: ${s.id}, source: ${s.source}) ---
TITLE: ${s.title}
CONTENT: ${content}
META: ${meta}`;
    })
    .join('\n\n');
}

export async function analyzeSignals(
  signals: (RawSignal & { id: string })[],
  options: { maxOpportunities?: number; minScore?: number } = {}
): Promise<Opportunity[]> {
  if (signals.length === 0) {
    logger.warn('No signals to analyze');
    return [];
  }

  const maxOpportunities = options.maxOpportunities ?? 15;
  const minScore = options.minScore ?? 25;

  const provider = getProvider();
  logger.info(`Analyzing ${signals.length} signals via ${provider.name}...`);

  const userMessage = `Voici un lot de ${signals.length} signaux bruts collectés depuis l'App Store Shopify, le forum Shopify Community et Product Hunt.

Analyse-les et identifie les opportunités de micro-apps Shopify rentables.

Contraintes :
- Maximum ${maxOpportunities} opportunités
- Score minimum : ${minScore}/50
- Cite les IDs des signaux dans source_signal_ids

${formatSignalsForAnalysis(signals)}

Retourne maintenant ton analyse au format JSON conforme au schéma fourni.`;

  try {
    const response = await provider.analyze({
      systemPrompt: DETECTOR_SYSTEM_PROMPT,
      userMessage,
      jsonSchema: REPORT_OPPORTUNITIES_SCHEMA,
      maxTokens: 8000,
    });

    const rawOpportunities = response.data.opportunities;

    // Validate each opportunity through Zod (same logic for both backends)
    const validated: Opportunity[] = [];
    for (const raw of rawOpportunities) {
      const result = OpportunitySchema.safeParse(raw);
      if (result.success) {
        const s = result.data.scores;
        result.data.total_score =
          s.market_size + s.urgency + s.feasibility + s.monetization + s.competition;

        if (result.data.total_score >= minScore) {
          validated.push(result.data);
        } else {
          logger.debug(
            `Filtered out below threshold: ${result.data.title} (${result.data.total_score})`
          );
        }
      } else {
        logger.warn('Invalid opportunity from LLM', { errors: result.error.issues, raw });
      }
    }

    logger.info(
      `Got ${validated.length} valid opportunities (filtered from ${rawOpportunities.length})`
    );
    logUsage(response.usage, response.backend);

    return validated;
  } catch (error) {
    logger.error('LLM analysis failed', { backend: provider.name, error: (error as Error).message });
    throw error;
  }
}

function logUsage(usage: { inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs: number }, backend: string): void {
  const parts: string[] = [`backend=${backend}`, `duration=${(usage.durationMs / 1000).toFixed(1)}s`];
  if (usage.inputTokens !== undefined) parts.push(`input=${usage.inputTokens}t`);
  if (usage.outputTokens !== undefined) parts.push(`output=${usage.outputTokens}t`);
  if (usage.costUsd !== undefined) parts.push(`cost=$${usage.costUsd.toFixed(4)}`);
  logger.info(`LLM usage: ${parts.join(', ')}`);
}
