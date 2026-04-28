# Shopify App Store Scraper Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `src/scrapers/shopify-appstore.ts` so it reliably produces negative-review signals from the Shopify App Store, fixing the current 0-signal failure.

**Architecture:** Two-phase approach — sitemap-based discovery via plain axios (no browser, no pagination needed), then Playwright-only for review pages with network-interception-first extraction and semantic DOM as fallback. Stealth setup, retry logic, and Cloudflare detection are added as private helpers.

**Tech Stack:** TypeScript, Playwright (already installed), axios (already installed), cheerio (already installed, used for both HTML and XML parsing), pLimit (already installed). No new packages.

---

## File Structure

**Modified:** `src/scrapers/shopify-appstore.ts` — complete rewrite in-place.

No other files are changed. `RawSignal` shape, `scrapeShopifyAppStore()` exported function signature, and all downstream code remain identical.

---

### Task 1: Sitemap Discovery — `fetchSitemapUrls()` + `discoverAppsFromSitemap()`

Replace `findStrugglingApps()` and `scrapeCategoryPage()` with two new methods that discover apps via the sitemap instead of browser-based category crawling.

**Files:**
- Modify: `src/scrapers/shopify-appstore.ts`

- [ ] **Step 1: Replace the file header — remove `CATEGORIES` constant and `ShopifyApp` interface, update `ShopifyReview` interface**

Replace the top of the file (lines 1–37 of the current file) with this:

```typescript
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
```

- [ ] **Step 2: Update the class declaration — add `context` field, update `init()` and `close()`**

Replace the `ShopifyAppStoreScraper` class open, `browser` field, `init()`, and `close()` with:

```typescript
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
```

- [ ] **Step 3: Add `fetchSitemapUrls()` private method**

```typescript
  private async fetchSitemapUrls(): Promise<string[]> {
    const { data: indexXml } = await axios.get<string>(`${APPSTORE_BASE}/sitemap.xml`, {
      headers: { 'User-Agent': SITEMAP_UA },
      timeout: 30000,
    });

    const $index = cheerio.load(indexXml, { xmlMode: true });
    const subUrls: string[] = [];
    $index('loc').each((_, el) => {
      const url = $index(el).text().trim();
      if (url.includes('sitemap-apps')) subUrls.push(url);
    });

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
```

- [ ] **Step 4: Add `discoverAppsFromSitemap()` method**

```typescript
  async discoverAppsFromSitemap(): Promise<string[]> {
    logger.info('Discovering apps via sitemap...');
    const slugs = await this.fetchSitemapUrls();
    logger.info(`Sitemap discovery: ${slugs.length} apps found`);
    // Shuffle so each run samples different apps
    return slugs.sort(() => Math.random() - 0.5);
  }
```

- [ ] **Step 5: Smoke-test sitemap discovery in isolation**

Add a temporary `main()` call at the bottom of the file (remove before commit):

```typescript
// TEMP: remove before commit
(async () => {
  const s = new ShopifyAppStoreScraper();
  await s.init();
  const slugs = await s.discoverAppsFromSitemap();
  console.log(`Got ${slugs.length} slugs. First 5:`, slugs.slice(0, 5));
  await s.close();
})().catch(console.error);
```

Run: `npx tsx src/scrapers/shopify-appstore.ts`

Expected output:
```
Sitemap index has N sub-sitemaps (N should be > 0)
Sitemap discovery: NNNN apps found (should be 5000+)
Got NNNN slugs. First 5: [ 'some-app', ... ]
```

- [ ] **Step 6: Remove the temporary `main()` call**

- [ ] **Step 7: Commit**

```bash
git add src/scrapers/shopify-appstore.ts
git commit -m "feat: replace category crawling with sitemap-based app discovery"
```

---

### Task 2: Stealth Helpers — `setupStealth()`, `withRetry()`, `isCloudflareChallenge()`

Add three private methods before `discoverAppsFromSitemap`. These are used by `scrapeAppReviews` in Task 3.

