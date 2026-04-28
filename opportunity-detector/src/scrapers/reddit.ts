/**
 * Reddit Scraper — JSON API (no OAuth required)
 *
 * Three signal sources per subreddit:
 *  1. Hot posts  (currently active discussions)
 *  2. Top posts  (week + month — proven pain points)
 *  3. Keyword searches  (pain-point phrases per subreddit)
 *
 * Mirrors the Shopify Community scraper's multi-strategy approach.
 */

import axios from 'axios';
import { logger } from '../utils/logger';
import type { RawSignal } from '../utils/types';

const SUBREDDITS = ['shopify', 'ecommerce', 'EcomTactics', 'FulfillmentByAmazon'];

const PAIN_POINT_QUERIES = [
  'looking for an app',
  'is there an app',
  'is there a way',
  'recommend an app',
  'wish there was',
  'no app for',
  'app broken not working',
  'can\'t find an app',
  'struggling with',
  'frustrated with',
  'need a tool',
  'alternative to',
];

const HEADERS = {
  'User-Agent': 'OpportunityDetector/1.0 (research bot; ecommerce pain-point scraper)',
  Accept: 'application/json',
};

interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  permalink: string;
  score: number;
  num_comments: number;
  created_utc: number;
  author: string;
  subreddit: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchListing(url: string): Promise<RedditPost[]> {
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    return (data?.data?.children ?? []).map((c: { data: RedditPost }) => c.data);
  } catch (err) {
    logger.warn(`Reddit: failed to fetch ${url}`, { error: (err as Error).message });
    return [];
  }
}

async function fetchSubredditPosts(subreddit: string, limit: number): Promise<RedditPost[]> {
  const base = `https://www.reddit.com/r/${subreddit}`;
  const results: RedditPost[] = [];

  const listings = [
    `${base}/hot.json?limit=${limit}`,
    `${base}/top.json?t=week&limit=${limit}`,
    `${base}/top.json?t=month&limit=${limit}`,
  ];

  for (const url of listings) {
    const posts = await fetchListing(url);
    results.push(...posts);
    await sleep(700);
  }

  return results;
}

async function searchSubreddit(subreddit: string, query: string): Promise<RedditPost[]> {
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=top&t=month&limit=15`;
  const posts = await fetchListing(url);
  await sleep(700);
  return posts;
}

function deduplicatePosts(posts: RedditPost[]): RedditPost[] {
  const seen = new Set<string>();
  return posts.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

export async function scrapeReddit(maxSignals = 100): Promise<RawSignal[]> {
  logger.info('Reddit: starting multi-strategy scrape');

  const allPosts: RedditPost[] = [];

  for (const subreddit of SUBREDDITS) {
    logger.info(`Reddit: fetching listings for r/${subreddit}`);
    const listing = await fetchSubredditPosts(subreddit, 25);
    logger.info(`Reddit: r/${subreddit} listings → ${listing.length} posts`);
    allPosts.push(...listing);

    for (const query of PAIN_POINT_QUERIES) {
      const results = await searchSubreddit(subreddit, query);
      allPosts.push(...results);
    }

    logger.info(`Reddit: r/${subreddit} done, total so far: ${allPosts.length}`);
    await sleep(500);
  }

  const unique = deduplicatePosts(allPosts);
  logger.info(`Reddit: ${unique.length} unique posts after dedup`);

  // Filter out low-signal posts (no body, very short titles, mod posts)
  const filtered = unique.filter(
    (p) =>
      p.title.length > 15 &&
      p.author !== 'AutoModerator' &&
      (p.selftext.length > 30 || p.num_comments >= 5)
  );

  // Sort by comment count descending — most discussed = highest urgency
  filtered.sort((a, b) => b.num_comments - a.num_comments);

  const candidates = filtered.slice(0, maxSignals);
  logger.info(`Reddit: converting ${candidates.length} posts to signals`);

  return candidates.map((post) => ({
    source: 'reddit',
    sourceUrl: `https://reddit.com${post.permalink}`,
    signalType: 'forum_post',
    title: post.title,
    content: (post.selftext || post.title).substring(0, 3000),
    metadata: {
      subreddit: post.subreddit,
      score: post.score,
      commentCount: post.num_comments,
      author: post.author,
      postedAt: new Date(post.created_utc * 1000).toISOString(),
    },
  }));
}
