/**
 * Shopify Community Scraper — Discourse JSON API
 *
 * community.shopify.com runs Discourse which exposes a public JSON API.
 * No browser required — plain axios calls. Three signal sources:
 *
 *  1. Latest topics from high-signal categories (app complaints, feature requests)
 *  2. Monthly top topics (most engaged = highest urgency)
 *  3. Pain-point keyword searches (people stuck, asking for apps)
 *
 * Each signal is the original post body + thread metadata.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';
import type { RawSignal } from '../utils/types';

const BASE = 'https://community.shopify.com';

// Discourse requires a User-Agent that looks like a real browser or known crawler.
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

// Categories that surface app pain points and feature gaps.
// id is required by the Discourse pagination URL format: /c/{slug}/{id}/l/latest.json
const CATEGORIES = [
  { slug: 'shopify-apps', id: 186 },       // App recommendations, complaints
  { slug: 'technical-qa', id: 211 },        // Technical pain points solvable by apps
  { slug: 'shopify-discussion', id: 95 },   // General merchant frustrations
];

// Pain-point searches — phrases merchants use when an app gap hurts them.
const PAIN_POINT_QUERIES = [
  'looking for an app',
  'no app for',
  'app broken not working',
  'wish there was an app',
  'can\'t find an app',
  'app recommendation',
  'alternative to',
  'is there an app',
  'is there a way',
  'how do i',
  'looking for',
  'recommend',
  'frustrated',
  'no app does',
  'cant find',
  "can't find",
  'struggling with',
  'tired of',
  'help with',
  'need a tool',
];

interface DiscourseTopic {
  id: number;
  title: string;
  slug: string;
  posts_count: number;
  reply_count: number;
  views: number;
  created_at: string;
  last_posted_at: string;
  tags?: { name: string }[];
  has_accepted_answer?: boolean;
}

interface DiscoursePost {
  post_number: number;
  username: string;
  cooked: string; // HTML body
  created_at: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip HTML tags, collapse whitespace */
function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  return $.text().replace(/\s+/g, ' ').trim();
}

/** Fetch up to `pages` pages of latest topics from a category */
async function fetchCategoryTopics(
  slug: string,
  id: number,
  pages: number
): Promise<DiscourseTopic[]> {
  const topics: DiscourseTopic[] = [];
  for (let page = 0; page < pages; page++) {
    try {
      const url = `${BASE}/c/${slug}/${id}/l/latest.json?page=${page}`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const batch: DiscourseTopic[] = data?.topic_list?.topics ?? [];
      if (batch.length === 0) break;
      topics.push(...batch);
      await sleep(600);
    } catch (err) {
      logger.warn(`Community: failed to fetch ${slug} page ${page}`, {
        error: (err as Error).message,
      });
      break;
    }
  }
  return topics;
}

/** Fetch top topics of the month for a category */
async function fetchTopTopics(slug: string, id: number): Promise<DiscourseTopic[]> {
  try {
    const url = `${BASE}/c/${slug}/${id}/l/top.json?period=monthly`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    return data?.topic_list?.topics ?? [];
  } catch (err) {
    logger.warn(`Community: failed to fetch top topics for ${slug}`, {
      error: (err as Error).message,
    });
    return [];
  }
}

/** Search for pain-point topics using Discourse's search endpoint */
async function searchTopics(query: string): Promise<DiscourseTopic[]> {
  try {
    const url = `${BASE}/search.json?q=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    return data?.topics ?? [];
  } catch (err) {
    logger.warn(`Community: search failed for "${query}"`, {
      error: (err as Error).message,
    });
    return [];
  }
}

/** Fetch the first post body of a topic (the original question/complaint) */
async function fetchFirstPost(topicId: number): Promise<string | null> {
  try {
    const url = `${BASE}/t/${topicId}.json`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const posts: DiscoursePost[] = data?.post_stream?.posts ?? [];
    const first = posts.find((p) => p.post_number === 1);
    if (!first?.cooked) return null;
    return htmlToText(first.cooked).substring(0, 1500);
  } catch {
    return null;
  }
}

/** Deduplicate topics by id */
function deduplicateTopics(topics: DiscourseTopic[]): DiscourseTopic[] {
  const seen = new Set<number>();
  return topics.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

export async function scrapeShopifyCommunity(maxSignals = 60): Promise<RawSignal[]> {
  logger.info('Shopify Community: starting scrape via Discourse JSON API');

  const allTopics: DiscourseTopic[] = [];

  // 1. Latest topics from each category (2 pages = ~60 topics each)
  for (const { slug, id } of CATEGORIES) {
    const topics = await fetchCategoryTopics(slug, id, 2);
    logger.info(`Community: ${slug} latest → ${topics.length} topics`);
    allTopics.push(...topics);
    await sleep(500);
  }

  // 2. Top topics of the month from shopify-apps (highest engagement)
  const topTopics = await fetchTopTopics('shopify-apps', 186);
  logger.info(`Community: shopify-apps top/monthly → ${topTopics.length} topics`);
  allTopics.push(...topTopics);
  await sleep(500);

  // 3. Pain-point keyword searches
  for (const query of PAIN_POINT_QUERIES) {
    const results = await searchTopics(query);
    logger.info(`Community: search "${query}" → ${results.length} topics`);
    allTopics.push(...results);
    await sleep(700);
  }

  const unique = deduplicateTopics(allTopics);
  logger.info(`Community: ${unique.length} unique topics after dedup`);

  // Filter out pinned/admin threads (title starts with "About the")
  const filtered = unique.filter(
    (t) =>
      !t.title.startsWith('About the') &&
      t.posts_count > 1 &&
      t.title.length > 15
  );

  // Sort by reply count desc to prioritise the most discussed threads
  filtered.sort((a, b) => b.reply_count - a.reply_count);

  const candidates = filtered.slice(0, maxSignals * 2); // fetch more, cap after body fetch
  logger.info(`Community: fetching post bodies for ${candidates.length} candidates`);

  const signals: RawSignal[] = [];

  for (const topic of candidates) {
    if (signals.length >= maxSignals) break;

    const body = await fetchFirstPost(topic.id);
    if (!body || body.length < 50) continue;

    signals.push({
      source: 'shopify_community',
      sourceUrl: `${BASE}/t/${topic.slug}/${topic.id}`,
      signalType: 'forum_post',
      title: topic.title,
      content: body,
      metadata: {
        topicId: topic.id,
        replyCount: topic.reply_count,
        views: topic.views,
        postCount: topic.posts_count,
        createdAt: topic.created_at,
        lastPostedAt: topic.last_posted_at,
        tags: topic.tags?.map((t) => t.name) ?? [],
        hasAcceptedAnswer: topic.has_accepted_answer ?? false,
      },
    });

    await sleep(400);
  }

  logger.info(`Shopify Community: ${signals.length} signals scraped`);
  return signals;
}
