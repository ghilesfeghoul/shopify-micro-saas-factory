/**
 * Technical Specification Schema for Shopify Apps.
 *
 * This is the canonical contract between the Architect Agent and the
 * Developer Agent (future). It MUST be strict to ensure downstream agents
 * always find the fields they expect.
 *
 * Versioning: bump SPEC_SCHEMA_VERSION on breaking changes.
 */

import { z } from 'zod';

export const SPEC_SCHEMA_VERSION = '1.0.0';

// ─── Sub-schemas ──────────────────────────────────────────────────

const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const FieldTypeSchema = z.enum([
  'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json',
  'BigInt', 'Decimal', 'Bytes',
]);

const ApiEndpointSchema = z.object({
  path: z.string().regex(/^\/api\/.+/, 'Path must start with /api/'),
  method: HttpMethodSchema,
  description: z.string().min(10),
  authRequired: z.boolean(),
  requestSchema: z.object({
    queryParams: z.record(z.string()).optional(),
    body: z.record(z.string()).optional(),
  }).optional(),
  responseSchema: z.record(z.unknown()),
  errorCases: z.array(z.object({
    statusCode: z.number().int().min(400).max(599),
    description: z.string(),
  })).min(1),
  rateLimit: z.string().optional(),
});

const DatabaseFieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/),
  type: FieldTypeSchema,
  nullable: z.boolean(),
  unique: z.boolean().optional(),
  defaultValue: z.string().optional(),
  description: z.string(),
});

const DatabaseTableSchema = z.object({
  name: z.string().regex(/^[A-Z][a-zA-Z0-9]*$/, 'Use PascalCase'),
  description: z.string(),
  fields: z.array(DatabaseFieldSchema).min(1),
  indexes: z.array(z.object({
    fields: z.array(z.string()).min(1),
    unique: z.boolean().optional(),
  })).optional(),
  relations: z.array(z.object({
    name: z.string(),
    targetModel: z.string(),
    type: z.enum(['1:1', '1:N', 'N:N']),
    onDelete: z.enum(['Cascade', 'SetNull', 'Restrict']).optional(),
  })).optional(),
});

const ShopifyWebhookSchema = z.object({
  topic: z.string().regex(/^[a-z_]+\/[a-z_]+$/),
  description: z.string(),
  required: z.boolean(),
  category: z.enum(['gdpr', 'business', 'app']),
});

