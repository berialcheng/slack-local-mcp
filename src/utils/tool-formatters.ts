/**
 * Tool-specific formatters for TOON optimization
 * Each formatter knows how to flatten its specific data structure for TOON tabular format
 */

import { encode } from '@toon-format/toon';
import { logger } from './logger.js';

/**
 * Format fetch messages response (fetch_channel_messages, fetch_thread_messages)
 * Flattens reactions for TOON tabular format
 */
export function formatFetchMessagesResponse(
  data: any,
  format: 'toon' | 'json',
  userCache: Map<string, string>
): string {
  // Pass through if already formatted (string or error)
  if (typeof data === 'string' || 'isError' in data) {
    return JSON.stringify(data, null, 2);
  }

  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  try {
    // Normalize to uniform structure for TOON tabular format
    const normalized = {
      ...data,
      messages: data.messages.map((msg: any) => ({
        user: msg.user,
        text: msg.text,
        ts: msg.ts,
        timestamp: msg.timestamp,
        thread_ts: msg.thread_ts || '', // Normalize null → empty string
        reply_count: msg.reply_count || 0, // Normalize null → 0
        is_bot: msg.is_bot || false,
        reactions: msg.reactions?.map((r: any) => {
          const userNames = r.users.map((uid: string) => userCache.get(uid) || uid).join(';');
          return `${r.name}×${r.count}(${userNames})`;
        }).join('|') || '', // Normalize to pipe-separated string (avoids comma conflicts)
      })),
    };

    return encode(normalized);
  } catch (error) {
    logger.debug('TOON encoding failed for fetch messages, using JSON', error);
    return JSON.stringify(data, null, 2);
  }
}

/**
 * Format search messages response
 * Flattens reactions for TOON tabular format
 */
export function formatSearchMessagesResponse(
  data: any,
  format: 'toon' | 'json',
  userCache: Map<string, string>
): string {
  // Pass through if already formatted (string or error)
  if (typeof data === 'string' || 'isError' in data) {
    return JSON.stringify(data, null, 2);
  }

  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  try {
    // Normalize to uniform structure for TOON tabular format
    const normalized = {
      ...data,
      messages: data.messages.map((msg: any) => ({
        user: msg.user,
        text: msg.text,
        ts: msg.ts,
        timestamp: msg.timestamp,
        channel: msg.channel,
        permalink: msg.permalink,
        thread_ts: msg.thread_ts || '', // Normalize null → empty string
        reactions: msg.reactions?.map((r: any) => {
          const userNames = r.users.map((uid: string) => userCache.get(uid) || uid).join(';');
          return `${r.name}×${r.count}(${userNames})`;
        }).join('|') || '', // Normalize to pipe-separated string (avoids comma conflicts)
      })),
    };

    return encode(normalized);
  } catch (error) {
    logger.debug('TOON encoding failed for search messages, using JSON', error);
    return JSON.stringify(data, null, 2);
  }
}

/**
 * Format search users response
 * No flattening needed - already optimal for TOON
 */
export function formatSearchUsersResponse(
  data: any,
  format: 'toon' | 'json'
): string {
  // Pass through if already formatted (string or error)
  if (typeof data === 'string' || 'isError' in data) {
    return JSON.stringify(data, null, 2);
  }

  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  try {
    return encode(data);
  } catch (error) {
    logger.debug('TOON encoding failed for search users, using JSON', error);
    return JSON.stringify(data, null, 2);
  }
}

/**
 * Format list reminders response
 * No flattening needed - already optimal for TOON
 */
export function formatListRemindersResponse(
  data: any,
  format: 'toon' | 'json'
): string {
  // Pass through if already formatted (string or error)
  if (typeof data === 'string' || 'isError' in data) {
    return JSON.stringify(data, null, 2);
  }

  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  try {
    return encode(data);
  } catch (error) {
    logger.debug('TOON encoding failed for list reminders, using JSON', error);
    return JSON.stringify(data, null, 2);
  }
}
