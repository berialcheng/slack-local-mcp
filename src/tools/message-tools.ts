/**
 * Message tools for sending messages to Slack
 */

import { z } from 'zod';

import type { SlackClient } from '../slack-client.js';
import type {
  SendMessageInput,
  SendDirectMessageInput,
  ReplyToThreadInput,
  EditMessageInput,
  DeleteMessageInput,
  MessageToolOutput,
} from '../types.js';
import { logger } from '../utils/logger.js';
import {
  normalizeChannelId,
  normalizeUserId,
  sanitizeText,
  SLACK_TIMESTAMP_PATTERN,
  validateMessageLength,
  isUserId,
} from '../utils/validation.js';

const slackTimestampSchema = z
  .string()
  .trim()
  .regex(SLACK_TIMESTAMP_PATTERN, 'Expected a Slack message timestamp such as 1234567890.123456');
const RECIPIENT_CANDIDATE_LIMIT = 5;
const RECIPIENT_SEARCH_MAX_PAGES = 3;

interface RecipientCandidate {
  id: string;
  username: string;
  display_name: string;
  real_name: string;
}

export interface DirectMessageResolutionOutput {
  success: false;
  status: 'recipient_confirmation_required' | 'recipient_search_incomplete' | 'recipient_not_found';
  query: string;
  candidates: RecipientCandidate[];
  source: 'cache' | 'api';
  search_complete: boolean;
  scanned_users: number;
  next_cursor?: string;
  message: string;
}

/**
 * Tool: send_message
 * Send a message to a Slack channel
 */
export const sendMessageTool = {
  name: 'send_message',
  description:
    'Send a message to a Slack channel. Use this to post messages to public channels, private channels, or continue conversations.',
  inputSchema: z.object({
    channel: z
      .string()
      .describe('Channel ID (e.g., C1234567890) or channel name (e.g., general, #general)'),
    text: z
      .string()
      .min(1)
      .max(40000)
      .describe('Message content to send (up to 40,000 characters)'),
    thread_ts: slackTimestampSchema
      .optional()
      .describe('Thread timestamp to reply to (optional, for threading)'),
    unfurl_links: z
      .boolean()
      .optional()
      .default(true)
      .describe('Enable automatic link previews (default: true)'),
  }),
};

export async function handleSendMessage(
  input: SendMessageInput,
  client: SlackClient,
): Promise<MessageToolOutput> {
  // Validate and sanitize input
  const text = sanitizeText(input.text);
  if (!validateMessageLength(text)) {
    throw new Error('Message text must be between 1 and 40,000 characters');
  }

  const channel = normalizeChannelId(input.channel);

  logger.info('Sending message to channel', { channel, hasThread: !!input.thread_ts });

  // Send the message
  const response = await client.sendMessage({
    channel,
    text,
    thread_ts: input.thread_ts,
    unfurl_links: input.unfurl_links,
  });

  return {
    success: true,
    channel: response.channel,
    ts: response.ts,
    message: input.thread_ts
      ? 'Message sent successfully as a thread reply'
      : 'Message sent successfully',
  };
}

/**
 * Tool: send_direct_message
 * Send a direct message to a specific user
 */
export const sendDirectMessageTool = {
  name: 'send_direct_message',
  description:
    'Send a direct message (DM) to a Slack user by ID, exact @username, or human-readable name. Name searches are bounded; when a name is not an exact username, the tool returns candidates for confirmation without sending.',
  inputSchema: z.object({
    user: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => value.replace(/^@/, '').length > 0, 'User must not be empty')
      .describe(
        'User ID, exact @username, or human-readable name. Ambiguous names return candidates without sending.',
      ),
    text: z.string().min(1).max(40000).describe('Message content to send'),
    thread_ts: slackTimestampSchema
      .optional()
      .describe('Thread timestamp to continue a DM conversation (optional)'),
  }),
};

export async function handleSendDirectMessage(
  input: SendDirectMessageInput,
  client: SlackClient,
): Promise<MessageToolOutput | DirectMessageResolutionOutput> {
  // Validate and sanitize input
  const text = sanitizeText(input.text);
  if (!validateMessageLength(text)) {
    throw new Error('Message text must be between 1 and 40,000 characters');
  }

  const rawUserInput = input.user.trim();
  const userInput = normalizeUserId(rawUserInput);

  logger.info('Sending direct message', { user: userInput });

  // Determine if we have a user ID or username
  let actualUserId: string;

  if (isUserId(userInput)) {
    // Already a user ID
    actualUserId = userInput;
  } else {
    const exactUsername = rawUserInput.startsWith('@');
    const searchTerm = userInput.toLowerCase();
    const candidateLimit = exactUsername ? 1 : RECIPIENT_CANDIDATE_LIMIT;
    const searchResult = await client.searchUsersIncremental(
      (user) => {
        const usernameMatches = user.name.toLowerCase() === searchTerm;
        if (exactUsername) return usernameMatches ? 100 : 0;
        return usernameMatches ||
          user.display_name.toLowerCase() === searchTerm ||
          user.real_name.toLowerCase() === searchTerm
          ? 100
          : 0;
      },
      candidateLimit,
      {
        earlyStopThreshold: 100,
        maxPages: RECIPIENT_SEARCH_MAX_PAGES,
      },
    );
    const candidates: RecipientCandidate[] = searchResult.results.map((user) => ({
      id: user.id,
      username: user.name,
      display_name: user.display_name || user.name,
      real_name: user.real_name || user.name,
    }));

    // Slack usernames are unique. Human-readable names are not, so they always
    // require an explicit candidate selection unless the caller supplied an ID.
    if (exactUsername && candidates.length === 1) {
      actualUserId = candidates[0].id;
    } else {
      const status =
        candidates.length > 0
          ? 'recipient_confirmation_required'
          : searchResult.exhaustive
            ? 'recipient_not_found'
            : 'recipient_search_incomplete';
      const message =
        candidates.length > 0
          ? 'Recipient confirmation required; no message was sent. Choose a candidate and call send_direct_message again with its ID or exact @username.'
          : searchResult.exhaustive
            ? `No Slack user matched "${input.user}"; no message was sent.`
            : 'No match was found within the bounded search. No message was sent; continue with search_users using next_cursor.';

      return {
        success: false,
        status,
        query: input.user,
        candidates,
        source: searchResult.source,
        search_complete: searchResult.exhaustive,
        scanned_users: searchResult.scannedUsers,
        next_cursor: searchResult.nextCursor,
        message,
      };
    }
  }

  // Open or get existing DM conversation
  const channelId = await client.openDirectMessage(actualUserId);

  // Send the DM
  const response = await client.sendMessage({
    channel: channelId,
    text,
    thread_ts: input.thread_ts,
  });

  return {
    success: true,
    channel: response.channel,
    ts: response.ts,
    message: 'Direct message sent successfully',
  };
}

