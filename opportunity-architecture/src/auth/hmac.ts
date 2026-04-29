import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

interface NonceEntry {
  expiresAt: number;
}

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;

const nonceStore = new Map<string, NonceEntry>();
setInterval(() => {
  const now = Date.now();
  for (const [nonce, entry] of nonceStore.entries()) {
    if (entry.expiresAt < now) nonceStore.delete(nonce);
  }
}, 60 * 1000);

function buildSigningString(method: string, path: string, timestamp: string, nonce: string, bodyHash: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

function sha256(content: string): string {
  return createHmac('sha256', '').update(content).digest('hex');
}

function signHmac(secret: string, content: string): string {
  return createHmac('sha256', secret).update(content).digest('hex');
}

export function hmacAuth(secret: string) {
  if (!secret || secret.length < 32) {
    throw new Error('HMAC secret must be at least 32 characters');
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const timestamp = req.header('x-signature-timestamp');
    const nonce = req.header('x-signature-nonce');
    const signature = req.header('x-signature');

    if (!timestamp || !nonce || !signature) {
      logger.warn('HMAC: missing auth headers', { ip: req.ip, path: req.path });
      res.status(401).json({ error: 'Missing authentication headers' });
      return;
    }

    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) {
      res.status(401).json({ error: 'Invalid timestamp' });
      return;
    }
    if (Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS) {
      logger.warn('HMAC: timestamp out of window', { ip: req.ip });
      res.status(401).json({ error: 'Request timestamp out of acceptable window' });
      return;
    }

    if (!/^[a-f0-9]{32}$/.test(nonce)) {
      res.status(401).json({ error: 'Invalid nonce format' });
      return;
    }

    if (nonceStore.has(nonce)) {
      logger.warn('HMAC: nonce reuse', { ip: req.ip, nonce });
      res.status(401).json({ error: 'Nonce already used' });
      return;
    }

    if (!/^[a-f0-9]{64}$/.test(signature)) {
      res.status(401).json({ error: 'Invalid signature format' });
      return;
    }

    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
    const bodyHash = sha256(rawBody);
    const expectedString = buildSigningString(req.method, req.path, timestamp, nonce, bodyHash);
    const expectedSig = signHmac(secret, expectedString);

    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      logger.warn('HMAC: signature mismatch', { ip: req.ip, path: req.path });
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    nonceStore.set(nonce, { expiresAt: Date.now() + NONCE_TTL_MS });
    next();
  };
}

/**
 * Helper to generate signature headers — used both by the n8n script and
 * by the detector-client when calling the detector's API.
 */
export function generateSignature(
  secret: string,
  method: string,
  path: string,
  body: string
): { 'x-signature-timestamp': string; 'x-signature-nonce': string; 'x-signature': string } {
  const timestamp = Date.now().toString();
  const nonce = randomBytes(16).toString('hex');
  const bodyHash = sha256(body);
  const signingString = buildSigningString(method, path, timestamp, nonce, bodyHash);
  const signature = signHmac(secret, signingString);
  return {
    'x-signature-timestamp': timestamp,
    'x-signature-nonce': nonce,
    'x-signature': signature,
  };
}
