/**
 * Formatting utilities for Slack messages and data
 */

import type { SlackMessage, FormattedMessage } from '../types.js';

import { formatSlackFile } from './file-download.js';

/**
 * Format a Unix timestamp to human-readable date
 */
export function formatTimestamp(ts: string): string {
  const timestamp = parseFloat(ts) * 1000; // Convert to milliseconds
  const date = new Date(timestamp);

  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Parse Slack markdown and mentions to readable text
 */
export function parseSlackMarkdown(text: string): string {
  let parsed = text;

  // Replace user mentions <@U123456> with @username
  parsed = parsed.replace(/<@([UW][A-Z0-9]+)>/gi, '@$1');

  // Replace channel mentions <#C123456|general> with #general
  parsed = parsed.replace(/<#[C][A-Z0-9]+\|([^>]+)>/gi, '#$1');

  // Replace channel mentions without name <#C123456> with #C123456
  parsed = parsed.replace(/<#([C][A-Z0-9]+)>/gi, '#$1');

  // Replace links <http://example.com|Example> with Example (http://example.com)
  parsed = parsed.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/gi, '$2 ($1)');

  // Replace bare links <http://example.com> with http://example.com
  parsed = parsed.replace(/<(https?:\/\/[^>]+)>/gi, '$1');

  // Replace special entities
  parsed = parsed.replace(/&amp;/g, '&');
  parsed = parsed.replace(/&lt;/g, '<');
  parsed = parsed.replace(/&gt;/g, '>');

  return parsed;
}

/**
 * Format a single Slack message for display
 */
export function formatMessage(
  message: SlackMessage,
  userCache?: Map<string, string>,
): FormattedMessage {
  const userName = (message.user && userCache?.get(message.user)) || message.user || 'Unknown';
  const isBot = !!message.bot_id || !!message.app_id;

  return {
    user: userName,
    text: parseSlackMarkdown(message.text),
    ts: message.ts,
    timestamp: formatTimestamp(message.ts),
    thread_ts: message.thread_ts,
    reply_count: message.reply_count,
    reactions: message.reactions,
    is_bot: isBot,
    files: message.files?.map(formatSlackFile),
  };
}

/**
 * Format scheduled message time
 */
export function formatScheduledTime(postAt: number): string {
  const date = new Date(postAt * 1000);

  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    hour12: true,
  });
}
