/**
 * Tool-specific formatters for TOON optimization
 * Each formatter knows how to flatten its specific data structure for TOON tabular format
 */

import { encode } from '@toon-format/toon';

import type {
  FetchMessagesOutput,
  FormattedSlackFile,
  SearchMessagesOutput,
  SlackReaction,
} from '../types.js';

import { logger } from './logger.js';

interface McpErrorResponse {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

function isMcpErrorResponse(value: unknown): value is McpErrorResponse {
  return (
    typeof value === 'object' && value !== null && 'isError' in value && value.isError === true
  );
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

function formatFiles(files: FormattedSlackFile[] | undefined): string {
  return (
    files
      ?.map((file) =>
        [
          file.id,
          file.name,
          file.mimetype,
          file.size ?? '',
          file.category,
          file.download_eligible_by_default ? 'default-download' : 'metadata-only',
        ].join(':'),
      )
      .join('|') || ''
  );
}

function formatReactions(
  reactions: SlackReaction[] | undefined,
  userCache: Map<string, string>,
): string {
  return (
    reactions
      ?.map((reaction) => {
        const userNames = reaction.users.map((id) => userCache.get(id) || id).join(';');
        return `${reaction.name}×${reaction.count}(${userNames})`;
      })
      .join('|') || ''
  );
}

function encodeSafely<T>(
  data: T,
  fallbackContext: string,
  transform: (value: T) => unknown = (value) => value,
): string {
  try {
    return encode(transform(data));
  } catch (error) {
    logger.debug(`TOON encoding failed for ${fallbackContext}, using JSON`, error);
    return stringifyJson(data);
  }
}

/**
 * Format fetch messages response (fetch_channel_messages, fetch_thread_messages)
 * Flattens reactions for TOON tabular format
 */
export function formatFetchMessagesResponse(
  data: FetchMessagesOutput | string | McpErrorResponse,
  format: 'toon' | 'json',
  userCache: Map<string, string>,
): string {
  if (format === 'json' || typeof data === 'string' || isMcpErrorResponse(data)) {
    return stringifyJson(data);
  }

  return encodeSafely(data, 'fetch messages', (value) => ({
    ...value,
    messages: value.messages.map((message) => ({
      user: message.user,
      text: message.text,
      ts: message.ts,
      timestamp: message.timestamp,
      thread_ts: message.thread_ts || '',
      reply_count: message.reply_count || 0,
      is_bot: message.is_bot || false,
      files: formatFiles(message.files),
      reactions: formatReactions(message.reactions, userCache),
    })),
  }));
}

/**
 * Format search messages response
 * Flattens reactions for TOON tabular format
 */
export function formatSearchMessagesResponse(
  data: SearchMessagesOutput | string | McpErrorResponse,
  format: 'toon' | 'json',
  userCache: Map<string, string>,
): string {
  if (format === 'json' || typeof data === 'string' || isMcpErrorResponse(data)) {
    return stringifyJson(data);
  }

  return encodeSafely(data, 'search messages', (value) => ({
    ...value,
    messages: value.messages.map((message) => ({
      user: message.user,
      text: message.text,
      ts: message.ts,
      timestamp: message.timestamp,
      channel: message.channel,
      permalink: message.permalink,
      thread_ts: message.thread_ts || '',
      files: formatFiles(message.files),
      reactions: formatReactions(message.reactions, userCache),
    })),
  }));
}

/**
 * Format search users response
 * No flattening needed - already optimal for TOON
 */
export function formatSearchUsersResponse(data: unknown, format: 'toon' | 'json'): string {
  if (format === 'json' || typeof data === 'string' || isMcpErrorResponse(data)) {
    return stringifyJson(data);
  }
  return encodeSafely(data, 'search users');
}
