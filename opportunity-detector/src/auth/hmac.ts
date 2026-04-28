import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * HMAC-based webhook authentication.
 *
 * Threat model addressed:
 * - Secret leak via logs/network: signature is per-request, never the secret itself
 * - Replay attacks: timestamp window + nonce store
 * - Payload tampering: signature covers method + path + body + timestamp
 * - Timing attacks: timingSafeEqual for constant-time comparison
 *
 * Trade-offs:
 * - Nonce store is in-memory (Map), so it resets on restart. For multi-instance
 *   deployments, replace with Redis. For our single-instance case, this is fine.
 */

interface NonceEntry {
  expiresAt: number;
}

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes
const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes (longer than timestamp tolerance for safety)

// In-memory nonce store with periodic cleanup
const nonceStore = new Map<string, NonceEntry>();
setInterval(() => {
  const now = Date.now();
  for (const [nonce, entry] of nonceStore.entries()) {
    if (entry.expiresAt < now) nonceStore.delete(nonce);
  }
}, 60 * 1000); // cleanup every minute

/**
 * Generate the canonical string to sign.
 * Format: METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256
 */
function buildSigningString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

function sha256(content: string): string {
  return createHmac('sha256', '').update(content).digest('hex');
}

function signHmac(secret: string, content: string): string {
  return createHmac('sha256', secret).update(content).digest('hex');
}

/**
 * Express middleware that verifies HMAC signature.
 * Expects these headers:
 * - X-Signature-Timestamp: unix ms when the request was signed
 * - X-Signature-Nonce: random 32-char hex string, unique per request
 * - X-Signature: hex HMAC-SHA256 of the canonical string
 */
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

    // 1. Validate timestamp window (prevents replay of old captures)
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) {
      res.status(401).json({ error: 'Invalid timestamp' });
      return;
    }
    const drift = Math.abs(Date.now() - ts);
    if (drift > TIMESTAMP_TOLERANCE_MS) {
      logger.warn('HMAC: timestamp out of window', { ip: req.ip, drift });
      res.status(401).json({ error: 'Request timestamp out of acceptable window' });
      return;
    }

    // 2. Validate nonce format (32 hex chars = 128 bits of entropy)
    if (!/^[a-f0-9]{32}$/.test(nonce)) {
      res.status(401).json({ error: 'Invalid nonce format' });
      return;
    }

    // 3. Check nonce hasn't been used (prevents replay within window)
    if (nonceStore.has(nonce)) {
      logger.warn('HMAC: nonce reuse detected (replay attempt?)', { ip: req.ip, nonce });
      res.status(401).json({ error: 'Nonce already used' });
      return;
    }

    // 4. Validate signature format
    if (!/^[a-f0-9]{64}$/.test(signature)) {
      res.status(401).json({ error: 'Invalid signature format' });
      return;
    }

    // 5. Reconstruct the signed content and compare
    // Note: req.rawBody must be set by a body-parser config (see server.ts)
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
    const bodyHash = sha256(rawBody);
    const expectedString = buildSigningString(req.method, req.path, timestamp, nonce, bodyHash);
    const expectedSig = signHmac(secret, expectedString);

    // Constant-time comparison
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      logger.warn('HMAC: signature mismatch', { ip: req.ip, path: req.path });
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // 6. Mark nonce as used
    nonceStore.set(nonce, { expiresAt: Date.now() + NONCE_TTL_MS });

    next();
  };
}

/**
 * Helper for n8n: generate signature headers for a request.
 * Use this in n8n's "Function" node before HTTP Request.
 *
 * Example n8n Function code:
 *   const { generateSignature } = require('./signing');
 *   const headers = generateSignature(secret, 'POST', '/scan', JSON.stringify($json));
 *   return [{ json: { headers, body: $json } }];
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
