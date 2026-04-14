#!/usr/bin/env node

/**
 * Slack MCP Server
 * Provides tools for interacting with Slack using cookie-based authentication
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { SlackClient } from './slack-client.js';
import { logger } from './utils/logger.js';
import { formatErrorForMCP } from './utils/errors.js';
import {
  formatFetchMessagesResponse,
  formatSearchMessagesResponse,
  formatSearchUsersResponse,
  formatListRemindersResponse,
} from './utils/tool-formatters.js';

// Import all tools
import {
  sendMessageTool,
  handleSendMessage,
  sendDirectMessageTool,
  handleSendDirectMessage,
  replyToThreadTool,
  handleReplyToThread,
  editMessageTool,
  handleEditMessage,
  deleteMessageTool,
  handleDeleteMessage,
  scheduleMessageTool,
  handleScheduleMessage,
  fetchChannelMessagesTool,
  handleFetchChannelMessages,
  fetchThreadMessagesTool,
  handleFetchThreadMessages,
  addReactionTool,
  handleAddReaction,
  listRemindersTool,
  handleListReminders,
  createReminderTool,
  handleCreateReminder,
  completeReminderTool,
  handleCompleteReminder,
  deleteReminderTool,
  handleDeleteReminder,
  searchUsersTool,
  handleSearchUsers,
  searchMessagesTool,
  handleSearchMessages,
} from './tools/index.js';

// Validate required environment variables
const cookieD = process.env.SLACK_COOKIE_D;
const workspaceUrl = process.env.SLACK_WORKSPACE_URL;

if (!cookieD) {
  console.error('Error: SLACK_COOKIE_D environment variable is required');
  console.error('Please set your Slack session cookie in the environment configuration');
  process.exit(1);
}

if (!workspaceUrl) {
  console.error('Error: SLACK_WORKSPACE_URL environment variable is required');
  console.error('Please set your Slack workspace URL (e.g., https://your-workspace.slack.com)');
  process.exit(1);
}

// TypeScript type assertions - variables are guaranteed to be strings after the checks above
const slackCookie: string = cookieD;
const slackWorkspaceUrl: string = workspaceUrl;

// Response format configuration (TOON for token efficiency, JSON for compatibility)
const responseFormat = (process.env.SLACK_RESPONSE_FORMAT || 'toon') as 'toon' | 'json';
if (responseFormat !== 'toon' && responseFormat !== 'json') {
  console.error(`Error: SLACK_RESPONSE_FORMAT must be 'toon' or 'json', got: ${responseFormat}`);
  process.exit(1);
}
logger.info(`Response format: ${responseFormat}`);

// Initialize Slack client
let slackClient: SlackClient;

async function initializeClient(): Promise<void> {
  try {
    slackClient = new SlackClient({
      cookieD: slackCookie,
      workspaceUrl: slackWorkspaceUrl,
      userAgent: process.env.SLACK_USER_AGENT,
      logLevel: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
      userCacheFile: process.env.SLACK_USER_CACHE_FILE,
    });

    // Authenticate
    await slackClient.authenticate();

    logger.info('Slack MCP Server initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize Slack client', error);
    throw error;
  }
}

// Create MCP server
const server = new Server(
  {
    name: 'slack-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: sendMessageTool.name,
        description: sendMessageTool.description,
        inputSchema: zodToJsonSchema(sendMessageTool.inputSchema),
      },
      {
        name: sendDirectMessageTool.name,
        description: sendDirectMessageTool.description,
        inputSchema: zodToJsonSchema(sendDirectMessageTool.inputSchema),
      },
      {
        name: replyToThreadTool.name,
        description: replyToThreadTool.description,
        inputSchema: zodToJsonSchema(replyToThreadTool.inputSchema),
      },
      {
        name: editMessageTool.name,
        description: editMessageTool.description,
        inputSchema: zodToJsonSchema(editMessageTool.inputSchema),
      },
      {
        name: deleteMessageTool.name,
        description: deleteMessageTool.description,
        inputSchema: zodToJsonSchema(deleteMessageTool.inputSchema),
      },
      {
        name: scheduleMessageTool.name,
        description: scheduleMessageTool.description,
        inputSchema: zodToJsonSchema(scheduleMessageTool.inputSchema),
      },
      {
        name: fetchChannelMessagesTool.name,
        description: fetchChannelMessagesTool.description,
        inputSchema: zodToJsonSchema(fetchChannelMessagesTool.inputSchema),
      },
      {
        name: fetchThreadMessagesTool.name,
        description: fetchThreadMessagesTool.description,
        inputSchema: zodToJsonSchema(fetchThreadMessagesTool.inputSchema),
      },
      {
        name: addReactionTool.name,
        description: addReactionTool.description,
        inputSchema: zodToJsonSchema(addReactionTool.inputSchema),
      },
      {
        name: listRemindersTool.name,
        description: listRemindersTool.description,
        inputSchema: zodToJsonSchema(listRemindersTool.inputSchema),
      },
      {
        name: createReminderTool.name,
        description: createReminderTool.description,
        inputSchema: zodToJsonSchema(createReminderTool.inputSchema),
      },
      {
        name: completeReminderTool.name,
        description: completeReminderTool.description,
        inputSchema: zodToJsonSchema(completeReminderTool.inputSchema),
      },
      {
        name: deleteReminderTool.name,
        description: deleteReminderTool.description,
        inputSchema: zodToJsonSchema(deleteReminderTool.inputSchema),
      },
      {
        name: searchUsersTool.name,
        description: searchUsersTool.description,
        inputSchema: zodToJsonSchema(searchUsersTool.inputSchema),
      },
      {
        name: searchMessagesTool.name,
        description: searchMessagesTool.description,
        inputSchema: zodToJsonSchema(searchMessagesTool.inputSchema),
      },
    ],
  };
});

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    logger.info(`Tool called: ${name}`);

    // Route to appropriate handler
    switch (name) {
      case 'send_message': {
        const validatedInput = sendMessageTool.inputSchema.parse(args);
        const result = await handleSendMessage(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'send_direct_message': {
        const validatedInput = sendDirectMessageTool.inputSchema.parse(args);
        const result = await handleSendDirectMessage(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'reply_to_thread': {
        const validatedInput = replyToThreadTool.inputSchema.parse(args);
        const result = await handleReplyToThread(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'edit_message': {
        const validatedInput = editMessageTool.inputSchema.parse(args);
        const result = await handleEditMessage(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'delete_message': {
        const validatedInput = deleteMessageTool.inputSchema.parse(args);
        const result = await handleDeleteMessage(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'schedule_message': {
        const validatedInput = scheduleMessageTool.inputSchema.parse(args);
        const result = await handleScheduleMessage(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'fetch_channel_messages': {
        const validatedInput = fetchChannelMessagesTool.inputSchema.parse(args);
        const result = await handleFetchChannelMessages(validatedInput, slackClient);
        const userCache = slackClient.getUserCache();
        return {
          content: [{
            type: 'text',
            text: formatFetchMessagesResponse(result, responseFormat, userCache),
          }],
        };
      }

      case 'fetch_thread_messages': {
        const validatedInput = fetchThreadMessagesTool.inputSchema.parse(args);
        const result = await handleFetchThreadMessages(validatedInput, slackClient);
        const userCache = slackClient.getUserCache();
        return {
          content: [{
            type: 'text',
            text: formatFetchMessagesResponse(result, responseFormat, userCache),
          }],
        };
      }

      case 'add_reaction': {
        const validatedInput = addReactionTool.inputSchema.parse(args);
        const result = await handleAddReaction(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'list_reminders': {
        const validatedInput = listRemindersTool.inputSchema.parse(args);
        const result = await handleListReminders(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: formatListRemindersResponse(result, responseFormat),
          }],
        };
      }

      case 'create_reminder': {
        const validatedInput = createReminderTool.inputSchema.parse(args);
        const result = await handleCreateReminder(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'complete_reminder': {
        const validatedInput = completeReminderTool.inputSchema.parse(args);
        const result = await handleCompleteReminder(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'delete_reminder': {
        const validatedInput = deleteReminderTool.inputSchema.parse(args);
        const result = await handleDeleteReminder(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'search_users': {
        const validatedInput = searchUsersTool.inputSchema.parse(args);
        const result = await handleSearchUsers(validatedInput, slackClient);
        return {
          content: [{
            type: 'text',
            text: formatSearchUsersResponse(result, responseFormat),
          }],
        };
      }

      case 'search_messages': {
        const validatedInput = searchMessagesTool.inputSchema.parse(args);
        const result = await handleSearchMessages(validatedInput, slackClient);
        const userCache = slackClient.getUserCache();
        return {
          content: [{
            type: 'text',
            text: formatSearchMessagesResponse(result, responseFormat, userCache),
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error('Tool execution error', error);
    const errorResponse = formatErrorForMCP(error as any);
    return errorResponse;
  }
});

// Start the server
async function main() {
  try {
    // Initialize Slack client
    await initializeClient();

    // Create transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    logger.info('Slack MCP Server running on stdio');
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  await server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  await server.close();
  process.exit(0);
});

// Run the server
main().catch((error) => {
  logger.error('Fatal error in main', error);
  process.exit(1);
});