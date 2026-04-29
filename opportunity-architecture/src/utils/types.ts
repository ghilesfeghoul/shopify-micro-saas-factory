import { z } from 'zod';

// Mirror of an Opportunity from the detector service
export const OpportunityFromDetectorSchema = z.object({
  id: z.string(),
  opportunityId: z.string().regex(/^OPP-[A-Z0-9]+$/),
  title: z.string(),
  problemStatement: z.string(),
  marketSize: z.number().int(),
  urgency: z.number().int(),
  feasibility: z.number().int(),
  monetization: z.number().int(),
  competition: z.number().int(),
  totalScore: z.number().int(),
  suggestedPricing: z.string(),
  estimatedDevTime: z.string(),
  competitorAnalysis: z.string(),
  recommendedFeatures: z.string(), // JSON-stringified array
  status: z.string(),
  priority: z.string(),
  detectedAt: z.string().or(z.date()),
});
export type OpportunityFromDetector = z.infer<typeof OpportunityFromDetectorSchema>;

// Trigger modes for spec generation
export type TriggerMode = 'auto' | 'manual' | 'regenerate' | 'api';

// Spec lifecycle status
export type SpecStatus = 'draft' | 'reviewed' | 'approved' | 'building' | 'rejected' | 'archived';

export const VALID_SPEC_STATUSES: SpecStatus[] = [
  'draft',
  'reviewed',
  'approved',
  'building',
  'rejected',
  'archived',
];
