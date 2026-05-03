import { z } from 'zod';

// ─── Mirror of TechnicalSpec from architect (for intake validation) ───
// Kept loose here — the architect already validated strictly. We only
// re-validate the fields we actually use.

export const TechnicalSpecMinimalSchema = z.object({
  schemaVersion: z.string(),
  specId: z.string().regex(/^SPEC-[A-Z0-9]{4}$/),
  opportunityId: z.string().regex(/^OPP-[A-Z0-9]+$/),
  overview: z.object({
    appName: z.string(),
    tagline: z.string(),
    description: z.string(),
    mvpScope: z.array(z.string()),
  }),
  architecture: z.object({
    pattern: z.string(),
    backendFramework: z.string(),
    frontendFramework: z.string(),
    database: z.string(),
  }),
  shopify: z.object({
    requiredScopes: z.array(z.string()),
    scopesJustification: z.record(z.string()),
    webhooks: z.array(z.object({
      topic: z.string(),
      category: z.string(),
      required: z.boolean(),
      description: z.string(),
    })),
    apiVersion: z.string(),
    appBridgeVersion: z.string(),
    authMethod: z.string(),
  }),
  apiEndpoints: z.array(z.unknown()),
  database: z.object({
    tables: z.array(z.unknown()),
  }),
  ui: z.object({
    screens: z.array(z.unknown()),
    designSystem: z.string(),
  }),
  testing: z.object({
    strategy: z.string(),
    testCases: z.array(z.unknown()),
  }),
  stack: z.object({
    runtime: z.string(),
    language: z.string(),
    dependencies: z.array(z.unknown()),
  }),
  estimation: z.object({
    totalHours: z.number(),
    complexityScore: z.number(),
  }),
}).passthrough(); // Allow extra fields we don't model

export type TechnicalSpec = z.infer<typeof TechnicalSpecMinimalSchema>;

// ─── Generation lifecycle ─────────────────────────────────────────

export type GenerationStatus =
  | 'pending'           // queued, not started
  | 'planning'          // orchestrator analyzing spec, building DAG
  | 'generating'        // sub-agents running
  | 'integrating'       // cross-module integration check
  | 'validating'        // running install/lint/build/test
  | 'repairing'         // fix-up loop after failure
  | 'completed'         // success
  | 'failed'            // exhausted retries or hard error
  | 'needs_human_review'; // stuck after max repair attempts

export const VALID_GENERATION_STATUSES: GenerationStatus[] = [
  'pending', 'planning', 'generating', 'integrating',
  'validating', 'repairing', 'completed', 'failed', 'needs_human_review',
];

export type SubAgentRole = 'backend' | 'ui' | 'database' | 'tests' | 'config' | 'docs' | 'integrator' | 'repair';

export type SubAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout';

export type TriggerMode = 'auto' | 'manual' | 'api' | 'retry';

// ─── Task chunk model (the unit of work) ──────────────────────────

export interface TaskChunk {
  /** Unique identifier within this generation run */
  id: string;
  /** Role of the sub-agent expected to handle this chunk */
  role: SubAgentRole;
  /** Human-readable title shown in logs/UI */
  title: string;
  /** Detailed instruction given to the sub-agent */
  instruction: string;
  /** Files this chunk is expected to produce (relative to app workspace) */
  expectedOutputs: string[];
  /** Other chunk IDs this one depends on (DAG) */
  dependencies: string[];
  /** Soft timeout in ms */
  timeoutMs: number;
}

// ─── Sub-agent execution result ───────────────────────────────────

export interface SubAgentResult {
  chunkId: string;
  status: SubAgentStatus;
  filesCreated: string[];
  filesModified: string[];
  durationMs: number;
  costUsd?: number;
  errorMessage?: string;
  /** Captured stdout/stderr for debugging */
  transcript?: string;
}
