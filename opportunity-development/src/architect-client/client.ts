import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from '../utils/logger';
import { generateSignature } from '../auth/hmac';
import { TechnicalSpecMinimalSchema, type TechnicalSpec } from '../utils/types';

interface ArchitectClientOptions {
  baseUrl: string;
  hmacSecret: string;
  timeoutMs?: number;
}

/**
 * HTTP client for the opportunity-architecture API.
 * Handles HMAC signing transparently.
 */
export class ArchitectClient {
  private http: AxiosInstance;
  private hmacSecret: string;

  constructor(opts: ArchitectClientOptions) {
    if (!opts.baseUrl) throw new Error('ArchitectClient: baseUrl required');
    if (!opts.hmacSecret || opts.hmacSecret.length < 32) {
      throw new Error('ArchitectClient: hmacSecret must be at least 32 characters');
    }

    this.hmacSecret = opts.hmacSecret;
    this.http = axios.create({
      baseURL: opts.baseUrl.replace(/\/$/, ''),
      timeout: opts.timeoutMs ?? 60_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async health(): Promise<{ status: string; timestamp: string }> {
    const { data } = await this.http.get('/health');
    return data;
  }

  /**
   * Fetch a spec by its SPEC-XXXX ID.
   * Returns the full TechnicalSpec from the architect (validated minimally).
   */
  async getSpec(specId: string): Promise<{ meta: Record<string, unknown>; spec: TechnicalSpec } | null> {
    const path = `/specs/${specId}`;
    const headers = generateSignature(this.hmacSecret, 'GET', path, '');

    try {
      const { data } = await this.http.get(path, { headers });
      // The architect returns { meta, spec }
      const validated = TechnicalSpecMinimalSchema.safeParse(data.spec);
      if (!validated.success) {
        logger.warn('Architect returned spec failing minimal validation', {
          errors: validated.error.issues.slice(0, 3),
        });
        return null;
      }
      return { meta: data.meta, spec: validated.data };
    } catch (error) {
      if ((error as AxiosError).response?.status === 404) return null;
      this.handleAxiosError(error, 'getSpec');
      throw error;
    }
  }

  /**
   * List specs from the architect.
   */
  async listSpecs(filter: { status?: string; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.limit !== undefined) params.set('limit', filter.limit.toString());

    const path = `/specs${params.toString() ? '?' + params.toString() : ''}`;
    const headers = generateSignature(this.hmacSecret, 'GET', '/specs', '');

    try {
      const { data } = await this.http.get(path, { headers });
      return data.specs ?? [];
    } catch (error) {
      this.handleAxiosError(error, 'listSpecs');
      throw error;
    }
  }

  /**
   * Update a spec status (e.g., set to "building" once we start, "approved" once we finish).
   */
  async updateSpecStatus(specId: string, status: string, rejectionReason?: string): Promise<void> {
    const path = `/specs/${specId}`;
    const body = JSON.stringify({ status, ...(rejectionReason && { rejectionReason }) });
    const headers = generateSignature(this.hmacSecret, 'PATCH', path, body);

    try {
      await this.http.patch(path, JSON.parse(body), { headers });
    } catch (error) {
      this.handleAxiosError(error, 'updateSpecStatus');
      throw error;
    }
  }

  private handleAxiosError(error: unknown, context: string): void {
    const axiosError = error as AxiosError;
    if (axiosError.response) {
      logger.error(`ArchitectClient ${context} failed`, {
        status: axiosError.response.status,
        data: axiosError.response.data,
      });
    } else if (axiosError.request) {
      logger.error(`ArchitectClient ${context}: no response`, { message: axiosError.message });
    } else {
      logger.error(`ArchitectClient ${context} error`, { message: axiosError.message });
    }
  }
}

let cachedClient: ArchitectClient | null = null;
export function getArchitectClient(): ArchitectClient {
  if (!cachedClient) {
    const baseUrl = process.env.ARCHITECT_URL;
    const secret = process.env.ARCHITECT_HMAC_SECRET;

    if (!baseUrl) throw new Error('ARCHITECT_URL is required');
    if (!secret) throw new Error('ARCHITECT_HMAC_SECRET is required');

    cachedClient = new ArchitectClient({ baseUrl, hmacSecret: secret });
  }
  return cachedClient;
}