**Files:**
- Modify: `src/scrapers/shopify-appstore.ts`

- [ ] **Step 1: Add `setupStealth()` private method**

Insert after the `close()` method:

```typescript
  private async setupStealth(page: Page): Promise<void> {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      (window as unknown as Record<string, unknown>).chrome = { runtime: {} };
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
```

- [ ] **Step 2: Add `withRetry()` private method**

```typescript
  private async withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: Error = new Error('Unknown error');
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        const delayMs = Math.pow(2, i + 1) * 1000; // 2s → 4s → 8s
        logger.warn(`Attempt ${i + 1}/${attempts} failed, retrying in ${delayMs}ms`, {
          error: lastError.message,
        });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastError;
  }
```

- [ ] **Step 3: Add `isCloudflareChallenge()` private method**

```typescript
  private async isCloudflareChallenge(page: Page): Promise<boolean> {
    if (page.url().includes('/cdn-cgi/')) return true;
    const el = await page.$('[id="cf-challenge-running"]').catch(() => null);
    return el !== null;
  }
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors related to `shopify-appstore.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/scrapers/shopify-appstore.ts
git commit -m "feat: add stealth setup, retry, and Cloudflare detection helpers"
```

---

### Task 3: Review Scraping — rewrite `scrapeAppReviews()`

Replace the old `scrapeAppReviews(app: ShopifyApp, ...)` with `scrapeAppReviews(slug: string, ...)`. This version:
- Intercepts JSON responses from the page (Next.js internal API calls)
- Falls back to semantic DOM selectors if interception yields nothing
- Paginates up to 5 pages
- Retries with Cloudflare detection

**Files:**
- Modify: `src/scrapers/shopify-appstore.ts`

- [ ] **Step 1: Delete the old `scrapeCategoryPage()` and `scrapeAppReviews()` methods, add the new `scrapeAppReviews()`**

```typescript
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
              intercepted.push({
                appName,
                appUrl: `${APPSTORE_BASE}/${slug}`,
                rating: typeof r.rating === 'number' ? r.rating : 0,
                body: r.body.substring(0, 2000),
                date: typeof r.created_at === 'string' ? r.created_at : '',
                reviewerName: typeof r.author === 'string' ? r.author : 'Anonymous',
                reviewUrl: '',
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

          // Drain intercepted buffer
          if (intercepted.length > 0) {
            reviews.push(...intercepted.splice(0, intercepted.length));
          } else {
            // DOM fallback
            const html = await page.content();
            const $ = cheerio.load(html);

            // Extract app-level metadata (best-effort)
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

              // Breadcrumb category (last breadcrumb link that isn't the store name)
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
                reviewUrl: `${APPSTORE_BASE}/${slug}/reviews#${i}-${date}`,
                appCategory,
                appOverallRating,
                appReviewCount,
              });
            });

            // Fallback: article elements (if Shopify removes data-merchant-review)
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
                  reviewUrl: `${APPSTORE_BASE}/${slug}/reviews#${i}-${date}`,
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

        return reviews;
      } finally {
        await page.close();
      }
    });
  }
```

- [ ] **Step 2: Smoke-test `scrapeAppReviews` against a known app with negative reviews**

Add a temporary main (remove before commit):

```typescript
// TEMP: remove before commit
(async () => {
  const s = new ShopifyAppStoreScraper();
  await s.init();
  // Use a known app with negative reviews — e.g., 'privy-pop-ups-email-marketing'
  const reviews = await (s as unknown as Record<string, Function>)['scrapeAppReviews'](
    'privy-pop-ups-email-marketing',
    5
  );
  console.log(`Got ${reviews.length} reviews:`, JSON.stringify(reviews.slice(0, 2), null, 2));
  await s.close();
})().catch(console.error);
```

Run: `npx tsx src/scrapers/shopify-appstore.ts`

Expected: at least 1 review object with `rating` 1–3, `body` > 30 chars, `appName` populated.

- [ ] **Step 3: Remove the temporary main call**

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/scrapers/shopify-appstore.ts
git commit -m "feat: rewrite scrapeAppReviews with JSON interception, DOM fallback, pagination"
```

