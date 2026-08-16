import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(projectRoot, 'build', 'index.js');
const windowsLauncher = path.join(projectRoot, 'scripts', 'start-windows.mjs');

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && !name.startsWith('SLACK_'),
  ),
);

test('completes MCP startup without loading or authenticating the Slack client', async () => {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: projectRoot,
    env: {
      ...inheritedEnvironment,
      LOG_LEVEL: 'debug',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));

  const client = new Client({ name: 'lazy-startup-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const tools = await client.listTools();

    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'add_reaction',
      'delete_message',
      'download_file',
      'edit_message',
      'fetch_channel_messages',
      'fetch_thread_messages',
      'get_file_info',
      'reply_to_thread',
      'search_messages',
      'search_users',
      'send_direct_message',
      'send_message',
    ]);

    const searchUsers = tools.tools.find((tool) => tool.name === 'search_users');
    assert.equal(searchUsers.inputSchema.properties.limit.default, 5);
    assert.equal(searchUsers.inputSchema.properties.refresh_cache.default, false);
    assert.equal(searchUsers.inputSchema.properties.cursor.type, 'string');
    assert.equal(searchUsers.inputSchema.properties.cursor.maxLength, 1000);

    const fetchChannelMessages = tools.tools.find((tool) => tool.name === 'fetch_channel_messages');
    assert.equal(
      fetchChannelMessages.inputSchema.properties.channel.pattern,
      '^[CGD][A-Z0-9]{8,}$',
    );

    // Allow any accidentally-started background authentication to emit a log.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const output = stderr.join('');
    assert.doesNotMatch(output, /Loading Slack client for first tool call/);
    assert.doesNotMatch(output, /Authenticating with Slack/);
  } finally {
    await transport.close();
  }
});

test('returns missing lazy configuration as a top-level MCP tool error', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: projectRoot,
    env: inheritedEnvironment,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'lazy-config-error-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'get_file_info',
      arguments: { file: 'F0000000000' },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Missing required Slack configuration/);
    assert.doesNotMatch(result.content[0].text, /"isError"/);
  } finally {
    await transport.close();
  }
});

test('rejects malformed tool input before loading configuration or Slack', async () => {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: projectRoot,
    env: inheritedEnvironment,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));
  const client = new Client({ name: 'lazy-validation-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const invalidCalls = [
      { name: 'get_file_info', arguments: {} },
      { name: 'send_direct_message', arguments: { user: '   ', text: 'hello' } },
      { name: 'fetch_channel_messages', arguments: { channel: '#general' } },
      {
        name: 'reply_to_thread',
        arguments: { channel: 'C12345678', thread_ts: '', text: 'hello' },
      },
    ];
    for (const request of invalidCalls) {
      const result = await client.callTool(request);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Invalid tool input/);
    }
    assert.doesNotMatch(stderr.join(''), /Loading Slack client for first tool call/);
  } finally {
    await transport.close();
  }
});

test('the exact Windows launcher does not query HKCU before the first tool call', async () => {
  if (process.platform !== 'win32') return;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [windowsLauncher],
    cwd: projectRoot,
    env: {
      ...inheritedEnvironment,
      // A registry read would fail, but handshake/listTools must still work.
      SystemRoot: 'C:\\slack-local-mcp-nonexistent-system-root',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'lazy-windows-launcher-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 12);
    assert.ok(!tools.tools.some((tool) => tool.name === 'schedule_message'));
  } finally {
    await transport.close();
  }
});

test('unsupported schedule schema is an explicit process-only opt-in', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: projectRoot,
    env: {
      ...inheritedEnvironment,
      SLACK_ENABLE_SCHEDULE_MESSAGE: '1',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'schedule-opt-in-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 13);
    assert.ok(tools.tools.some((tool) => tool.name === 'schedule_message'));
  } finally {
    await transport.close();
  }
});
