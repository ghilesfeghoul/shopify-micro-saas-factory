# Shopify App Store Scraper — Premium Rewrite Design

**Date:** 2026-04-26  
**File:** `src/scrapers/shopify-appstore.ts`  
**Status:** Approved, pending implementation

---

## Problem

The current scraper returns 0 signals on every run because:
1. Category pages don't render rating/review data in the HTML patterns the regexes expect
2. The review scraper uses generic selectors (`[class*="review"]`) that don't match Shopify's actual DOM
3. There is no pagination — only the first page of each category is ever seen
4. No stealth measures — Playwright's default fingerprint triggers Cloudflare detection

---

## Core Strategy

**Two distinct phases with different tools:**

1. **Discovery via sitemap.xml** — plain axios HTTP calls, no browser. `sitemap.xml` is public and intended for crawlers (search engines use it). Gets the complete list of all apps on the store, not just what appears on category pages.

2. **Review scraping via Playwright** — stealth browser only for review pages, where JS rendering is required. Network interception as primary extraction method, DOM parsing as fallback.

---

## Phase 1 — Discovery via Sitemap

No Playwright involved. Pure axios + XML parsing.

```
GET https://apps.shopify.com/sitemap.xml
  → parse sitemap index → N sub-sitemap URLs (e.g. sitemap-apps-1.xml, sitemap-apps-2.xml, ...)
  → fetch each sub-sitemap in parallel (pLimit(5), fine for static XML)
  → extract all <loc> URLs that match https://apps.shopify.com/{slug} pattern
  → result: complete list of all app slugs on the store
```

**Why this is better than category crawling:**
- Single axios call for discovery — no browser, no pagination, no JS rendering
- Gets every app on the store, not just what appears in category UI
- Standard, expected crawler behavior — Shopify publishes this for indexing
- Won't break on Shopify UI redesigns
- Takes seconds instead of minutes

**Category metadata:** We no longer get category at discovery time. Category is extracted from the app's review page metadata during Phase 2 (it appears in breadcrumbs or page meta). If unavailable, `category` field is omitted from metadata.

**Volume:** Shopify App Store has ~10,000+ apps. We don't visit all of them — we shuffle the list and process apps until we reach `maxApps` (default 100) that have at least one 1–3 star review.

---

## Phase 2 — Review Scraping (Playwright + Stealth)

For each app slug, navigate to:
```
https://apps.shopify.com/{slug}/reviews?ratings[]=1&ratings[]=2&ratings[]=3&sort_by=recency
```

If the page shows 0 reviews for this filter, skip the app and move to the next one. This naturally filters to only apps with actual negative reviews — no separate "get overall rating" step needed.

### Stealth Setup (per page, no new npm packages)

- `page.addInitScript()` runs before page JS: deletes `navigator.webdriver`, spoofs `navigator.plugins`, masks Chrome automation signals
- User agent: realistic Chrome on macOS, fixed per browser session
- Viewport: `1440 × 900`, locale `en-US`
- Route interception: block images, fonts, Google Analytics, Shopify tracking pixels
- Random jitter delay `2–6s` between top-level page navigations

### Retry Logic

- 3 attempts per page, exponential backoff: 2s → 4s → 8s
- Cloudflare detection: check for `cf-challenge-running` element or `/cdn-cgi/` redirect → wait 15–30s (random jitter) before retry

### Extraction (JSON interception → DOM fallback)

**JSON interception:** Capture `page.on('response', ...)` for responses containing a `reviews` array with fields: `body`, `rating`, `author`, `created_at`.

**DOM fallback selectors (semantic, ordered by specificity):**
- Review containers: `[data-merchant-review]` → fallback `article` elements within reviews section
- Rating: `[aria-label*="out of 5"]` on the star component
- Body: first `<p>` inside container with `length > 30`
- Author: `[itemprop="author"]` → fallback `[class*="author"]`
- Date: `<time datetime="...">` attribute value
- Overall app rating: `[class*="AppRating"] [aria-label]` or breadcrumb metadata

**Pagination:** Follow next page until `maxReviewsPerApp` reached (default 20). Hard cap: 5 pages per app.

### Ranking

After collecting reviews, we rank apps by number of negative reviews found (descending). More negative reviews = more merchant pain = more signal value. No separate rating-based sort needed — the review filter already selects for unhappy merchants.

---

## Output Contract

`RawSignal[]` — identical shape to today. Zero changes to downstream code.

```typescript
{
  source: 'shopify_appstore',
  sourceUrl: string,           // https://apps.shopify.com/{slug}/reviews#{index}-{date}
  signalType: 'negative_review',
  title: string,               // "Review of {appName}"
  content: string,             // review body, max 2000 chars
  metadata: {
    appName: string,
    appUrl: string,
    rating: number,            // 1, 2, or 3
    date: string,
    reviewerName: string,
    appCategory?: string,      // optional, extracted from page if available
    appOverallRating?: number, // optional, extracted from page if available
    appReviewCount?: number,   // optional, extracted from page if available
  }
}
```

---

## Method Map (current → new)

| Current | New | Change |
|---|---|---|
| `findStrugglingApps()` | `discoverAppsFromSitemap()` | Replaced: axios sitemap crawl, no Playwright |
| `scrapeCategoryPage()` | _(removed)_ | No longer needed |
| `scrapeAppReviews()` | `scrapeAppReviews()` | Interception + DOM fallback + pagination |
| — | `fetchSitemapUrls()` | New: fetches + parses sitemap index + sub-sitemaps |
| — | `setupStealth(page)` | New: stealth init per page |
| — | `withRetry(fn)` | New: 3-attempt retry with backoff |
| — | `isCloudflareChallenge(page)` | New: CF detection guard |
| `scrapeNegativeReviews()` | `scrapeNegativeReviews()` | Unchanged signature |
| `scrapeShopifyAppStore()` | `scrapeShopifyAppStore()` | Signature unchanged |

---

## What Is NOT Changing

- No new npm packages (axios and playwright already installed)
- `RawSignal` type shape unchanged
- `scrapeShopifyAppStore()` factory function signature unchanged
- `pLimit(2)` concurrency for browser work preserved
- All other scrapers untouched
