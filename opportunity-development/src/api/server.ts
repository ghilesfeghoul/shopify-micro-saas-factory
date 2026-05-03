import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { getArchitectClient } from '../architect-client/client';
import { orchestrate } from '../orchestrator/orchestrator';
import { generateAppId } from '../utils/id-generator';
import { WorkspaceManager } from '../workspace/manager';
import {
  prisma,
  createGenerationRun,
  updateRunStatus,
  getRun,
  listRuns,
  getStats,
} from '../storage/repository';
import { logger } from '../utils/logger';
import { hmacAuth } from '../auth/hmac';
import { ipAllowlist } from '../auth/ip-allowlist';
import type { GenerationStatus, TriggerMode } from '../utils/types';
import { VALID_GENERATION_STATUSES } from '../utils/types';

const app = express();
app.set('trust proxy', 'loopback');

app.use(
  express.json({
    limit: '512kb',
    verify: (req: Request, _res, buf) => {
      (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  })
);

const PORT = parseInt(process.env.PORT || '3002', 10);
const HOST = process.env.HOST || '127.0.0.1';
const HMAC_SECRET = process.env.HMAC_SECRET || '';
const IP_ALLOWLIST = (process.env.IP_ALLOWLIST || '').split(',');

if (!HMAC_SECRET || HMAC_SECRET.length < 32) {
  logger.error('HMAC_SECRET must be set and >= 32 chars');
  process.exit(1);
}

const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10, // tighter than architect — generation is expensive
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many generations triggered. Try again later.' },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ─── Public ──────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'opportunity-development' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: (error as Error).message });
  }
});

// ─── Protected ───────────────────────────────────────────────────

const protect = [ipAllowlist(IP_ALLOWLIST), hmacAuth(HMAC_SECRET)];

/** POST /develop/generate — start a new generation run */
app.post('/develop/generate', generateLimiter, ...protect, async (req, res) => {
  const { specId, force, skipValidation, async: asyncMode } = req.body as {
    specId?: string;
    force?: boolean;
    skipValidation?: boolean;
    async?: boolean;
  };

  if (!specId || !/^SPEC-[A-Z0-9]{4}$/.test(specId)) {
    res.status(400).json({ error: 'Valid specId required (SPEC-XXXX format)' });
    return;
  }

  // Fetch spec + markdown
  const architect = getArchitectClient();
  const fetched = await architect.getSpec(specId);
  if (!fetched) {
    res.status(404).json({ error: `Spec ${specId} not found` });
    return;
  }

  const appId = generateAppId();
  const workspace = new WorkspaceManager();
  const workspacePath = workspace.pathFor(specId);
  const triggerMode: TriggerMode = 'api';

  const runId = await createGenerationRun({
    appId,
    specId,
    opportunityId: fetched.spec.opportunityId,
    workspacePath,
    triggerMode,
    triggeredBy: 'api',
  });

  if (asyncMode) {
    res.status(202).json({
      status: 'started',
      appId,
      runId,
      workspacePath,
      message: 'Generation running in background. Poll /develop/runs/:id for status.',
    });

    // Run in background
    orchestrate({
      spec: fetched.spec,
      triggerMode,
      triggeredBy: 'api',
      force,
      skipValidation,
    })
      .then(async (result) => {
        await updateRunStatus(runId, result.status as GenerationStatus, {
          totalChunks: result.totalChunks,
          successfulChunks: result.successfulChunks,
          failedChunks: result.failedChunks,
          validationPassed: result.validationPassed,
          complianceReportMd: result.complianceReport,
          compliancePassed: result.complianceReport.includes('0 failed'),
          repairAttempts: result.repairAttempts,
          totalCostUsd: result.totalCostUsd,
          totalDurationMs: result.totalDurationMs,
          hasGitRepo: true,
          ...(result.errorReport && { errorMessage: result.errorReport }),
        });
      })
      .catch(async (error) => {
        logger.error('Background generation failed', { error: (error as Error).message });
        await updateRunStatus(runId, 'failed', {
          errorMessage: (error as Error).message,
        });
      });
    return;
  }

  // Sync mode
  try {
    const result = await orchestrate({
      spec: fetched.spec,
      triggerMode,
      triggeredBy: 'api',
      force,
      skipValidation,
    });

    await updateRunStatus(runId, result.status as GenerationStatus, {
      totalChunks: result.totalChunks,
      successfulChunks: result.successfulChunks,
      failedChunks: result.failedChunks,
      validationPassed: result.validationPassed,
      complianceReportMd: result.complianceReport,
      compliancePassed: result.complianceReport.includes('0 failed'),
      repairAttempts: result.repairAttempts,
      totalCostUsd: result.totalCostUsd,
      totalDurationMs: result.totalDurationMs,
      hasGitRepo: true,
    });

    res.json({ appId, runId, ...result });
  } catch (error) {
    await updateRunStatus(runId, 'failed', { errorMessage: (error as Error).message });
    res.status(500).json({ error: (error as Error).message, runId, appId });
  }
});

/** GET /develop/runs — list runs */
app.get('/develop/runs', readLimiter, ...protect, async (req, res) => {
  try {
    const runs = await listRuns({
      status: req.query.status as GenerationStatus | undefined,
      specId: req.query.specId as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
    });
    res.json({ count: runs.length, runs });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** GET /develop/runs/:id — single run */
app.get('/develop/runs/:id', readLimiter, ...protect, async (req, res) => {
  try {
    const run = await getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json(run);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** PATCH /develop/runs/:id — update status (e.g., human marks needs_human_review → completed after manual fix) */
app.patch('/develop/runs/:id', readLimiter, ...protect, async (req, res) => {
  const { status } = req.body as { status?: GenerationStatus };
  if (!status || !VALID_GENERATION_STATUSES.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${VALID_GENERATION_STATUSES.join(', ')}` });
    return;
  }

  try {
    await updateRunStatus(req.params.id, status);
    res.json({ updated: true, status });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** GET /develop/runs/:id/workspace — verify the workspace still exists on disk */
app.get('/develop/runs/:id/workspace', readLimiter, ...protect, async (req, res) => {
  try {
    const run = await getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json({
      workspacePath: run.workspacePath,
      exists: existsSync(run.workspacePath),
      hasGit: existsSync(`${run.workspacePath}/.git`),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** GET /develop/stats */
app.get('/develop/stats', readLimiter, ...protect, async (_req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// ─── Error handler ───────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, HOST, () => {
  logger.info(`🚀 Opportunity Development API running on ${HOST}:${PORT}`);
  logger.info(`   IP allowlist: ${IP_ALLOWLIST.length} ranges`);
  logger.info(`   HMAC auth: enabled`);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await prisma.$disconnect();
  process.exit(0);
});
