/**
 * Fetch tools for retrieving messages from Slack
 */

import { z } from 'zod';
import { SlackClient } from '../slack-client.js';
import {
  FetchChannelMessagesInput,
  FetchThreadMessagesInput,
  FetchMessagesOutput,
} from '../types.js';
import { logger } from '../utils/logger.js';
import { handleSlackError, formatErrorForMCP } from '../utils/errors.js';
import { normalizeChannelId, validateFetchLimit } from '../utils/validation.js';
import {
  formatMessage,
} from '../utils/formatters.js';

/**
 * Tool: fetch_channel_messages
 * Fetch recent messages from a channel
 */
export const fetchChannelMessagesTool = {
  name: 'fetch_channel_messages',
  description: 'Fetch recent messages from a Slack channel. Returns messages in a format optimized for AI summarization and analysis. Use this to get context from conversations, review discussions, or summarize channel activity.',
  inputSchema: z.object({
    channel: z.string().describe('Channel ID (e.g., C1234567890) or channel name (e.g., general, #general)'),
    limit: z.number().int().min(1).max(200).optional().default(50).describe('Number of messages to fetch (default: 50, max: 200)'),
    oldest: z.string().optional().describe('Only include messages after this timestamp (e.g., 1234567890.123456)'),
    latest: z.string().optional().describe('Only include messages before this timestamp (e.g., 1234567890.123456)'),
  }),
};

export async function handleFetchChannelMessages(
  input: FetchChannelMessagesInput,
  client: SlackClient
): Promise<FetchMessagesOutput | string | ReturnType<typeof formatErrorForMCP>> {
  try {
    // Validate limit
    const limit = input.limit || 50;
    validateFetchLimit(limit);

    const channel = normalizeChannelId(input.channel);
    
    logger.info('Fetching channel messages', {
      channel,
      limit,
      hasOldest: !!input.oldest,
      hasLatest: !!input.latest,
    });

    // Fetch messages
    const messages = await client.fetchMessages({
      channel,
      limit,
      oldest: input.oldest,
      latest: input.latest,
    });

    if (messages.length === 0) {
      return 'No messages found in the specified range.';
    }

    // Populate user cache for better formatting
    await client.populateUserCache(messages);
    const userCache = client.getUserCache();

    // Format messages for output
    const formattedMessages = messages.map((msg) => formatMessage(msg, userCache));

    logger.info(`Successfully fetched ${messages.length} messages`);

    return {
      messages: formattedMessages,
      message_count: messages.length,
    };
  } catch (error) {
    logger.error('Failed to fetch channel messages', error);
    const slackError = handleSlackError(error, 'fetch_channel_messages');
    return formatErrorForMCP(slackError);
  }
}

/**
 * Tool: fetch_thread_messages
 * Fetch all messages from a specific thread
 */
export const fetchThreadMessagesTool = {
  name: 'fetch_thread_messages',
  description: 'Fetch all messages from a specific conversation thread in a channel. Returns the parent message and all replies in chronological order, formatted for AI analysis. Use this to understand thread discussions or summarize threaded conversations.',
  inputSchema: z.object({
    channel: z.string().describe('Channel ID where the thread exists (e.g., C1234567890)'),
    thread_ts: z.string().describe('Thread parent message timestamp (e.g., 1234567890.123456)'),
    limit: z.number().int().min(1).max(200).optional().default(100).describe('Maximum number of messages to fetch (default: 100, max: 200)'),
  }),
};

export async function handleFetchThreadMessages(
  input: FetchThreadMessagesInput,
  client: SlackClient
): Promise<FetchMessagesOutput | string | ReturnType<typeof formatErrorForMCP>> {
  try {
    // Validate limit
    const limit = input.limit || 100;
    validateFetchLimit(limit);

    const channel = normalizeChannelId(input.channel);
    
    logger.info('Fetching thread messages', {
      channel,
      thread_ts: input.thread_ts,
      limit,
    });

    // Fetch thread replies
    const messages = await client.fetchThreadReplies({
      channel,
      thread_ts: input.thread_ts,
      limit,
    });

    if (messages.length === 0) {
      return 'No messages found in this thread.';
    }

    // Populate user cache for better formatting
    await client.populateUserCache(messages);
    const userCache = client.getUserCache();

    // Format messages for output
    const formattedMessages = messages.map((msg) => formatMessage(msg, userCache));

    logger.info(`Successfully fetched ${messages.length} thread messages`);

    return {
      messages: formattedMessages,
      message_count: messages.length,
    };
  } catch (error) {
    logger.error('Failed to fetch thread messages', error);
    const slackError = handleSlackError(error, 'fetch_thread_messages');
    return formatErrorForMCP(slackError);
  }
}