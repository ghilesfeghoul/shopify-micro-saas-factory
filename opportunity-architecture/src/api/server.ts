import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { orchestrate } from '../scoring/orchestrator';
import { pollAndAutoTrigger } from '../scoring/poller';
import {
  prisma,
  listSpecs,
  getSpec,
  updateSpecStatus,
  getStats,
  listRecentRuns,
  listRecentPolls,
} from '../storage/repository';
import { renderSpecAsMarkdown } from '../architect/generators/markdown-renderer';
import { logger } from '../utils/logger';
import { hmacAuth } from '../auth/hmac';
import { ipAllowlist } from '../auth/ip-allowlist';
import type { TechnicalSpec } from '../architect/schemas/spec-schema';
import type { SpecStatus } from '../utils/types';
import { VALID_SPEC_STATUSES } from '../utils/types';

const app = express();

// ─── Trust proxy ─────────────────────────────────────────────────
app.set('trust proxy', 'loopback');

// ─── Body parser with raw body capture ───────────────────────────
app.use(
  express.json({
    limit: '512kb',
    verify: (req: Request, _res, buf) => {
      (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  })
);

// ─── Configuration ───────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '127.0.0.1';
const HMAC_SECRET = process.env.HMAC_SECRET || '';
const IP_ALLOWLIST = (process.env.IP_ALLOWLIST || '').split(',');
const ENVIRONMENT = process.env.NODE_ENV || 'development';

if (!HMAC_SECRET || HMAC_SECRET.length < 32) {
  logger.error('HMAC_SECRET must be set and >= 32 chars. Generate: openssl rand -hex 32');
  process.exit(1);
}

// ─── Rate limiting ───────────────────────────────────────────────
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30, // max 30 generations per hour per IP — tighter than detector's scan limit
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

// ─── Security headers ────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ─── Public routes ───────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'opportunity-architecture' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: (error as Error).message });
  }
});

// ─── Protected routes ────────────────────────────────────────────
const protect = [ipAllowlist(IP_ALLOWLIST), hmacAuth(HMAC_SECRET)];

/** Trigger spec generation for an opportunity */
app.post('/architect/generate', generateLimiter, ...protect, async (req, res) => {
  const { opportunityId, forceRegenerate, syncDetectorStatus, async: asyncMode } = req.body as {
    opportunityId?: string;
    forceRegenerate?: boolean;
    syncDetectorStatus?: boolean;
    async?: boolean;
  };

  if (!opportunityId || !/^OPP-[A-Z0-9]+$/.test(opportunityId)) {
    res.status(400).json({ error: 'Valid opportunityId required (OPP-XXXX format)' });
    return;
  }

  if (asyncMode) {
    res.status(202).json({
      status: 'started',
      opportunityId,
      message: 'Generation running in background.',
    });

    orchestrate({
      opportunityId,
      triggerMode: 'api',
      triggeredBy: 'api',
      triggerSource: 'api',
      forceRegenerate,
      syncDetectorStatus,
    }).catch((error) => {
      logger.error('Background generation failed', { error: (error as Error).message });
    });
    return;
  }

  try {
    const result = await orchestrate({
      opportunityId,
      triggerMode: 'api',
      triggeredBy: 'api',
      triggerSource: 'api',
      forceRegenerate,
      syncDetectorStatus,
    });
    res.json(result);
  } catch (error) {
    logger.error('Generate API error', { error: (error as Error).message });
    res.status(500).json({ status: 'failed', error: (error as Error).message });
  }
});

/** Trigger a poll cycle (auto-generation for high-score opportunities) */
app.post('/architect/poll', generateLimiter, ...protect, async (_req, res) => {
  try {
    const result = await pollAndAutoTrigger();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** List specs */
app.get('/specs', readLimiter, ...protect, async (req, res) => {
  try {
    const specs = await listSpecs({
      status: req.query.status as SpecStatus | undefined,
      opportunityId: req.query.opportunityId as string | undefined,
      isActive: req.query.activeOnly === 'false' ? undefined : true,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
    });
    res.json({ count: specs.length, specs });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Get a specific spec — supports ?format=json (default) or ?format=markdown */
app.get('/specs/:id', readLimiter, ...protect, async (req, res) => {
  try {
    const spec = await getSpec(req.params.id);
    if (!spec) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const format = (req.query.format as string) || 'json';
    const fullSpec = JSON.parse(spec.specJson) as TechnicalSpec;

    if (format === 'markdown') {
      const markdown = renderSpecAsMarkdown(fullSpec);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(markdown);
      return;
    }

    res.json({
      meta: {
        specId: spec.specId,
        opportunityId: spec.opportunityId,
        appName: spec.appName,
        status: spec.status,
        version: spec.version,
        isActive: spec.isActive,
        triggerMode: spec.triggerMode,
        triggeredBy: spec.triggeredBy,
        generatedAt: spec.generatedAt,
        reviewedAt: spec.reviewedAt,
        approvedAt: spec.approvedAt,
        llmBackend: spec.llmBackend,
        llmModel: spec.llmModel,
        inputTokens: spec.inputTokens,
        outputTokens: spec.outputTokens,
        costUsd: spec.costUsd,
        durationMs: spec.durationMs,
      },
      spec: fullSpec,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Update spec status */
app.patch('/specs/:id', readLimiter, ...protect, async (req, res) => {
  const { status, rejectionReason } = req.body as { status?: SpecStatus; rejectionReason?: string };

  if (!status || !VALID_SPEC_STATUSES.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${VALID_SPEC_STATUSES.join(', ')}` });
    return;
  }

  try {
    const updated = await updateSpecStatus(req.params.id, status, { rejectionReason });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Recent runs */
app.get('/runs/recent', readLimiter, ...protect, async (req, res) => {
  try {
    const limit = parseInt((req.query.limit as string) || '20', 10);
    const runs = await listRecentRuns(limit);
    res.json({ count: runs.length, runs });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Recent polls */
app.get('/polls/recent', readLimiter, ...protect, async (req, res) => {
  try {
    const limit = parseInt((req.query.limit as string) || '10', 10);
    const polls = await listRecentPolls(limit);
    res.json({ count: polls.length, polls });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Stats */
app.get('/stats', readLimiter, ...protect, async (_req, res) => {
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

// ─── Start ───────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  logger.info(`🚀 Opportunity Architecture API running on ${HOST}:${PORT}`);
  logger.info(`   Environment: ${ENVIRONMENT}`);
  logger.info(`   IP allowlist: ${IP_ALLOWLIST.length} ranges configured`);
  logger.info(`   HMAC auth: enabled`);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await prisma.$disconnect();
  process.exit(0);
});
