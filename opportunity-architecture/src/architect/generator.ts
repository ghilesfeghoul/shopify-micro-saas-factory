import { logger } from '../utils/logger';
import { createLLMProvider } from '../llm/factory';
import { ARCHITECT_SYSTEM_PROMPT } from './prompts/architect-prompt';
import {
  TechnicalSpecSchema,
  TECHNICAL_SPEC_JSON_SCHEMA,
  SPEC_SCHEMA_VERSION,
  type TechnicalSpec,
} from './schemas/spec-schema';
import { generateSpecId } from '../utils/id-generator';
import type { OpportunityFromDetector, TriggerMode } from '../utils/types';

const ARCHITECT_VERSION = 'architect-1.0.0';

export interface GenerateOptions {
  triggerMode: TriggerMode;
  triggeredBy?: string;
  forceRegenerate?: boolean;
}

export interface GenerationResult {
  spec: TechnicalSpec;
  llmBackend: string;
  llmModel: string | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  costUsd: number | undefined;
  durationMs: number;
}

/**
 * Build the user message that prompts Claude with the opportunity context.
 */
function buildUserMessage(opp: OpportunityFromDetector, suggestedSpecId: string): string {
  const features = JSON.parse(opp.recommendedFeatures) as string[];

  return `Voici une opportunité scorée par l'Agent Détecteur. Génère une spécification technique complète.

# OPPORTUNITÉ

**ID:** ${opp.opportunityId}
**Titre:** ${opp.title}

**Problème identifié:**
${opp.problemStatement}

**Scores (sur 10 chacun, total /50):**
- Market size: ${opp.marketSize}
- Urgency: ${opp.urgency}
- Feasibility: ${opp.feasibility}
- Monetization: ${opp.monetization}
- Competition: ${opp.competition}
- **Total: ${opp.totalScore}/50** (priorité: ${opp.priority})

**Pricing suggéré:** ${opp.suggestedPricing}
**Temps de dev estimé (par le détecteur):** ${opp.estimatedDevTime}

**Analyse concurrentielle:**
${opp.competitorAnalysis}

**Features MVP recommandées par le détecteur:**
${features.map((f, i) => `${i + 1}. ${f}`).join('\n')}

# CONSIGNES DE GÉNÉRATION

- Utilise \`${suggestedSpecId}\` comme \`specId\`
- Utilise \`${opp.opportunityId}\` comme \`opportunityId\`
- Utilise \`${SPEC_SCHEMA_VERSION}\` comme \`schemaVersion\`
- Utilise \`${ARCHITECT_VERSION}\` comme \`metadata.generatorVersion\`
- Utilise \`${new Date().toISOString()}\` comme \`metadata.generatedAt\`
- Utilise \`${opp.totalScore}\` comme \`metadata.sourceOpportunityScore\`

Tu peux RAFFINER la liste de features MVP du détecteur si nécessaire (le détecteur n'a qu'une vue surface, toi tu connais Shopify en profondeur).

Maintenant, appelle la fonction \`submit_technical_spec\` avec la spec complète.`;
}

/**
 * Generate a technical spec for the given opportunity.
 * Returns the validated spec or throws.
 */
export async function generateSpec(
  opportunity: OpportunityFromDetector,
  _options: GenerateOptions
): Promise<GenerationResult> {
  const startTime = Date.now();
  const provider = createLLMProvider();

  logger.info(`Generating spec for ${opportunity.opportunityId} via ${provider.name}`, {
    title: opportunity.title,
    score: opportunity.totalScore,
  });

  const suggestedSpecId = generateSpecId();
  const userMessage = buildUserMessage(opportunity, suggestedSpecId);

  // Call LLM with structured output enforcement
  const response = await provider.analyze({
    systemPrompt: ARCHITECT_SYSTEM_PROMPT,
    userMessage,
    jsonSchema: TECHNICAL_SPEC_JSON_SCHEMA,
    toolName: 'submit_technical_spec',
    maxTokens: 16000,
  });

  // Validate via Zod (more flexible than JSON Schema for fine-grained checks)
  const validation = TechnicalSpecSchema.safeParse(response.data);
  if (!validation.success) {
    logger.error('LLM produced invalid spec', {
      errors: validation.error.issues.slice(0, 5),
      opportunityId: opportunity.opportunityId,
    });
    throw new Error(
      `Spec validation failed: ${validation.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`
    );
  }

  const spec = validation.data;

  // Post-validation business rules
  enforceBusinessRules(spec);

  const durationMs = Date.now() - startTime;
  logger.info(`Spec generated successfully`, {
    specId: spec.specId,
    appName: spec.overview.appName,
    estimatedHours: spec.estimation.totalHours,
    complexity: spec.estimation.complexityScore,
    durationMs,
  });

  return {
    spec,
    llmBackend: response.backend,
    llmModel: response.model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: response.usage.costUsd,
    durationMs,
  };
}

/**
 * Hard business rules that must be checked beyond schema validation.
 */
function enforceBusinessRules(spec: TechnicalSpec): void {
  // GDPR webhooks are mandatory
  const gdprTopics = ['customers/data_request', 'customers/redact', 'shop/redact'];
  const presentTopics = spec.shopify.webhooks
    .filter((w) => w.category === 'gdpr')
    .map((w) => w.topic);

  for (const required of gdprTopics) {
    if (!presentTopics.includes(required)) {
      throw new Error(`Mandatory GDPR webhook missing: ${required}`);
    }
  }

  if (!spec.compliance.gdprWebhooksImplemented) {
    throw new Error('compliance.gdprWebhooksImplemented must be true');
  }

  // All required scopes must have justifications
  for (const scope of spec.shopify.requiredScopes) {
    if (!spec.shopify.scopesJustification[scope]) {
      throw new Error(`Scope "${scope}" has no justification in scopesJustification`);
    }
  }

  // Estimation breakdown should roughly match totalHours
  const breakdownSum = spec.estimation.breakdown.reduce((sum, b) => sum + b.hours, 0);
  const drift = Math.abs(breakdownSum - spec.estimation.totalHours);
  if (drift > spec.estimation.totalHours * 0.5) {
    logger.warn(
      `Breakdown sum (${breakdownSum}h) drifts >50% from totalHours (${spec.estimation.totalHours}h) for ${spec.specId}`
    );
  }
}
