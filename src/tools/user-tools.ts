/**
 * User tools for searching and managing Slack users
 */

import { z } from 'zod';

import type { SlackClient, UserRecord } from '../slack-client.js';
import { logger } from '../utils/logger.js';

const USER_SEARCH_MAX_PAGES = 3;

/**
 * Tool: search_users
 * Search for users by name and return multiple matches
 */
export const searchUsersTool = {
  name: 'search_users',
  description:
    'Search for Slack users by name (display name, real name, or username). Returns multiple matches if found, helping you identify the correct user when names are ambiguous. Use this before sending direct messages to ensure you have the right person.',
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .max(100)
      .describe('Search query (name, display name, or username to search for)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(5)
      .describe('Maximum number of results to return (default: 5, max: 100)'),
    refresh_cache: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Explicitly rebuild the complete user cache from Slack. This may be slow for large workspaces (default: false).',
      ),
    cursor: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe('Opaque next_cursor returned by an incomplete prior search'),
  }),
};

export interface SearchUsersInput {
  query: string;
  limit?: number;
  refresh_cache?: boolean;
  cursor?: string;
}

export interface UserSearchResult {
  id: string;
  name: string;
  display_name: string;
  real_name: string;
  email?: string;
}

export interface SearchUsersOutput {
  query: string;
  results: UserSearchResult[];
  match_count: number;
  source: 'cache' | 'api';
  exhaustive: boolean;
  scanned_users: number;
  next_cursor?: string;
}

/**
 * Calculate Levenshtein distance between two strings
 * Used for fuzzy matching to handle typos. The caller only cares about small
 * distances, so skip impossible length gaps and keep one row instead of an
 * O(m*n) matrix for every workspace user.
 */
function levenshteinDistance(str1: string, str2: string, maxDistance: number): number {
  if (Math.abs(str1.length - str2.length) > maxDistance) {
    return maxDistance + 1;
  }

  // The distance is symmetric; use the shorter value for the retained row.
  const source = str1.length >= str2.length ? str1 : str2;
  const target = str1.length >= str2.length ? str2 : str1;
  const distances = Array.from({ length: target.length + 1 }, (_, index) => index);

  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    let diagonal = distances[0];
    distances[0] = sourceIndex;

    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      const above = distances[targetIndex];
      const substitutionCost = source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1;
      distances[targetIndex] = Math.min(
        above + 1,
        distances[targetIndex - 1] + 1,
        diagonal + substitutionCost,
      );
      diagonal = above;
    }
  }

  return distances[target.length];
}

/**
 * Check if two strings are similar enough (handles typos)
 * Returns a similarity score (0-100, higher is better)
 */
function similarityScore(query: string, target: string): number {
  if (query === target) return 100;
  if (target.includes(query)) return 60;

  // Allow up to 2 character differences for strings > 4 chars
  // or 1 difference for shorter strings
  const threshold = query.length > 4 ? 2 : 1;
  const distance = levenshteinDistance(query, target, threshold);

  if (distance <= threshold) {
    // Return score based on how close the match is
    return 60 - distance * 10; // 50 for 1 char diff, 40 for 2 char diff
  }

  return 0;
}

/**
 * Create a scoring function for user search.
 * Scores users based on how well they match the query.
 */
export function createUserScoreFn(cleanQuery: string): (user: UserRecord) => number {
  const normalizedQuery = cleanQuery.replace(/[.\-_]/g, '');
  const hasNormalizedQuery = normalizedQuery.length > 0;

  return (user: UserRecord): number => {
    const name = user.name.toLowerCase();
    const displayName = user.display_name.toLowerCase();
    const realName = user.real_name.toLowerCase();
    const normalizedName = name.replace(/[.\-_]/g, '');

    // Exact matches get highest score
    if (name === cleanQuery || displayName === cleanQuery || realName === cleanQuery) {
      return 100;
    }
    // Normalized exact match (ignoring dots, hyphens, underscores)
    if (hasNormalizedQuery && normalizedName === normalizedQuery) {
      return 95;
    }
    // Starts with query (exact or normalized)
    if (
      name.startsWith(cleanQuery) ||
      displayName.startsWith(cleanQuery) ||
      realName.startsWith(cleanQuery)
    ) {
      return 80;
    }
    if (hasNormalizedQuery && normalizedName.startsWith(normalizedQuery)) {
      return 75;
    }
    // Word boundary match in real name
    if (realName.split(' ').some((word) => word.startsWith(cleanQuery))) {
      return 70;
    }
    // Contains query (exact or normalized)
    if (
      name.includes(cleanQuery) ||
      displayName.includes(cleanQuery) ||
      realName.includes(cleanQuery)
    ) {
      return 60;
    }
    if (hasNormalizedQuery && normalizedName.includes(normalizedQuery)) {
      return 55;
    }
    // Fuzzy matching for typos
    const realNameWords = realName.split(' ');
    const displayNameParts = displayName.split(/[.\-@]/);
    const allParts = [...realNameWords, ...displayNameParts];
    let maxSimilarity = 0;
    for (const part of allParts) {
      const similarity = similarityScore(cleanQuery, part);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
      }
    }
    return maxSimilarity;
  };
}

export async function handleSearchUsers(
  input: SearchUsersInput,
  client: SlackClient,
): Promise<SearchUsersOutput | string> {
  // Clean and normalize query
  let cleanQuery = input.query.trim().replace(/^@/, '').toLowerCase();

  if (!cleanQuery) {
    return 'Search query cannot be empty.';
  }

  // Strip common email/domain suffixes
  cleanQuery = cleanQuery.replace(/[-@][a-z0-9-]+\.(com|net|org|io|dev)$/i, '');
  if (!cleanQuery) {
    return 'Search query cannot be empty.';
  }

  const limit = input.limit || 5;

  logger.info('Searching for users', { query: cleanQuery, originalQuery: input.query, limit });

  const scoreFn = createUserScoreFn(cleanQuery);
  const cursor = input.cursor?.trim() || undefined;
  const forceFullScan = Boolean(input.refresh_cache && !cursor);
  const searchResult = await client.searchUsersIncremental(scoreFn, limit, {
    earlyStopThreshold: 80,
    skipCache: Boolean(input.refresh_cache || cursor),
    forceFullScan,
    maxPages: forceFullScan ? undefined : USER_SEARCH_MAX_PAGES,
    cursor,
  });

  const results: UserSearchResult[] = searchResult.results.map((user) => ({
    id: user.id,
    name: user.name,
    display_name: user.display_name || user.name,
    real_name: user.real_name || user.name,
  }));

  return {
    query: input.query,
    results,
    match_count: results.length,
    source: searchResult.source,
    exhaustive: searchResult.exhaustive,
    scanned_users: searchResult.scannedUsers,
    next_cursor: searchResult.nextCursor,
  };
}
