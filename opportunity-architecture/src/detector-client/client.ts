import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from '../utils/logger';
import { generateSignature } from '../auth/hmac';
import { OpportunityFromDetectorSchema, type OpportunityFromDetector } from '../utils/types';

interface DetectorClientOptions {
  baseUrl: string;
  hmacSecret: string;
  timeoutMs?: number;
}

/**
 * HTTP client for the opportunity-detector API.
 * Handles HMAC signing transparently.
 */
export class DetectorClient {
  private http: AxiosInstance;
  private hmacSecret: string;

  constructor(opts: DetectorClientOptions) {
    if (!opts.baseUrl) throw new Error('DetectorClient: baseUrl required');
    if (!opts.hmacSecret || opts.hmacSecret.length < 32) {
      throw new Error('DetectorClient: hmacSecret must be at least 32 characters');
    }

    this.hmacSecret = opts.hmacSecret;
    this.http = axios.create({
      baseURL: opts.baseUrl.replace(/\/$/, ''),
      timeout: opts.timeoutMs ?? 30_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Health check (no auth required).
   */
  async health(): Promise<{ status: string; timestamp: string }> {
    const { data } = await this.http.get('/health');
    return data;
  }

  /**
   * List opportunities from the detector.
   * @param filter Optional filtering options
   */
  async listOpportunities(filter: {
    status?: string;
    minScore?: number;
    limit?: number;
  } = {}): Promise<OpportunityFromDetector[]> {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.minScore !== undefined) params.set('minScore', filter.minScore.toString());
    if (filter.limit !== undefined) params.set('limit', filter.limit.toString());

    const path = `/opportunities${params.toString() ? '?' + params.toString() : ''}`;
    const headers = generateSignature(this.hmacSecret, 'GET', '/opportunities', '');

    try {
      const { data } = await this.http.get(path, { headers });
      const raw = data.opportunities as unknown[];

      const validated: OpportunityFromDetector[] = [];
      for (const item of raw) {
        const parsed = OpportunityFromDetectorSchema.safeParse(item);
        if (parsed.success) {
          validated.push(parsed.data);
        } else {
          logger.warn('Detector returned malformed opportunity', { errors: parsed.error.issues });
        }
      }
      return validated;
    } catch (error) {
      this.handleAxiosError(error, 'listOpportunities');
      throw error;
    }
  }

  /**
   * Fetch a single opportunity by its OPP-XXXX ID.
   */
  async getOpportunity(opportunityId: string): Promise<OpportunityFromDetector | null> {
    const path = `/opportunities/${opportunityId}`;
    const headers = generateSignature(this.hmacSecret, 'GET', path, '');

    try {
      const { data } = await this.http.get(path, { headers });
      const parsed = OpportunityFromDetectorSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn('Detector returned malformed opportunity', { errors: parsed.error.issues });
        return null;
      }
      return parsed.data;
    } catch (error) {
      if ((error as AxiosError).response?.status === 404) return null;
      this.handleAxiosError(error, 'getOpportunity');
      throw error;
    }
  }

  /**
   * Update an opportunity's status — used to mark "building" once a spec is approved.
   */
  async updateOpportunityStatus(
    opportunityId: string,
    update: { status?: string; reviewNotes?: string }
  ): Promise<void> {
    const path = `/opportunities/${opportunityId}`;
    const body = JSON.stringify(update);
    const headers = generateSignature(this.hmacSecret, 'PATCH', path, body);

    try {
      await this.http.patch(path, update, { headers });
    } catch (error) {
      this.handleAxiosError(error, 'updateOpportunityStatus');
      throw error;
    }
  }

  private handleAxiosError(error: unknown, context: string): void {
    const axiosError = error as AxiosError;
    if (axiosError.response) {
      logger.error(`DetectorClient ${context} failed`, {
        status: axiosError.response.status,
        statusText: axiosError.response.statusText,
        data: axiosError.response.data,
      });
    } else if (axiosError.request) {
      logger.error(`DetectorClient ${context}: no response (network error)`, {
        message: axiosError.message,
      });
    } else {
      logger.error(`DetectorClient ${context} error`, { message: axiosError.message });
    }
  }
}

/**
 * Singleton helper.
 */
let cachedClient: DetectorClient | null = null;
export function getDetectorClient(): DetectorClient {
  if (!cachedClient) {
    const baseUrl = process.env.DETECTOR_URL;
    const secret = process.env.DETECTOR_HMAC_SECRET || process.env.HMAC_SECRET;

    if (!baseUrl) throw new Error('DETECTOR_URL is required');
    if (!secret) throw new Error('DETECTOR_HMAC_SECRET (or HMAC_SECRET) is required');

    cachedClient = new DetectorClient({ baseUrl, hmacSecret: secret });
  }
  return cachedClient;
}
