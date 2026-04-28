import { z } from 'zod';

// Raw signal from any source
export const RawSignalSchema = z.object({
  source: z.enum(['shopify_appstore', 'reddit', 'shopify_community', 'producthunt']),
  sourceUrl: z.string().url(),
  signalType: z.enum(['negative_review', 'forum_post', 'product_launch', 'feature_request']),
  title: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()),
});
export type RawSignal = z.infer<typeof RawSignalSchema>;

// Opportunity output from Claude
export const OpportunitySchema = z.object({
  opportunity_id: z.string().regex(/^OPP-[A-Z0-9]+$/),
  title: z.string().min(5).max(100),
  problem_statement: z.string().min(20),
  evidence: z.array(z.string()).min(1),
  scores: z.object({
    market_size: z.number().int().min(0).max(10),
    urgency: z.number().int().min(0).max(10),
    feasibility: z.number().int().min(0).max(10),
    monetization: z.number().int().min(0).max(10),
    competition: z.number().int().min(0).max(10),
  }),
  total_score: z.number().int().min(0).max(50),
  suggested_pricing: z.string(),
  estimated_dev_time: z.string(),
  competitor_analysis: z.string(),
  recommended_features_mvp: z.array(z.string()).min(1).max(7),
  source_signal_ids: z.array(z.string()).optional(),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

// Claude analysis output (array of opportunities)
export const AnalysisOutputSchema = z.object({
  opportunities: z.array(OpportunitySchema),
});
export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;
