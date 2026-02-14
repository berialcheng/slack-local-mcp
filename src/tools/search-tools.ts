/**
 * Search tools for searching messages in Slack
 */

import { z } from 'zod';
import { SlackClient } from '../slack-client.js';
import {
  SearchMessagesInput,
  SearchMessagesOutput,
  FormattedSearchMessage,
  SlackSearchMessage,
} from '../types.js';
import { logger } from '../utils/logger.js';
import { handleSlackError, formatErrorForMCP } from '../utils/errors.js';
import { formatTimestamp, parseSlackMarkdown } from '../utils/formatters.js';

/**
 * Tool: search_messages
 * Search for messages across all channels in the workspace
 */
export const searchMessagesTool = {
  name: 'search_messages',
  description: 'Search for messages across all channels in the Slack workspace. Use this to find specific messages, conversations, or content based on keywords, user mentions, or channel names. Examples: "project deadline", "from:@john urgent", "in:#general meeting notes"',
  inputSchema: z.object({
    query: z.string().min(1).describe('Search query. Supports Slack search modifiers like "from:@user", "in:#channel", "has:link", "before:YYYY-MM-DD", "after:YYYY-MM-DD"'),
    count: z.number().int().min(1).max(100).optional().default(20).describe('Number of results per page (1-100, default: 20)'),
    page: z.number().int().min(1).optional().default(1).describe('Page number for pagination (default: 1)'),
    sort: z.enum(['score', 'timestamp']).optional().default('score').describe('Sort by relevance score or timestamp (default: score)'),
    sort_dir: z.enum(['asc', 'desc']).optional().default('desc').describe('Sort direction: asc or desc (default: desc)'),
    highlight: z.boolean().optional().default(true).describe('Enable search term highlighting (default: true)'),
  }),
};

export async function handleSearchMessages(
  input: SearchMessagesInput,
  client: SlackClient
): Promise<SearchMessagesOutput | string | ReturnType<typeof formatErrorForMCP>> {
  try {
    logger.info('Searching messages', {
      query: input.query,
      count: input.count,
      page: input.page,
    });

    // Call client.searchMessages() with input parameters
    const response = await client.searchMessages({
      query: input.query,
      count: input.count,
      page: input.page,
      sort: input.sort,
      sort_dir: input.sort_dir,
      highlight: input.highlight,
    });

    // Extract user IDs from matched messages
    const userIds = new Set<string>();
    for (const match of response.messages.matches) {
      if (match.user) {
        userIds.add(match.user);
      }
    }

    // Populate user cache for all matched message users
    const userCache = client.getUserCache();
    await Promise.all(
      Array.from(userIds).map(async (userId) => {
        if (!userCache.has(userId)) {
          try {
            await client.resolveUsername(userId);
          } catch (error) {
            logger.debug(`Failed to resolve username for ${userId}`);
          }
        }
      })
    );

    // Format matched messages using user cache
    const formattedMatches: FormattedSearchMessage[] = response.messages.matches.map(
      (match: SlackSearchMessage) => {
        // Resolve username with proper fallback chain
        let userName = 'Unknown';
        if (match.user) {
          userName = userCache.get(match.user) || match.username || match.user;
        } else if (match.username) {
          userName = match.username;
        }

        return {
          user: userName, // Use resolved name only
          text: parseSlackMarkdown(match.text),
          ts: match.ts,
          timestamp: formatTimestamp(match.ts),
          channel: match.channel.name || match.channel.id, // Name preferred, ID fallback
          permalink: match.permalink,
          thread_ts: match.thread_ts,
          reactions: match.reactions,
        };
      }
    );

    // Get pagination info
    const pagination = response.messages.pagination;
    const totalCount = pagination.total_count;
    const page = pagination.page;
    const pageCount = pagination.page_count;

    // If no results, return just a helpful hint (save tokens, no empty structure)
    if (totalCount === 0) {
      const usernameMatch = input.query.match(/from:@?([^\s]+)/i);
      if (usernameMatch) {
        const attemptedUsername = usernameMatch[1];
        return `No messages found. Username '${attemptedUsername}' may be incorrect. Use search_users to find the correct username first.`;
      }
      return `No messages found for query: "${input.query}"`;
    }

    return {
      messages: formattedMatches,
      message_count: formattedMatches.length,
      total_count: totalCount,
      page,
      page_count: pageCount,
    };
  } catch (error) {
    logger.error('Failed to search messages', error);
    const slackError = handleSlackError(error, 'search_messages');
    return formatErrorForMCP(slackError);
  }
}

