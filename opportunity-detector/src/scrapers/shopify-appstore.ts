import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as cheerio from 'cheerio';
import axios from 'axios';
import pLimit from 'p-limit';
import { logger } from '../utils/logger';
import type { RawSignal } from '../utils/types';

interface ShopifyReview {
  appName: string;
  appUrl: string;
  rating: number;
  body: string;
  date: string;
  reviewerName: string;
  reviewUrl: string;
  appCategory?: string;
  appOverallRating?: number;
  appReviewCount?: number;
}

const APPSTORE_BASE = 'https://apps.shopify.com';
const SITEMAP_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export class ShopifyAppStoreScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
    });
    logger.info('Shopify App Store scraper initialized');
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private async setupStealth(page: Page): Promise<void> {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      (globalThis as unknown as Record<string, unknown>).chrome = { runtime: {} };
    });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    // Block resource types that trigger fingerprinting or waste bandwidth
    await page.route(
      /\.(png|jpg|gif|svg|woff2?|ttf|eot|ico)(\?.*)?$/,
      (route) => route.abort()
    );
    await page.route('**/google-analytics.com/**', (route) => route.abort());
    await page.route('**/analytics.shopify.com/**', (route) => route.abort());
    await page.route('**/cdn-cgi/rum**', (route) => route.abort());
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: Error = new Error('Unknown error');
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        if (i < attempts - 1) {
          const delayMs = Math.pow(2, i + 1) * 1000; // 2s → 4s → 8s
          logger.warn(`Attempt ${i + 1}/${attempts} failed, retrying in ${delayMs}ms`, {
            error: lastError.message,
          });
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          logger.warn(`Attempt ${i + 1}/${attempts} failed (no more retries)`, {
            error: lastError.message,
          });
        }
      }
    }
    throw lastError;
  }

  private async isCloudflareChallenge(page: Page): Promise<boolean> {
    if (page.url().includes('/cdn-cgi/')) return true;
    const el = await page.$('[id="cf-challenge-running"]').catch(() => null);
    return el !== null;
  }

  private async fetchSitemapUrls(): Promise<string[]> {
    const { data: indexXml } = await axios.get<string>(`${APPSTORE_BASE}/sitemap.xml`, {
      headers: { 'User-Agent': SITEMAP_UA },
      timeout: 30000,
    });

    const $index = cheerio.load(indexXml, { xmlMode: true });

    // Check if this is a sitemap index (has sub-sitemaps) or a flat urlset
    const subUrls: string[] = [];
    $index('loc').each((_, el) => {
      const url = $index(el).text().trim();
      if (url.includes('sitemap-apps')) subUrls.push(url);
    });

    // Flat urlset: parse slugs directly from this document
    if (subUrls.length === 0) {
      logger.info('Sitemap is a flat urlset — parsing slugs directly');
      const slugs: string[] = [];
      $index('loc').each((_, el) => {
        const loc = $index(el).text().trim();
        const match = loc.match(/^https:\/\/apps\.shopify\.com\/([^/?#]+)$/);
        if (match?.[1]) slugs.push(match[1]);
      });
      return slugs;
    }

    logger.info(`Sitemap index has ${subUrls.length} sub-sitemaps`);

    const limit = pLimit(5);
    const slugBatches = await Promise.all(
      subUrls.map((url) =>
        limit(async () => {
          const { data: xml } = await axios.get<string>(url, {
            headers: { 'User-Agent': SITEMAP_UA },
            timeout: 30000,
          });
          const $sub = cheerio.load(xml, { xmlMode: true });
          const slugs: string[] = [];
          $sub('loc').each((_, el) => {
            const loc = $sub(el).text().trim();
            const match = loc.match(/^https:\/\/apps\.shopify\.com\/([^/?#]+)$/);
            if (match?.[1]) slugs.push(match[1]);
          });
          return slugs;
        })
      )
    );

    return slugBatches.flat();
  }

  async discoverAppsFromSitemap(): Promise<string[]> {
    logger.info('Discovering apps via sitemap...');
    const slugs = await this.fetchSitemapUrls();
    logger.info(`Sitemap discovery: ${slugs.length} apps found`);
    // Shuffle so each run samples different apps
    return slugs.sort(() => Math.random() - 0.5);
  }

  async scrapeNegativeReviews(
    slugs: string[],
    maxApps: number,
    maxReviewsPerApp: number
  ): Promise<RawSignal[]> {
    const signals: RawSignal[] = [];
    const limit = pLimit(2);
    let appsWithReviews = 0;

    const tasks = slugs.map((slug) =>
      limit(async () => {
        if (appsWithReviews >= maxApps) return;
        try {
          const reviews = await this.scrapeAppReviews(slug, maxReviewsPerApp);
          if (reviews.length === 0) return;
          appsWithReviews++;
          logger.info(
            `${slug}: ${reviews.length} reviews (${appsWithReviews}/${maxApps} apps)`
          );
          for (const review of reviews) {
            signals.push({
              source: 'shopify_appstore',
              sourceUrl: review.reviewUrl,
              signalType: 'negative_review',
              title: `Review of ${review.appName}`,
              content: review.body,
              metadata: {
                appName: review.appName,
                appUrl: review.appUrl,
                rating: review.rating,
                date: review.date,
                reviewerName: review.reviewerName,
                ...(review.appCategory && { appCategory: review.appCategory }),
                ...(review.appOverallRating !== undefined && {
                  appOverallRating: review.appOverallRating,
                }),
                ...(review.appReviewCount !== undefined && {
                  appReviewCount: review.appReviewCount,
                }),
              },
            });
          }
        } catch (err) {
          logger.warn(`Failed to scrape ${slug}`, { error: (err as Error).message });
        }
      })
    );

    await Promise.all(tasks);
    return signals;
  }

  private async scrapeAppReviews(slug: string, maxReviews: number): Promise<ShopifyReview[]> {
    if (!this.context) throw new Error('Scraper not initialized');

    return this.withRetry(async () => {
      const page = await this.context!.newPage();
      const reviews: ShopifyReview[] = [];
      const intercepted: ShopifyReview[] = [];
      let appName = slug;
      let appOverallRating: number | undefined;
      let appReviewCount: number | undefined;
      let appCategory: string | undefined;

      try {
        await this.setupStealth(page);

        // Intercept internal JSON responses that contain review data
        page.on('response', async (response) => {
          if (
            !response.url().includes('review') &&
            !response.url().includes('/api/')
          ) return;
          try {
            const json = await response.json() as Record<string, unknown>;
            const reviewArr =
              (json?.reviews as unknown[]) ??
              ((json?.data as Record<string, unknown>)?.reviews as unknown[]);
            if (!Array.isArray(reviewArr)) return;
            for (const r of reviewArr as Record<string, unknown>[]) {
              if (typeof r.body !== 'string' || r.body.length < 30) continue;
              if (typeof r.rating === 'number' && (r.rating < 1 || r.rating > 3)) continue;
              intercepted.push({
                appName,
                appUrl: `${APPSTORE_BASE}/${slug}`,
                rating: typeof r.rating === 'number' ? r.rating : 0,
                body: r.body.substring(0, 2000),
                date: typeof r.created_at === 'string' ? r.created_at : '',
                reviewerName: typeof r.author === 'string' ? r.author : 'Anonymous',
                reviewUrl: `${APPSTORE_BASE}/${slug}/reviews#intercepted-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              });
            }
          } catch {
            // Not a JSON response — ignore
          }
        });

        // Jitter before first navigation
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 4000));

        let pageNum = 1;
        const maxPages = 5;

        while (reviews.length < maxReviews && pageNum <= maxPages) {
          const url =
            `${APPSTORE_BASE}/${slug}/reviews` +
            `?ratings%5B%5D=1&ratings%5B%5D=2&ratings%5B%5D=3&sort_by=recency&page=${pageNum}`;

          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

          if (await this.isCloudflareChallenge(page)) {
            const waitMs = 15000 + Math.random() * 15000;
            logger.warn(
              `Cloudflare challenge on ${slug}, waiting ${Math.round(waitMs / 1000)}s`
            );
            await new Promise((r) => setTimeout(r, waitMs));
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          }

          await page.waitForTimeout(2000);

          // Drain intercepted buffer first
          if (intercepted.length > 0) {
            reviews.push(...intercepted.splice(0, intercepted.length));
          } else {
            // DOM fallback
            const html = await page.content();
            const $ = cheerio.load(html);

            // Extract app-level metadata on first page only
            if (pageNum === 1) {
              const h1 = $('h1').first().text().trim();
              if (h1) appName = h1;

              const ratingLabel = $('[aria-label*="out of 5"]').first().attr('aria-label');
              const ratingM = ratingLabel?.match(/^([\d.]+)/);
              if (ratingM) appOverallRating = parseFloat(ratingM[1]!);

              const countText = $('h2, h3')
                .filter((_, el) => $(el).text().toLowerCase().includes('review'))
                .first()
                .text();
              const countM = countText.match(/([\d,]+)\s+review/i);
              if (countM) appReviewCount = parseInt(countM[1]!.replace(/,/g, ''), 10);

              // Breadcrumb category
              const crumbLinks = $('[aria-label="breadcrumb"] a, nav a').toArray();
              const lastCrumb = crumbLinks
                .map((el) => $(el).text().trim())
                .filter((t) => t && !t.toLowerCase().includes('shopify'))
                .pop();
              if (lastCrumb) appCategory = lastCrumb;
            }

            // Primary selector: [data-merchant-review]
            $('[data-merchant-review]').each((i, el) => {
              if (reviews.length >= maxReviews) return false as unknown as void;
              const $el = $(el);

              const ariaLabel = $el.find('[aria-label*="out of 5"]').attr('aria-label');
              const ratingM = ariaLabel?.match(/^(\d)/);
              const rating = ratingM ? parseInt(ratingM[1]!, 10) : 0;
              if (rating < 1 || rating > 3) return;

              const body = $el
                .find('p')
                .filter((_, p) => $(p).text().trim().length > 30)
                .first()
                .text()
                .trim();
              if (body.length < 30) return;

              const reviewerName =
                $el.find('[itemprop="author"]').text().trim() ||
                $el.find('[class*="author"]').first().text().trim() ||
                'Anonymous';
              const date =
                $el.find('time').attr('datetime') ||
                $el.find('time').text().trim() ||
                '';

              reviews.push({
                appName,
                appUrl: `${APPSTORE_BASE}/${slug}`,
                rating,
                body: body.substring(0, 2000),
                date,
                reviewerName,
                reviewUrl: `${APPSTORE_BASE}/${slug}/reviews#${pageNum}-${i}-${date}`,
                appCategory,
                appOverallRating,
                appReviewCount,
              });
            });

            // Fallback: article elements if data-merchant-review yields nothing on page 1
            if (reviews.length === 0 && pageNum === 1) {
              $('article').each((i, el) => {
                if (reviews.length >= maxReviews) return false as unknown as void;
                const $el = $(el);

                const ariaLabel = $el.find('[aria-label*="out of 5"]').attr('aria-label');
                const ratingM = ariaLabel?.match(/^(\d)/);
                const rating = ratingM ? parseInt(ratingM[1]!, 10) : 0;
                if (rating < 1 || rating > 3) return;

                const body = $el
                  .find('p')
                  .filter((_, p) => $(p).text().trim().length > 30)
                  .first()
                  .text()
                  .trim();
                if (body.length < 30) return;

                const date = $el.find('time').attr('datetime') || '';
                reviews.push({
                  appName,
                  appUrl: `${APPSTORE_BASE}/${slug}`,
                  rating,
                  body: body.substring(0, 2000),
                  date,
                  reviewerName:
                    $el.find('[class*="author"]').first().text().trim() || 'Anonymous',
                  reviewUrl: `${APPSTORE_BASE}/${slug}/reviews#${pageNum}-${i}-${date}`,
                  appCategory,
                  appOverallRating,
                  appReviewCount,
                });
              });
            }
          }

          // Check for next page link
          const nextBtn = await page
            .$('a[aria-label="Next"], a[aria-label*="next" i], [data-next-page]')
            .catch(() => null);
          if (!nextBtn) break;
          pageNum++;
        }

        // Drain any reviews intercepted after the last per-page drain
        if (intercepted.length > 0) {
          reviews.push(...intercepted.splice(0, intercepted.length));
        }

        return reviews;
      } finally {
        await page.close();
      }
    });
  }
}

export async function scrapeShopifyAppStore(
  maxApps = 500,
  maxReviewsPerApp = 100
): Promise<RawSignal[]> {
  const scraper = new ShopifyAppStoreScraper();
  try {
    await scraper.init();
    logger.info('Discovering Shopify apps via sitemap...');
    const slugs = await scraper.discoverAppsFromSitemap();
    logger.info(`Processing up to ${maxApps} apps with negative reviews...`);
    const signals = await scraper.scrapeNegativeReviews(slugs, maxApps, maxReviewsPerApp);
    logger.info(`Scraped ${signals.length} negative review signals`);
    return signals;
  } finally {
    await scraper.close();
  }
}
