/**
 * Product Hunt Scraper
 *
 * Two strategies:
 *  1. Atom feeds  (no token) — 10 ecommerce-relevant categories × 50 entries each
 *  2. GraphQL API (PRODUCT_HUNT_TOKEN) — multiple topics with pagination, richer metadata
 *
 * Strategy 1 alone yields ~400 unique posts per run.
 * The current RSS fallback was broken (used <item> but PH uses Atom <entry>).
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';
import type { RawSignal } from '../utils/types';

// Categories that surface ecommerce / Shopify-adjacent tools and pain points.
// Each feed returns 50 unique entries with near-zero cross-category overlap.
const ATOM_CATEGORIES = [
  'shopify',
  'e-commerce',
  'marketing',
  'email-marketing',
  'sales',
  'customer-support',
  'analytics',
  'seo',
  'crm',
  'payments',
];

// Same topics for GraphQL when token is available
const GQL_TOPICS = [
  'shopify',
  'e-commerce',
  'marketing',
  'email-marketing',
  'sales',
  'customer-support',
  'analytics',
];

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

const PH_GRAPHQL = 'https://api.producthunt.com/v2/api/graphql';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Atom feed ────────────────────────────────────────────────────────────────

interface AtomEntry {
  id: string;       // numeric post ID
  title: string;
  url: string;
  publishedAt: string;
  tagline: string;
}

/** Extract the first paragraph text from HTML-encoded Atom <content> */
function extractTagline(html: string): string {
  const decoded = html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const $ = cheerio.load(decoded);
  return $('p').first().text().trim().substring(0, 300);
}

function parseAtomFeed(xml: string): AtomEntry[] {
  const entries: AtomEntry[] = [];
  const blocks = xml.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];

  for (const block of blocks) {
    const idMatch = block.match(/Post\/(\d+)/);
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link[^>]+href="([^"]+)"/);
    const publishedMatch = block.match(/<published>([\s\S]*?)<\/published>/);
    const contentMatch = block.match(/<content[^>]*>([\s\S]*?)<\/content>/);

    if (!idMatch || !titleMatch || !linkMatch) continue;

    entries.push({
      id: idMatch[1],
      title: titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/, '$1').trim(),
      url: linkMatch[1],
      publishedAt: publishedMatch?.[1]?.trim() ?? '',
      tagline: contentMatch ? extractTagline(contentMatch[1]) : '',
    });
  }

  return entries;
}

async function fetchAtomCategory(category: string): Promise<AtomEntry[]> {
  try {
    const { data } = await axios.get(
      `https://www.producthunt.com/feed?category=${category}`,
      { headers: BROWSER_HEADERS, timeout: 15000 }
    );
    const entries = parseAtomFeed(data);
    logger.info(`PH Atom: ${category} → ${entries.length} entries`);
    return entries;
  } catch (err) {
    logger.warn(`PH Atom: failed to fetch category "${category}"`, {
      error: (err as Error).message,
    });
    return [];
  }
}

// ─── GraphQL (with token) ──────────────────────────────────────────────────

interface GQLPost {
  id: string;
  name: string;
  tagline: string;
  description: string;
  url: string;
  votesCount: number;
  commentsCount: number;
  createdAt: string;
  topics: { edges: Array<{ node: { name: string } }> };
}

const GQL_QUERY = `
  query Posts($first: Int!, $topic: String!, $after: String) {
    posts(first: $first, topic: $topic, order: VOTES, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id name tagline description url
          votesCount commentsCount createdAt
          topics { edges { node { name } } }
        }
      }
    }
  }
`;

async function fetchGQLTopic(
  topic: string,
  token: string,
  perPage = 20,
  pages = 2
): Promise<GQLPost[]> {
  const posts: GQLPost[] = [];
  let after: string | null = null;

  for (let page = 0; page < pages; page++) {
    try {
      const response = await axios.post(
        PH_GRAPHQL,
        { query: GQL_QUERY, variables: { first: perPage, topic, after } },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = response.data?.data?.posts;
      const batch: GQLPost[] = result?.edges?.map((e: { node: GQLPost }) => e.node) ?? [];
      posts.push(...batch);

      if (!result?.pageInfo?.hasNextPage) break;
      after = result.pageInfo.endCursor;
      await sleep(500);
    } catch (err) {
      logger.warn(`PH GraphQL: failed to fetch topic "${topic}" page ${page}`, {
        error: (err as Error).message,
      });
      break;
    }
  }

  logger.info(`PH GraphQL: ${topic} → ${posts.length} posts`);
  return posts;
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function dedupById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function scrapeProductHunt(maxSignals = 150): Promise<RawSignal[]> {
  const token = process.env.PRODUCT_HUNT_TOKEN;
  const signals: RawSignal[] = [];

  if (token) {
    // ── GraphQL path: richer data, multiple topics, paginated ──────────────
    logger.info('PH: using GraphQL API');
    const allPosts: GQLPost[] = [];

    for (const topic of GQL_TOPICS) {
      const posts = await fetchGQLTopic(topic, token);
      allPosts.push(...posts);
      await sleep(600);
    }

    const unique = dedupById(allPosts);
    logger.info(`PH GraphQL: ${unique.length} unique posts after dedup`);

    for (const post of unique.slice(0, maxSignals)) {
      signals.push({
        source: 'producthunt',
        sourceUrl: post.url,
        signalType: 'product_launch',
        title: post.name,
        content: [post.tagline, post.description].filter(Boolean).join('\n\n').substring(0, 3000),
        metadata: {
          votesCount: post.votesCount,
          commentsCount: post.commentsCount,
          topics: post.topics.edges.map((e) => e.node.name),
          launchedAt: post.createdAt,
        },
      });
    }
  } else {
    // ── Atom feed path: no token, browser headers, 10 categories ──────────
    logger.info('PH: using Atom feeds (no token)');
    const allEntries: AtomEntry[] = [];

    for (const category of ATOM_CATEGORIES) {
      const entries = await fetchAtomCategory(category);
      allEntries.push(...entries);
      await sleep(600);
    }

    const unique = dedupById(allEntries);
    logger.info(`PH Atom: ${unique.length} unique entries after dedup`);

    for (const entry of unique.slice(0, maxSignals)) {
      if (!entry.tagline && !entry.title) continue;
      signals.push({
        source: 'producthunt',
        sourceUrl: entry.url,
        signalType: 'product_launch',
        title: entry.title,
        content: entry.tagline || entry.title,
        metadata: {
          launchedAt: entry.publishedAt,
          fromAtomFeed: true,
        },
      });
    }
  }

  logger.info(`Product Hunt: ${signals.length} signals total`);
  return signals;
}
