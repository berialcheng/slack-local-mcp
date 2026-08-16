/**
 * Schedule tools for scheduling messages in Slack
 */

import { z } from 'zod';

import type { SlackClient } from '../slack-client.js';
import type { ScheduleMessageInput, ScheduleToolOutput } from '../types.js';
import { formatScheduledTime } from '../utils/formatters.js';
import { logger } from '../utils/logger.js';
import {
  normalizeChannelId,
  sanitizeText,
  SLACK_TIMESTAMP_PATTERN,
  validateMessageLength,
  validateScheduleTimestamp,
} from '../utils/validation.js';

const slackTimestampSchema = z
  .string()
  .trim()
  .regex(SLACK_TIMESTAMP_PATTERN, 'Expected a Slack timestamp such as 1234567890.123456');

/**
 * Tool: schedule_message
 * Schedule a message to be sent at a future time
 */
export const scheduleMessageTool = {
  name: 'schedule_message',
  description:
    "Schedule a message to be sent at a specific future time using Slack's native scheduling. The message will be delivered by Slack at the scheduled time. Useful for reminders, announcements, or time-sensitive communications.",
  inputSchema: z.object({
    channel: z.string().describe('Channel ID where the message will be posted (e.g., C1234567890)'),
    text: z.string().min(1).max(40000).describe('Message content to send'),
    post_at: z
      .number()
      .int()
      .positive()
      .describe(
        'Unix timestamp (seconds since epoch) when the message should be sent. Must be at least 1 minute in the future and no more than 120 days ahead.',
      ),
    thread_ts: slackTimestampSchema
      .optional()
      .describe('Thread timestamp to schedule a reply in a thread (optional)'),
  }),
};

export async function handleScheduleMessage(
  input: ScheduleMessageInput,
  client: SlackClient,
): Promise<ScheduleToolOutput> {
  // Validate timestamp
  validateScheduleTimestamp(input.post_at);

  // Validate and sanitize text
  const text = sanitizeText(input.text);
  if (!validateMessageLength(text)) {
    throw new Error('Message text must be between 1 and 40,000 characters');
  }

  const channel = normalizeChannelId(input.channel);

  logger.info('Scheduling message', {
    channel,
    post_at: input.post_at,
    scheduled_for: new Date(input.post_at * 1000).toISOString(),
    hasThread: !!input.thread_ts,
  });

  // Schedule the message
  const response = await client.scheduleMessage({
    channel,
    text,
    post_at: input.post_at,
    thread_ts: input.thread_ts,
  });

  const scheduledTime = formatScheduledTime(response.post_at);

  return {
    success: true,
    channel: response.channel,
    scheduled_message_id: response.scheduled_message_id,
    post_at: response.post_at,
    scheduled_time: scheduledTime,
  };
}
