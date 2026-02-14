/**
 * Reminder tools for managing Slack reminders
 */

import { z } from 'zod';
import { SlackClient } from '../slack-client.js';
import {
  CreateReminderInput,
  CompleteReminderInput,
  DeleteReminderInput,
  ReminderToolOutput,
  RemindersListOutput,
  FormattedReminder,
} from '../types.js';
import { logger } from '../utils/logger.js';
import { handleSlackError, formatErrorForMCP } from '../utils/errors.js';
import { sanitizeText } from '../utils/validation.js';

/**
 * Tool: list_reminders
 * List all reminders for the user
 */
export const listRemindersTool = {
  name: 'list_reminders',
  description: 'List all active reminders for the authenticated user. Shows pending and recurring reminders with their details.',
  inputSchema: z.object({}),
};

export async function handleListReminders(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _input: Record<string, never>,
  client: SlackClient
): Promise<RemindersListOutput | string | ReturnType<typeof formatErrorForMCP>> {
  try {
    logger.info('Listing reminders');

    const reminders = await client.listReminders();

    // Return simple string for empty list
    if (reminders.length === 0) {
      return 'No active reminders found.';
    }

    // Format reminders for output
    const formattedReminders: FormattedReminder[] = await Promise.all(
      reminders.map(async (reminder) => {
        const userName = await client.resolveUsername(reminder.user).catch(() => reminder.user);

        return {
          id: reminder.id,
          text: reminder.text,
          time: new Date(reminder.time * 1000).toISOString(), // Formatted only
          user: userName, // Resolved name only
          status: reminder.complete_ts > 0 ? 'completed' : (reminder.recurring ? 'recurring' : 'pending'),
        };
      })
    );

    return {
      reminders: formattedReminders,
      reminder_count: formattedReminders.length,
    };
  } catch (error) {
    logger.error('Failed to list reminders', error);
    const slackError = handleSlackError(error, 'list_reminders');
    return formatErrorForMCP(slackError);
  }
}

/**
 * Tool: create_reminder
 * Create a new reminder
 */
export const createReminderTool = {
  name: 'create_reminder',
  description: 'Create a new reminder for yourself or another user. The reminder will be delivered at the specified time.',
  inputSchema: z.object({
    text: z.string().min(1).max(1000).describe('Reminder text/message (up to 1000 characters)'),
    time: z.number().int().positive().describe('Unix timestamp (in seconds) when the reminder should trigger'),
    user: z.string().optional().describe('User ID to set reminder for (optional, defaults to yourself)'),
  }),
};

export async function handleCreateReminder(
  input: CreateReminderInput,
  client: SlackClient
): Promise<ReminderToolOutput | ReturnType<typeof formatErrorForMCP>> {
  try {
    const text = sanitizeText(input.text);
    if (!text || text.length > 1000) {
      throw new Error('Reminder text must be between 1 and 1000 characters');
    }

    // Validate time is in the future
    const now = Math.floor(Date.now() / 1000);
    if (input.time <= now) {
      const providedTime = new Date(input.time * 1000).toISOString();
      const currentTime = new Date(now * 1000).toISOString();
      throw new Error(
        `Reminder time must be in the future. Provided: ${providedTime} (${input.time}), Current: ${currentTime} (${now})`
      );
    }

    logger.info('Creating reminder', {
      text: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
      time: new Date(input.time * 1000).toISOString(),
      user: input.user || 'self',
    });

    const reminder = await client.createReminder({
      text,
      time: input.time,
      user: input.user,
    });

    return {
      success: true,
      reminder_id: reminder.id,
      message: `Reminder created successfully for ${new Date(reminder.time * 1000).toISOString()}`,
    };
  } catch (error) {
    logger.error('Failed to create reminder', error);
    const slackError = handleSlackError(error, 'create_reminder');
    return formatErrorForMCP(slackError);
  }
}

/**
 * Tool: complete_reminder
 * Mark a reminder as completed
 */
export const completeReminderTool = {
  name: 'complete_reminder',
  description: 'Mark a reminder as completed. This removes it from the active reminders list.',
  inputSchema: z.object({
    reminder_id: z.string().describe('ID of the reminder to complete (from list_reminders)'),
  }),
};

export async function handleCompleteReminder(
  input: CompleteReminderInput,
  client: SlackClient
): Promise<ReminderToolOutput | ReturnType<typeof formatErrorForMCP>> {
  try {
    logger.info('Completing reminder', { reminder_id: input.reminder_id });

    await client.completeReminder(input.reminder_id);

    return {
      success: true,
      reminder_id: input.reminder_id,
      message: 'Reminder marked as completed',
    };
  } catch (error) {
    logger.error('Failed to complete reminder', error);
    const slackError = handleSlackError(error, 'complete_reminder');
    return formatErrorForMCP(slackError);
  }
}

/**
 * Tool: delete_reminder
 * Delete a reminder
 */
export const deleteReminderTool = {
  name: 'delete_reminder',
  description: 'Delete a reminder permanently. This removes it from the reminders list.',
  inputSchema: z.object({
    reminder_id: z.string().describe('ID of the reminder to delete (from list_reminders)'),
  }),
};

export async function handleDeleteReminder(
  input: DeleteReminderInput,
  client: SlackClient
): Promise<ReminderToolOutput | ReturnType<typeof formatErrorForMCP>> {
  try {
    logger.info('Deleting reminder', { reminder_id: input.reminder_id });

    await client.deleteReminder(input.reminder_id);

    return {
      success: true,
      reminder_id: input.reminder_id,
      message: 'Reminder deleted successfully',
    };
  } catch (error) {
    logger.error('Failed to delete reminder', error);
    const slackError = handleSlackError(error, 'delete_reminder');
    return formatErrorForMCP(slackError);
  }
}