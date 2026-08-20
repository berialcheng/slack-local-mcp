/**
 * Validation utilities for Slack IDs, timestamps, and other inputs
 */

import { ValidationError } from '../types.js';

export const SLACK_CONVERSATION_ID_PATTERN = /^[CGD][A-Z0-9]{8,}$/i;
export const SLACK_TIMESTAMP_PATTERN = /^\d{10,}\.\d+$/;

/**
 * Validate Slack channel ID format
 * Valid formats include public channels (C...), private/MPIM conversations
 * (G...), and direct messages (D...), including legacy shorter IDs.
 */
export function validateChannelId(id: string): boolean {
  return SLACK_CONVERSATION_ID_PATTERN.test(id);
}

/**
 * Validate Slack user ID format
 * Valid formats: U... and W..., including legacy shorter IDs.
 */
export function validateUserId(id: string): boolean {
  // Slack IDs are canonically uppercase. Keeping this check case-sensitive
  // prevents lowercase usernames such as `wendyzhong` from being treated as IDs.
  return /^[UW][A-Z0-9]{8,}$/.test(id);
}

/**
 * Validate emoji name format
 * Valid: alphanumeric, underscore, hyphen (no colons)
 */
export function validateEmojiName(emoji: string): boolean {
  return /^[a-z0-9_+-]+$/i.test(emoji);
}

/**
 * Validate message text length
 * Slack allows up to 40,000 characters
 */
export function validateMessageLength(text: string): boolean {
  return text.length > 0 && text.length <= 40000;
}

/**
 * Validate and normalize channel identifier
 * Accepts: channel ID (C123...), channel name (general, #general)
 * Returns: normalized channel identifier
 */
export function normalizeChannelId(channel: string): string {
  const value = channel.trim();
  // Remove # prefix if present
  const normalized = value.startsWith('#') ? value.slice(1) : value;

  if (!normalized) {
    throw new ValidationError('Channel must not be empty');
  }

  // If it's already a valid channel ID, return as-is
  if (validateChannelId(normalized)) {
    return normalized;
  }

  // Otherwise return the name (will need to be resolved via API)
  return normalized;
}

/**
 * Validate and normalize user identifier
 * Accepts: user ID (U123...), username (@john, john)
 * Returns: normalized user identifier
 */
export function normalizeUserId(user: string): string {
  const value = user.trim();
  // Remove @ prefix if present
  const normalized = value.startsWith('@') ? value.slice(1) : value;

  if (!normalized) {
    throw new ValidationError('User must not be empty');
  }

  // If it's already a valid user ID, return as-is
  if (validateUserId(normalized)) {
    return normalized;
  }

  // Otherwise return the username (will need to be resolved via API)
  return normalized;
}

/**
 * Sanitize text input to prevent injection attacks
 */
export function sanitizeText(text: string): string {
  // Slack handles most sanitization, but we'll trim and normalize whitespace
  return text.trim();
}

/**
 * Validate Unix timestamp is within acceptable range
 * For scheduled messages: must be at least 1 minute in future, max 120 days
 */
export function validateScheduleTimestamp(postAt: number): void {
  const now = Math.floor(Date.now() / 1000);
  const oneMinute = 60;
  const maxDays = 120;
  const maxSeconds = maxDays * 24 * 60 * 60;

  if (postAt <= now + oneMinute) {
    throw new ValidationError('Scheduled time must be at least 1 minute in the future');
  }

  if (postAt > now + maxSeconds) {
    throw new ValidationError('Scheduled time cannot be more than 120 days in the future');
  }
}

/**
 * Validate message fetch limit
 */
export function validateFetchLimit(limit: number): void {
  if (limit < 1) {
    throw new ValidationError('Limit must be at least 1');
  }
  if (limit > 200) {
    throw new ValidationError('Limit cannot exceed 200');
  }
}

/**
 * Normalize and validate emoji name
 * Removes colons if present
 */
export function normalizeEmojiName(emoji: string): string {
  // Remove colons if present
  let normalized = emoji;
  if (emoji.startsWith(':') && emoji.endsWith(':')) {
    normalized = emoji.slice(1, -1);
  } else if (emoji.startsWith(':')) {
    normalized = emoji.slice(1);
  } else if (emoji.endsWith(':')) {
    normalized = emoji.slice(0, -1);
  }

  if (!validateEmojiName(normalized)) {
    throw new ValidationError(
      `Invalid emoji name: ${emoji}. Use alphanumeric characters, underscores, and hyphens only.`,
    );
  }

  return normalized;
}

/**
 * Validate Slack cookie D format
 */
export function validateSlackCookie(cookie: string): void {
  if (!cookie || typeof cookie !== 'string') {
    throw new ValidationError('Slack cookie is required');
  }

  if (!cookie.startsWith('xoxd-')) {
    throw new ValidationError('Invalid Slack cookie format. Cookie should start with "xoxd-"');
  }

  // Basic length check (Slack cookies are typically long)
  if (cookie.length < 50) {
    throw new ValidationError('Slack cookie appears to be invalid (too short)');
  }
}

/**
 * Check if a string is a valid user ID (not just a username)
 */
export function isUserId(user: string): boolean {
  return validateUserId(user);
}

/**
 * Accept only HTTPS Slack-owned workspace origins before attaching the d cookie.
 */
export function assertAllowedSlackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError('Slack workspace URL is invalid');
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const isSlackHost = hostname === 'slack.com' || hostname.endsWith('.slack.com');
  if (url.protocol !== 'https:' || !isSlackHost) {
    throw new ValidationError('Slack workspace URL must use HTTPS on a Slack-owned host');
  }
  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw new ValidationError('Slack workspace URL contains unsupported credentials or port');
  }
  return url;
}

export function normalizeSlackWorkspaceUrl(value: string): string {
  const url = assertAllowedSlackUrl(value);
  if (url.search || url.hash) {
    throw new ValidationError('Slack workspace URL must not contain a query string or fragment');
  }
  return url.origin;
}
