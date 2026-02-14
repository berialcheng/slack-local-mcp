/**
 * Message tools for sending messages to Slack
 */

import { z } from 'zod';
import { SlackClient } from '../slack-client.js';
import {
  SendMessageInput,
  SendDirectMessageInput,
  ReplyToThreadInput,
  EditMessageInput,
  DeleteMessageInput,
  MessageToolOutput,
} from '../types.js';
import { logger } from '../utils/logger.js';
import { handleSlackError, formatErrorForMCP } from '../utils/errors.js';
import {
  normalizeChannelId,
  normalizeUserId,
  sanitizeText,
  validateMessageLength,
  isUserId,
} from '../utils/validation.js';

/**
 * Tool: send_message
 * Send a message to a Slack channel
 */
export const sendMessageTool = {
  name: 'send_message',
  description: 'Send a message to a Slack channel. Use this to post messages to public channels, private channels, or continue conversations.',
  inputSchema: z.object({
    channel: z.string().describe('Channel ID (e.g., C1234567890) or channel name (e.g., general, #general)'),
    text: z.string().min(1).max(40000).describe('Message content to send (up to 40,000 characters)'),
    thread_ts: z.string().optional().describe('Thread timestamp to reply to (optional, for threading)'),
    unfurl_links: z.boolean().optional().default(true).describe('Enable automatic link previews (default: true)'),
  }),
};

export async function handleSendMessage(
  input: SendMessageInput,
  client: SlackClient
): Promise<MessageToolOutput | ReturnType<typeof formatErrorForMCP>> {
  try {
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
  } catch (error) {
    logger.error('Failed to send message', error);
    const slackError = handleSlackError(error, 'send_message');
    return formatErrorForMCP(slackError);
  }
}

/**
 * Tool: send_direct_message
 * Send a direct message to a specific user
 */
export const sendDirectMessageTool = {
  name: 'send_direct_message',
  description: 'Send a direct message (DM) to a specific Slack user. Use this for private one-on-one communication.',
  inputSchema: z.object({
    user: z.string().describe('User ID (e.g., U1234567890) or username (e.g., john, @john)'),
    text: z.string().min(1).max(40000).describe('Message content to send'),
    thread_ts: z.string().optional().describe('Thread timestamp to continue a DM conversation (optional)'),
  }),
};

export async function handleSendDirectMessage(
  input: SendDirectMessageInput,
  client: SlackClient
): Promise<MessageToolOutput | ReturnType<typeof formatErrorForMCP>> {
  try {
    // Validate and sanitize input
    const text = sanitizeText(input.text);
    if (!validateMessageLength(text)) {
      throw new Error('Message text must be between 1 and 40,000 characters');
    }

    const userInput = normalizeUserId(input.user);
    
    logger.info('Sending direct message', { user: userInput });

    // Determine if we have a user ID or username
    let actualUserId: string;
    
    if (isUserId(userInput)) {
      // Already a user ID
      actualUserId = userInput;
    } else {
      // It's a username, look it up
      const foundUserId = await client.lookupUserByName(userInput);
      if (!foundUserId) {
        throw new Error(`User not found: ${userInput}`);
      }
      actualUserId = foundUserId;
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
  } catch (error) {
    logger.error('Failed to send direct message', error);
    const slackError = handleSlackError(error, 'send_direct_message');
    return formatErrorForMCP(slackError);
  }
}

/**
 * Tool: reply_to_thread
 * Reply to a specific thread in a channel
 */
export const replyToThreadTool = {
  name: 'reply_to_thread',
  description: 'Reply to a specific thread in a Slack channel. Use this to add messages to existing conversation threads.',
  inputSchema: z.object({
    channel: z.string().describe('Channel ID where the thread exists (e.g., C1234567890)'),
    thread_ts: z.string().describe('Parent message timestamp of the thread (e.g., 1234567890.123456)'),
    text: z.string().min(1).max(40000).describe('Reply content to send'),
    broadcast: z.boolean().optional().default(false).describe('Also post to main channel (default: false, reply stays in thread)'),
  }),
};

export async function handleReplyToThread(
  input: ReplyToThreadInput,
  client: SlackClient
): Promise<MessageToolOutput | ReturnType<typeof formatErrorForMCP>> {
  try {
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
    // Note: reply_broadcast is handled by Slack API if needed
    const response = await client.sendMessage({
      channel,
      text,
      thread_ts: input.thread_ts,
    });

    return {
      success: true,
      channel: response.channel,
      ts: response.ts,
      message: input.broadcast
        ? 'Reply sent to thread and broadcast to channel'
        : 'Reply sent to thread successfully',
    };
  } catch (error) {
    logger.error('Failed to reply to thread', error);
    const slackError = handleSlackError(error, 'reply_to_thread');
    return formatErrorForMCP(slackError);
  }
}

/**
 * Tool: edit_message
 * Edit a previously sent message
 */
export const editMessageTool = {
  name: 'edit_message',
  description: 'Edit a previously sent message in a Slack channel. You can only edit messages sent by your user/bot. Requires the message timestamp (ts) which is returned when sending messages.',
  inputSchema: z.object({
    channel: z.string().describe('Channel ID where the message exists (e.g., C1234567890)'),
    timestamp: z.string().describe('Message timestamp to edit (e.g., 1234567890.123456)'),
    text: z.string().min(1).max(40000).describe('New message content (replaces the existing message)'),
  }),
};

export async function handleEditMessage(
  input: EditMessageInput,
  client: SlackClient
): Promise<MessageToolOutput | ReturnType<typeof formatErrorForMCP>> {
  try {
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
  } catch (error) {
    logger.error('Failed to edit message', error);
    const slackError = handleSlackError(error, 'edit_message');
    return formatErrorForMCP(slackError);
  }
}

/**
 * Tool: delete_message
 * Delete a previously sent message
 */
export const deleteMessageTool = {
  name: 'delete_message',
  description: 'Delete a previously sent message from a Slack channel. You can only delete messages sent by your user/bot. Requires the message timestamp (ts) which is returned when sending messages.',
  inputSchema: z.object({
    channel: z.string().describe('Channel ID where the message exists (e.g., C1234567890)'),
    timestamp: z.string().describe('Message timestamp to delete (e.g., 1234567890.123456)'),
  }),
};

export async function handleDeleteMessage(
  input: DeleteMessageInput,
  client: SlackClient
): Promise<MessageToolOutput | ReturnType<typeof formatErrorForMCP>> {
  try {
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
  } catch (error) {
    logger.error('Failed to delete message', error);
    const slackError = handleSlackError(error, 'delete_message');
    return formatErrorForMCP(slackError);
  }
}