const UiScreenSchema = z.object({
  name: z.string(),
  path: z.string().regex(/^\//),
  description: z.string(),
  primaryComponents: z.array(z.string()).min(1),
  userActions: z.array(z.string()).min(1),
  apiEndpointsUsed: z.array(z.string()),
});

const TestCaseSchema = z.object({
  name: z.string(),
  type: z.enum(['unit', 'integration', 'e2e']),
  description: z.string(),
  expectedBehavior: z.string(),
});

const DependencySchema = z.object({
  package: z.string(),
  version: z.string(),
  purpose: z.string(),
  isDevDependency: z.boolean().optional(),
});

const RiskSchema = z.object({
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  mitigation: z.string(),
});

// ─── Main spec schema (Zod) ───────────────────────────────────────

export const TechnicalSpecSchema = z.object({
  schemaVersion: z.literal(SPEC_SCHEMA_VERSION),
  specId: z.string().regex(/^SPEC-[A-Z0-9]{4}$/),
  opportunityId: z.string().regex(/^OPP-[A-Z0-9]+$/),

  overview: z.object({
    appName: z.string().min(3).max(50),
    tagline: z.string().min(10).max(120),
    description: z.string().min(50),
    targetMerchants: z.string(),
    valueProposition: z.string(),
    mvpScope: z.array(z.string()).min(2).max(7),
    futureScope: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
  }),

  architecture: z.object({
    pattern: z.enum(['embedded-app', 'public-app', 'custom-app']),
    backendFramework: z.enum(['express', 'remix', 'koa', 'laravel']),
    frontendFramework: z.enum(['react-polaris', 'remix-polaris']),
    database: z.enum(['sqlite', 'postgresql', 'mysql']),
    diagram: z.string(),
    technicalChoicesJustification: z.string(),
  }),

  shopify: z.object({
    requiredScopes: z.array(z.string()).min(1),
    scopesJustification: z.record(z.string()),
    webhooks: z.array(ShopifyWebhookSchema).min(3),
    apiVersion: z.string().regex(/^\d{4}-\d{2}$/),
    appBridgeVersion: z.string(),
    authMethod: z.enum(['session-tokens', 'oauth-only']),
    rateLimitStrategy: z.string(),
  }),

  apiEndpoints: z.array(ApiEndpointSchema).min(1),

  database: z.object({
    tables: z.array(DatabaseTableSchema).min(1),
    seedData: z.string().optional(),
  }),

  ui: z.object({
    screens: z.array(UiScreenSchema).min(1),
    designSystem: z.string(),
    accessibilityNotes: z.string(),
  }),

  testing: z.object({
    strategy: z.string(),
    coverageTarget: z.number().min(50).max(100),
    testCases: z.array(TestCaseSchema).min(3),
  }),

  stack: z.object({
    runtime: z.enum(['node-20', 'node-22']),
    language: z.enum(['typescript-strict']),
    dependencies: z.array(DependencySchema).min(3),
    buildTool: z.string(),
  }),

  estimation: z.object({
    totalHours: z.number().int().min(8).max(200),
    complexityScore: z.number().int().min(1).max(10),
    breakdown: z.array(z.object({
      module: z.string(),
      hours: z.number().int().min(1),
    })).min(2),
    risks: z.array(RiskSchema),
    blockers: z.array(z.string()).optional(),
  }),

  compliance: z.object({
    gdprWebhooksImplemented: z.boolean(),
    policyChecks: z.array(z.object({
      requirement: z.string(),
      compliant: z.boolean(),
      notes: z.string().optional(),
    })),
    appStoreCategory: z.string(),
  }),

  metadata: z.object({
    generatedAt: z.string(),
    generatorVersion: z.string(),
    sourceOpportunityScore: z.number().int().min(0).max(50),
  }),
});

export type TechnicalSpec = z.infer<typeof TechnicalSpecSchema>;

// ─── JSON Schema for LLM ──────────────────────────────────────────
// Hand-mirrored from Zod to keep both in sync. The LLM tool_use needs
// JSON Schema, not Zod.

export const TECHNICAL_SPEC_JSON_SCHEMA = {
  type: 'object',
  required: [
    'schemaVersion', 'specId', 'opportunityId',
    'overview', 'architecture', 'shopify',
    'apiEndpoints', 'database', 'ui',
    'testing', 'stack', 'estimation',
    'compliance', 'metadata',
  ],
  properties: {
    schemaVersion: { type: 'string', const: SPEC_SCHEMA_VERSION },
    specId: { type: 'string', pattern: '^SPEC-[A-Z0-9]{4}$' },
    opportunityId: { type: 'string', pattern: '^OPP-[A-Z0-9]+$' },

    overview: {
      type: 'object',
      required: ['appName', 'tagline', 'description', 'targetMerchants', 'valueProposition', 'mvpScope'],
      properties: {
        appName: { type: 'string', minLength: 3, maxLength: 50 },
        tagline: { type: 'string', minLength: 10, maxLength: 120 },
        description: { type: 'string', minLength: 50 },
        targetMerchants: { type: 'string' },
        valueProposition: { type: 'string' },
        mvpScope: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 7 },
        futureScope: { type: 'array', items: { type: 'string' } },
        nonGoals: { type: 'array', items: { type: 'string' } },
      },
    },

    architecture: {
      type: 'object',
      required: ['pattern', 'backendFramework', 'frontendFramework', 'database', 'diagram', 'technicalChoicesJustification'],
      properties: {
        pattern: { type: 'string', enum: ['embedded-app', 'public-app', 'custom-app'] },
        backendFramework: { type: 'string', enum: ['express', 'remix', 'koa', 'laravel'] },
        frontendFramework: { type: 'string', enum: ['react-polaris', 'remix-polaris'] },
        database: { type: 'string', enum: ['sqlite', 'postgresql', 'mysql'] },
        diagram: { type: 'string' },
        technicalChoicesJustification: { type: 'string' },
      },
    },

    shopify: {
      type: 'object',
      required: ['requiredScopes', 'scopesJustification', 'webhooks', 'apiVersion', 'appBridgeVersion', 'authMethod', 'rateLimitStrategy'],
      properties: {
        requiredScopes: { type: 'array', items: { type: 'string' }, minItems: 1 },
        scopesJustification: { type: 'object', additionalProperties: { type: 'string' } },
        webhooks: {
          type: 'array',
          minItems: 3,
          items: {
            type: 'object',
            required: ['topic', 'description', 'required', 'category'],
            properties: {
              topic: { type: 'string', pattern: '^[a-z_]+/[a-z_]+$' },
              description: { type: 'string' },
              required: { type: 'boolean' },
              category: { type: 'string', enum: ['gdpr', 'business', 'app'] },
            },
          },
        },
        apiVersion: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
        appBridgeVersion: { type: 'string' },
        authMethod: { type: 'string', enum: ['session-tokens', 'oauth-only'] },
        rateLimitStrategy: { type: 'string' },
      },
    },

    apiEndpoints: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['path', 'method', 'description', 'authRequired', 'responseSchema', 'errorCases'],
        properties: {
          path: { type: 'string', pattern: '^/api/.+' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          description: { type: 'string', minLength: 10 },
          authRequired: { type: 'boolean' },
          requestSchema: { type: 'object' },
          responseSchema: { type: 'object' },
          errorCases: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['statusCode', 'description'],
              properties: {
                statusCode: { type: 'integer', minimum: 400, maximum: 599 },
                description: { type: 'string' },
              },
            },
          },
          rateLimit: { type: 'string' },
        },
      },
    },

    database: {
      type: 'object',
      required: ['tables'],
      properties: {
        tables: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['name', 'description', 'fields'],
            properties: {
              name: { type: 'string', pattern: '^[A-Z][a-zA-Z0-9]*$' },
              description: { type: 'string' },
              fields: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['name', 'type', 'nullable', 'description'],
                  properties: {
                    name: { type: 'string', pattern: '^[a-z][a-zA-Z0-9_]*$' },
                    type: { type: 'string', enum: ['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'BigInt', 'Decimal', 'Bytes'] },
                    nullable: { type: 'boolean' },
                    unique: { type: 'boolean' },
                    defaultValue: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
              indexes: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['fields'],
                  properties: {
                    fields: { type: 'array', items: { type: 'string' }, minItems: 1 },
                    unique: { type: 'boolean' },
                  },
                },
              },
              relations: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['name', 'targetModel', 'type'],
                  properties: {
                    name: { type: 'string' },
                    targetModel: { type: 'string' },
                    type: { type: 'string', enum: ['1:1', '1:N', 'N:N'] },
                    onDelete: { type: 'string', enum: ['Cascade', 'SetNull', 'Restrict'] },
                  },
                },
              },
            },
          },
        },
        seedData: { type: 'string' },
      },
    },

    ui: {
      type: 'object',
      required: ['screens', 'designSystem', 'accessibilityNotes'],
      properties: {
        screens: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['name', 'path', 'description', 'primaryComponents', 'userActions', 'apiEndpointsUsed'],
            properties: {
              name: { type: 'string' },
              path: { type: 'string', pattern: '^/' },
              description: { type: 'string' },
              primaryComponents: { type: 'array', items: { type: 'string' }, minItems: 1 },
              userActions: { type: 'array', items: { type: 'string' }, minItems: 1 },
              apiEndpointsUsed: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        designSystem: { type: 'string' },
        accessibilityNotes: { type: 'string' },
      },
    },

    testing: {
      type: 'object',
      required: ['strategy', 'coverageTarget', 'testCases'],
      properties: {
        strategy: { type: 'string' },
        coverageTarget: { type: 'integer', minimum: 50, maximum: 100 },
        testCases: {
          type: 'array',
          minItems: 3,
          items: {
            type: 'object',
            required: ['name', 'type', 'description', 'expectedBehavior'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['unit', 'integration', 'e2e'] },
              description: { type: 'string' },
              expectedBehavior: { type: 'string' },
            },
          },
        },
      },
    },

    stack: {
      type: 'object',
      required: ['runtime', 'language', 'dependencies', 'buildTool'],
      properties: {
        runtime: { type: 'string', enum: ['node-20', 'node-22'] },
        language: { type: 'string', enum: ['typescript-strict'] },
        dependencies: {
          type: 'array',
          minItems: 3,
          items: {
            type: 'object',
            required: ['package', 'version', 'purpose'],
            properties: {
              package: { type: 'string' },
              version: { type: 'string' },
              purpose: { type: 'string' },
              isDevDependency: { type: 'boolean' },
            },
          },
        },
        buildTool: { type: 'string' },
      },
    },

    estimation: {
      type: 'object',
      required: ['totalHours', 'complexityScore', 'breakdown', 'risks'],
      properties: {
        totalHours: { type: 'integer', minimum: 8, maximum: 200 },
        complexityScore: { type: 'integer', minimum: 1, maximum: 10 },
        breakdown: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            required: ['module', 'hours'],
            properties: {
              module: { type: 'string' },
              hours: { type: 'integer', minimum: 1 },
            },
          },
        },
        risks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['description', 'severity', 'mitigation'],
            properties: {
              description: { type: 'string' },
              severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
              mitigation: { type: 'string' },
            },
          },
        },
        blockers: { type: 'array', items: { type: 'string' } },
      },
    },

    compliance: {
      type: 'object',
      required: ['gdprWebhooksImplemented', 'policyChecks', 'appStoreCategory'],
      properties: {
        gdprWebhooksImplemented: { type: 'boolean' },
        policyChecks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['requirement', 'compliant'],
            properties: {
              requirement: { type: 'string' },
              compliant: { type: 'boolean' },
              notes: { type: 'string' },
            },
          },
        },
        appStoreCategory: { type: 'string' },
      },
    },

    metadata: {
      type: 'object',
      required: ['generatedAt', 'generatorVersion', 'sourceOpportunityScore'],
      properties: {
        generatedAt: { type: 'string' },
        generatorVersion: { type: 'string' },
        sourceOpportunityScore: { type: 'integer', minimum: 0, maximum: 50 },
      },
    },
  },
};