/**
 * Tool: reply_to_thread
 * Reply to a specific thread in a channel
 */
export const replyToThreadTool = {
  name: 'reply_to_thread',
  description:
    'Reply to a specific thread in a Slack channel. Use this to add messages to existing conversation threads.',
  inputSchema: z.object({
    channel: z.string().describe('Channel ID where the thread exists (e.g., C1234567890)'),
    thread_ts: slackTimestampSchema.describe(
      'Parent message timestamp of the thread (e.g., 1234567890.123456)',
    ),
    text: z.string().min(1).max(40000).describe('Reply content to send'),
    broadcast: z
      .boolean()
      .optional()
      .default(false)
      .describe('Also post to main channel (default: false, reply stays in thread)'),
  }),
};

export async function handleReplyToThread(
  input: ReplyToThreadInput,
  client: SlackClient,
): Promise<MessageToolOutput> {
  // Validate and sanitize input
  const text = sanitizeText(input.text);
  if (!validateMessageLength(text)) {
    throw new Error('Message text must be between 1 and 40,000 characters');
  }

  const channel = normalizeChannelId(input.channel);

  logger.info('Replying to thread', {
    channel,
    thread_ts: input.thread_ts,
    broadcast: input.broadcast,
  });

  // Send the reply
  const response = await client.sendMessage({
    channel,
    text,
    thread_ts: input.thread_ts,
    reply_broadcast: input.broadcast,
  });

  return {
    success: true,
    channel: response.channel,
    ts: response.ts,
    message: input.broadcast
      ? 'Reply sent to thread and broadcast to channel'
      : 'Reply sent to thread successfully',
  };
}

/**
 * Tool: edit_message
 * Edit a previously sent message
 */
export const editMessageTool = {
  name: 'edit_message',
  description:
    'Edit a previously sent message in a Slack channel. You can only edit messages sent by your user/bot. Requires the message timestamp (ts) which is returned when sending messages.',
  inputSchema: z.object({
    channel: z.string().describe('Channel ID where the message exists (e.g., C1234567890)'),
    timestamp: slackTimestampSchema.describe('Message timestamp to edit (e.g., 1234567890.123456)'),
    text: z
      .string()
      .min(1)
      .max(40000)
      .describe('New message content (replaces the existing message)'),
  }),
};

export async function handleEditMessage(
  input: EditMessageInput,
  client: SlackClient,
): Promise<MessageToolOutput> {
  // Validate and sanitize input
  const text = sanitizeText(input.text);
  if (!validateMessageLength(text)) {
    throw new Error('Message text must be between 1 and 40,000 characters');
  }

  const channel = normalizeChannelId(input.channel);

  logger.info('Editing message', {
    channel,
    timestamp: input.timestamp,
  });

  // Update the message
  const response = await client.updateMessage({
    channel,
    ts: input.timestamp,
    text,
  });

  return {
    success: true,
    channel: response.channel,
    ts: response.ts,
    message: 'Message edited successfully',
  };
}

/**
 * Tool: delete_message
 * Delete a previously sent message
 */
export const deleteMessageTool = {
  name: 'delete_message',
  description:
    'Delete a previously sent message from a Slack channel. You can only delete messages sent by your user/bot. Requires the message timestamp (ts) which is returned when sending messages.',
  inputSchema: z.object({
    channel: z.string().describe('Channel ID where the message exists (e.g., C1234567890)'),
    timestamp: slackTimestampSchema.describe(
      'Message timestamp to delete (e.g., 1234567890.123456)',
    ),
  }),
};

export async function handleDeleteMessage(
  input: DeleteMessageInput,
  client: SlackClient,
): Promise<MessageToolOutput> {
  const channel = normalizeChannelId(input.channel);

  logger.info('Deleting message', {
    channel,
    timestamp: input.timestamp,
  });

  // Delete the message
  await client.deleteMessage({
    channel,
    ts: input.timestamp,
  });

  return {
    success: true,
    channel,
    ts: input.timestamp,
    message: 'Message deleted successfully',
  };
}
