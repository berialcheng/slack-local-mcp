/**
 * Reaction tools for adding emoji reactions to messages
 */

import { z } from 'zod';
import { SlackClient } from '../slack-client.js';
import { AddReactionInput, ReactionToolOutput } from '../types.js';
import { logger } from '../utils/logger.js';
import { handleSlackError, formatErrorForMCP } from '../utils/errors.js';
import { normalizeChannelId, normalizeEmojiName } from '../utils/validation.js';

/**
 * Tool: add_reaction
 * Add an emoji reaction to a message
 */
export const addReactionTool = {
  name: 'add_reaction',
  description: 'Add an emoji reaction to a Slack message. Use this to acknowledge messages, show approval, or provide quick feedback without sending a full message. Common reactions include thumbsup, tada, rocket, eyes, white_check_mark.',
  inputSchema: z.object({
    channel: z.string().describe('Channel ID where the message exists (e.g., C1234567890)'),
    timestamp: z.string().describe('Message timestamp to react to (e.g., 1234567890.123456)'),
    reaction: z.string().describe('Emoji name without colons (e.g., thumbsup, tada, rocket, heart). Use standard emoji names or custom workspace emoji names.'),
  }),
};

export async function handleAddReaction(
  input: AddReactionInput,
  client: SlackClient
): Promise<ReactionToolOutput | ReturnType<typeof formatErrorForMCP>> {
  try {
    const channel = normalizeChannelId(input.channel);
    
    // Normalize emoji name (remove colons if present)
    const emojiName = normalizeEmojiName(input.reaction);
    
    logger.info('Adding reaction', {
      channel,
      timestamp: input.timestamp,
      emoji: emojiName,
    });

    // Add the reaction
    await client.addReaction({
      channel,
      timestamp: input.timestamp,
      name: emojiName,
    });

    return {
      success: true,
      message: `Successfully added :${emojiName}: reaction to message`,
    };
  } catch (error) {
    logger.error('Failed to add reaction', error);
    const slackError = handleSlackError(error, 'add_reaction');
    return formatErrorForMCP(slackError);
  }
}