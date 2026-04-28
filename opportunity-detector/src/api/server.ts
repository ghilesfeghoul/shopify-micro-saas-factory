import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { runScan, type ScanSource } from '../scoring/orchestrator';
import { listOpportunities, getOpportunity, prisma } from '../storage/repository';
import { logger } from '../utils/logger';
import { hmacAuth } from '../auth/hmac';
import { ipAllowlist } from '../auth/ip-allowlist';

const app = express();

// ─── Trust proxy ─────────────────────────────────────────────────
// Required so req.ip reflects the real client IP behind Caddy
app.set('trust proxy', 'loopback');

// ─── Body parser with raw body capture ───────────────────────────
// HMAC signing covers the raw body bytes — must capture before parsing
app.use(
  express.json({
    limit: '256kb',
    verify: (req: Request, _res, buf) => {
      (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  })
);

// ─── Configuration ───────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const HMAC_SECRET = process.env.HMAC_SECRET || '';
const IP_ALLOWLIST = (process.env.IP_ALLOWLIST || '').split(',');
const ENVIRONMENT = process.env.NODE_ENV || 'development';

if (!HMAC_SECRET || HMAC_SECRET.length < 32) {
  logger.error('HMAC_SECRET must be set and >= 32 chars. Generate one: openssl rand -hex 32');
  process.exit(1);
}

// ─── Rate limiting ───────────────────────────────────────────────
// Belt-and-suspenders: even if auth is bypassed, can't spam the LLM API
const scanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // max 10 scans per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many scans triggered. Try again later.' },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
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

// ─── Public endpoints (no auth) ──────────────────────────────────

/** Health check — no auth so monitoring can ping it */
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'error', message: (error as Error).message });
  }
});

// ─── Protected endpoints ─────────────────────────────────────────
// Build the auth chain: IP filter → HMAC verification
const protect = [ipAllowlist(IP_ALLOWLIST), hmacAuth(HMAC_SECRET)];

/** Trigger a scan */
app.post('/scan', scanLimiter, ...protect, async (req, res) => {
  const { source, minScore, maxOpportunities, async: asyncMode } = req.body as {
    source?: ScanSource;
    minScore?: number;
    maxOpportunities?: number;
    async?: boolean;
  };

  if (asyncMode) {
    res.status(202).json({
      status: 'started',
      message: 'Scan running in background. Use GET /scans/recent to monitor.',
    });
    runScan({ source, minScore, maxOpportunities }).catch((error) => {
      logger.error('Background scan failed', { error: (error as Error).message });
    });
    return;
  }

  try {
    const result = await runScan({ source, minScore, maxOpportunities });
    res.json({ status: 'completed', result });
  } catch (error) {
    logger.error('Scan API error', { error: (error as Error).message });
    res.status(500).json({ status: 'failed', error: (error as Error).message });
  }
});

/** List opportunities */
app.get('/opportunities', readLimiter, ...protect, async (req, res) => {
  try {
    const opps = await listOpportunities({
      status: req.query.status as string | undefined,
      minScore: req.query.minScore ? parseInt(req.query.minScore as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
    });
    res.json({ count: opps.length, opportunities: opps });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Get single opportunity */
app.get('/opportunities/:id', readLimiter, ...protect, async (req, res) => {
  try {
    const opp = await getOpportunity(req.params.id);
    if (!opp) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(opp);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Update status */
app.patch('/opportunities/:id', readLimiter, ...protect, async (req, res) => {
  const { status, reviewNotes } = req.body as { status?: string; reviewNotes?: string };

  if (status && !['detected', 'reviewed', 'building', 'launched', 'killed'].includes(status)) {
    res.status(400).json({ error: 'Invalid status' });
    return;
  }

  try {
    const updated = await prisma.opportunity.update({
      where: { opportunityId: req.params.id },
      data: {
        ...(status && { status }),
        ...(status === 'reviewed' && { reviewedAt: new Date() }),
        ...(reviewNotes !== undefined && { reviewNotes }),
      },
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Recent scan runs */
app.get('/scans/recent', readLimiter, ...protect, async (req, res) => {
  try {
    const limit = parseInt((req.query.limit as string) || '10', 10);
    const runs = await prisma.scanRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    res.json({ count: runs.length, runs });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Stats */
app.get('/stats', readLimiter, ...protect, async (_req, res) => {
  try {
    const [totalOpps, totalSignals, byStatus, byPriority] = await Promise.all([
      prisma.opportunity.count(),
      prisma.rawSignal.count(),
      prisma.opportunity.groupBy({ by: ['status'], _count: true }),
      prisma.opportunity.groupBy({ by: ['priority'], _count: true }),
    ]);
    res.json({ totalOpportunities: totalOpps, totalSignals, byStatus, byPriority });
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
// Bind to localhost only — only Caddy on the same machine reaches us
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  logger.info(`🚀 Opportunity Detector API running on ${HOST}:${PORT}`);
  logger.info(`   Environment: ${ENVIRONMENT}`);
  logger.info(`   IP allowlist: ${IP_ALLOWLIST.length} ranges configured`);
  logger.info(`   HMAC auth: enabled`);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await prisma.$disconnect();
  process.exit(0);
});
