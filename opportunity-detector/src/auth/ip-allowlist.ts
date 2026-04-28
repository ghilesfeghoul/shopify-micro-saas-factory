import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * IP allowlist middleware.
 * Supports CIDR notation via simple prefix matching for IPv4.
 *
 * For Tailscale, allow:
 * - 100.64.0.0/10 (Tailscale CGNAT range)
 * - Or specific n8n machine IP
 */

function ipMatchesCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr;

  const [network, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr!, 10);

  // IPv4 only for now
  const ipParts = ip.split('.').map(Number);
  const netParts = network!.split('.').map(Number);
  if (ipParts.length !== 4 || netParts.length !== 4) return false;

  const ipInt = (ipParts[0]! << 24) | (ipParts[1]! << 16) | (ipParts[2]! << 8) | ipParts[3]!;
  const netInt = (netParts[0]! << 24) | (netParts[1]! << 16) | (netParts[2]! << 8) | netParts[3]!;
  const mask = bits === 0 ? 0 : ~((1 << (32 - bits)) - 1);

  return (ipInt & mask) === (netInt & mask);
}

export function ipAllowlist(allowedRanges: string[]) {
  const cleanedRanges = allowedRanges.map((r) => r.trim()).filter(Boolean);

  if (cleanedRanges.length === 0) {
    logger.warn('IP allowlist is empty — refusing to start with permissive config');
    throw new Error('IP allowlist must not be empty');
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    // Get the real client IP. Trust proxy must be configured upstream.
    const ip = req.ip || req.socket.remoteAddress || '';

    // Strip IPv6-mapped IPv4 prefix if present
    const cleanIp = ip.replace(/^::ffff:/, '');

    const allowed = cleanedRanges.some((range) => ipMatchesCidr(cleanIp, range));
    if (!allowed) {
      logger.warn('IP allowlist: rejected', { ip: cleanIp, path: req.path });
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    next();
  };
}