---

### Task 4: Wire Up — `scrapeNegativeReviews()` + `scrapeShopifyAppStore()`

Replace `scrapeNegativeReviews(apps: ShopifyApp[], ...)` with a slug-based version, and update `scrapeShopifyAppStore()` to use the new pipeline.

**Files:**
- Modify: `src/scrapers/shopify-appstore.ts`

- [ ] **Step 1: Replace `scrapeNegativeReviews()` with slug-based version**

Delete the old `scrapeNegativeReviews()` method and replace with:

```typescript
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
```

- [ ] **Step 2: Replace `scrapeShopifyAppStore()` exported function**

```typescript
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
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Run end-to-end smoke test with a tiny cap**

```bash
MAX_SIGNALS_PER_SCAN=5 npm run scan -- --source=appstore
```

Expected output (abbreviated):
```
Discovering Shopify apps via sitemap...
Sitemap index has N sub-sitemaps
Sitemap discovery: NNNN apps found
Processing up to 500 apps with negative reviews...
some-app: N reviews (1/500 apps)
...
Scraped N negative review signals
```

Then:
```bash
npm run list
```

Expected: entries with `source = shopify_appstore` and `signalType = negative_review` appear in the list. If you see `0 signals` in the scan output, re-read the scraper logs for which apps were visited and check the DOM fallback with `console.log(html.substring(0, 2000))` inside `scrapeAppReviews` to inspect what the page actually returned.

- [ ] **Step 5: Commit**

```bash
git add src/scrapers/shopify-appstore.ts
git commit -m "feat: wire up sitemap-based pipeline in scrapeNegativeReviews and scrapeShopifyAppStore"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Sitemap-based discovery, no browser | Task 1 |
| pLimit(5) for parallel sub-sitemap fetches | Task 1 (`fetchSitemapUrls`) |
| Shuffle slugs for random sampling | Task 1 (`discoverAppsFromSitemap`) |
| Browser context with UA + viewport + locale | Task 1 (`init`) |
| Stealth init script (webdriver, plugins, chrome) | Task 2 |
| Route blocking (images, GA, Shopify analytics) | Task 2 |
| 3-attempt retry with 2s/4s/8s backoff | Task 2 |
| Cloudflare detection + 15–30s wait | Task 3 |
| 2–6s jitter before first navigation | Task 3 |
| JSON interception via `page.on('response')` | Task 3 |
| DOM fallback: `[data-merchant-review]` | Task 3 |
| DOM fallback: `article` elements | Task 3 |
| Pagination: up to 5 pages, stop on no next-button | Task 3 |
| App-level metadata from review page | Task 3 |
| Skip apps with 0 matching reviews | Task 4 (`scrapeNegativeReviews`) |
| pLimit(2) for browser concurrency | Task 4 |
| `maxApps` cap on apps-with-reviews | Task 4 |
| `RawSignal[]` output shape unchanged | Task 4 |
| `scrapeShopifyAppStore()` signature unchanged | Task 4 |
| Category extracted from breadcrumb if available | Task 3 |

No spec requirements are missing.

**Placeholder scan:** No TBDs or "implement later" in this plan.

**Type consistency:**
- `ShopifyReview` defined in Task 1 header; all fields (`appName`, `appUrl`, `rating`, `body`, `date`, `reviewerName`, `reviewUrl`, `appCategory?`, `appOverallRating?`, `appReviewCount?`) used consistently in Task 3 and Task 4.
- `discoverAppsFromSitemap()` returns `string[]`; consumed by `scrapeNegativeReviews(slugs: string[], ...)` in Task 4. ✓
- `scrapeAppReviews(slug: string, maxReviews: number)` called with `string` in Task 4. ✓
