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
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { LazySlackClientProvider } from './lazy-slack-client.js';
import type { SlackClient } from './slack-client.js';
import {
  fetchChannelMessagesTool,
  handleFetchChannelMessages,
  fetchThreadMessagesTool,
  handleFetchThreadMessages,
} from './tools/fetch-tools.js';
import {
  downloadFileTool,
  getFileInfoTool,
  handleDownloadFile,
  handleGetFileInfo,
} from './tools/file-tools.js';
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
} from './tools/message-tools.js';
import { addReactionTool, handleAddReaction } from './tools/reaction-tools.js';
import { searchMessagesTool, handleSearchMessages } from './tools/search-tools.js';
import { searchUsersTool, handleSearchUsers } from './tools/user-tools.js';
import { formatErrorForMCP, handleSlackError } from './utils/errors.js';
import { logger } from './utils/logger.js';
import type * as ToolFormatters from './utils/tool-formatters.js';

let responseFormat: 'toon' | 'json' = 'toon';

const slackClientProvider = new LazySlackClientProvider(async (signal) => {
  logger.info('Loading Slack client for first tool call');
  const { loadSlackRuntimeConfig } = await import('./config.js');
  const config = await loadSlackRuntimeConfig({ signal });
  responseFormat = config.responseFormat;
  logger.setLevel(config.logLevel);
  logger.info(`Response format: ${responseFormat}`);
  const { SlackClient } = await import('./slack-client.js');
  return new SlackClient({
    cookieD: config.cookieD,
    workspaceUrl: config.workspaceUrl,
    userAgent: config.userAgent,
    logLevel: config.logLevel,
    userCacheFile: config.userCacheFile,
  });
});

let toolFormattersPromise: Promise<typeof ToolFormatters> | undefined;

function getToolFormatters(): Promise<typeof ToolFormatters> {
  toolFormattersPromise ??= import('./utils/tool-formatters.js');
  return toolFormattersPromise;
}

// Create MCP server
const server = new Server(
  {
    name: 'slack-mcp',
    version: '1.6.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

interface ToolDefinition<TSchema extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TSchema;
}

interface RegisteredTool {
  definition: ToolDefinition;
  run(args: unknown, signal?: AbortSignal): Promise<CallToolResult>;
}

let listedTools:
  | Array<{
      name: string;
      description: string;
      inputSchema: ReturnType<typeof zodToJsonSchema>;
    }>
  | undefined;

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function registerJsonTool<TSchema extends ZodTypeAny, TResult>(
  definition: ToolDefinition<TSchema>,
  handler: (input: TSchema['_output'], client: SlackClient) => Promise<TResult>,
): RegisteredTool {
  return {
    definition,
    async run(args, signal) {
      const input = definition.inputSchema.parse(args);
      const result = await slackClientProvider.run((client) => handler(input, client), signal);
      return textResult(stringifyJson(result));
    },
  };
}

function registerFormattedTool<TSchema extends ZodTypeAny, TResult>(
  definition: ToolDefinition<TSchema>,
  handler: (input: TSchema['_output'], client: SlackClient) => Promise<TResult>,
  formatter: (formatters: typeof ToolFormatters, result: TResult, client: SlackClient) => string,
): RegisteredTool {
  return {
    definition,
    async run(args, signal) {
      const input = definition.inputSchema.parse(args);
      const { result, client } = await slackClientProvider.run(
        async (client) => ({ result: await handler(input, client), client }),
        signal,
      );

      if (responseFormat === 'json') {
        return textResult(stringifyJson(result));
      }

      return textResult(formatter(await getToolFormatters(), result, client));
    },
  };
}

const coreTools: RegisteredTool[] = [
  registerJsonTool(sendMessageTool, handleSendMessage),
  registerJsonTool(sendDirectMessageTool, handleSendDirectMessage),
  registerJsonTool(replyToThreadTool, handleReplyToThread),
  registerJsonTool(editMessageTool, handleEditMessage),
  registerJsonTool(deleteMessageTool, handleDeleteMessage),
  registerFormattedTool(
    fetchChannelMessagesTool,
    handleFetchChannelMessages,
    (formatters, result, client) =>
      formatters.formatFetchMessagesResponse(result, 'toon', client.getUserCache()),
  ),
  registerFormattedTool(
    fetchThreadMessagesTool,
    handleFetchThreadMessages,
    (formatters, result, client) =>
      formatters.formatFetchMessagesResponse(result, 'toon', client.getUserCache()),
  ),
  registerJsonTool(addReactionTool, handleAddReaction),
  registerFormattedTool(searchUsersTool, handleSearchUsers, (formatters, result) =>
    formatters.formatSearchUsersResponse(result, 'toon'),
  ),
  registerFormattedTool(searchMessagesTool, handleSearchMessages, (formatters, result, client) =>
    formatters.formatSearchMessagesResponse(result, 'toon', client.getUserCache()),
  ),
  registerJsonTool(getFileInfoTool, handleGetFileInfo),
  registerJsonTool(downloadFileTool, handleDownloadFile),
];

const registeredTools = [...coreTools];
if (process.env.SLACK_ENABLE_SCHEDULE_MESSAGE === '1') {
  const schedule = await import('./tools/schedule-tools.js');
  registeredTools.push(
    registerJsonTool(schedule.scheduleMessageTool, schedule.handleScheduleMessage),
  );
}

const toolsByName = new Map<string, RegisteredTool>();
for (const tool of registeredTools) {
  if (toolsByName.has(tool.definition.name)) {
    throw new Error(`Duplicate tool registration: ${tool.definition.name}`);
  }
  toolsByName.set(tool.definition.name, tool);
}

function getListedTools() {
  listedTools ??= registeredTools.map(({ definition }) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: zodToJsonSchema(definition.inputSchema),
  }));
  return listedTools;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getListedTools() }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  try {
    logger.info(`Tool called: ${name}`);
    const tool = toolsByName.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return await tool.run(args, extra.signal);
  } catch (error) {
    logger.error(`Tool execution failed: ${name}`, error);
    return formatErrorForMCP(handleSlackError(error, name));
  }
});

// Start the server
async function main() {
  try {
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
