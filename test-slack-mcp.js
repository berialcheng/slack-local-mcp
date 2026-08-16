#!/usr/bin/env node

/**
 * Guarded live smoke test for the public Slack MCP tool boundary.
 *
 * Required:
 *   SLACK_LIVE_SELF_NAME='Exact Slack display or real name'
 *
 * Optional:
 *   SLACK_LIVE_ALLOW_WRITES=1   Enable self-DM writes and cleanup.
 *   SLACK_LIVE_FILE=F012ABCDEF  Check metadata and an eligible temp download.
 *   SLACK_LIVE_TEST_SCHEDULE=1  Schedule and immediately cancel a self-DM.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const windowsLauncher = path.join(projectRoot, 'scripts', 'start-windows.mjs');
const serverEntrypoint = path.join(projectRoot, 'build', 'index.js');

const expectedTools = [
  'send_message',
  'send_direct_message',
  'reply_to_thread',
  'edit_message',
  'delete_message',
  'fetch_channel_messages',
  'fetch_thread_messages',
  'add_reaction',
  'search_users',
  'search_messages',
  'get_file_info',
  'download_file',
];

class ToolCallError extends Error {
  constructor(tool, message) {
    super(`${tool}: ${message}`);
    this.name = 'ToolCallError';
    this.tool = tool;
  }
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function userNames(user) {
  return [user.name, user.profile?.display_name, user.profile?.real_name].filter(Boolean);
}

function record(checks, status, name, details) {
  checks.push({ status, name, details });
  const label = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'WARN';
  console.log(`${label.padEnd(4)} ${name}${details ? ` - ${details}` : ''}`);
}

function textFromResult(result) {
  return (result.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function parseToolResult(tool, result) {
  const text = textFromResult(result);
  if (result.isError) {
    throw new ToolCallError(tool, text || 'unknown MCP tool error');
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loadAuthenticatedSelf(targetName) {
  const [{ loadSlackRuntimeConfig }, { SlackClient }] = await Promise.all([
    import('./build/config.js'),
    import('./build/slack-client.js'),
  ]);
  const config = await loadSlackRuntimeConfig({ useWindowsUserEnvironment: true });
  const slack = new SlackClient({
    cookieD: config.cookieD,
    workspaceUrl: config.workspaceUrl,
    userAgent: config.userAgent,
    logLevel: 'error',
    userCacheFile: config.userCacheFile,
  });

  await slack.authenticate();
  const id = slack.getAuthenticatedUserId();
  const user = await slack.getUserInfo(id);
  const expected = normalizeName(targetName);
  assert.ok(
    userNames(user).some((name) => normalizeName(name) === expected),
    `Authenticated Slack user does not exactly match SLACK_LIVE_SELF_NAME=${JSON.stringify(targetName)}`,
  );

  return { slack, id, user };
}

async function main() {
  const targetName = (process.env.SLACK_LIVE_SELF_NAME || '').trim();
  const allowWrites = process.env.SLACK_LIVE_ALLOW_WRITES === '1';
  const fileReference = (process.env.SLACK_LIVE_FILE || '').trim();
  const testSchedule = process.env.SLACK_LIVE_TEST_SCHEDULE === '1';

  if (!targetName) {
    throw new Error(
      'SLACK_LIVE_SELF_NAME is required. No Slack request was made. Set it to the exact authenticated user name.',
    );
  }
  if (testSchedule && !allowWrites) {
    throw new Error('SLACK_LIVE_TEST_SCHEDULE=1 requires SLACK_LIVE_ALLOW_WRITES=1');
  }

  const enabledTools = testSchedule ? [...expectedTools, 'schedule_message'] : expectedTools;

  const checks = [];
  const trackedMessages = [];
  const trackedDownloads = [];
  const trackedSchedules = [];
  const cleanupErrors = [];
  let transport;
  let mcp;
  let identity;
  let primaryError;

  const callTool = async (name, args = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    return parseToolResult(name, result);
  };

  const forget = (collection, item) => {
    const index = collection.indexOf(item);
    if (index >= 0) collection.splice(index, 1);
  };

  try {
    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    );
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [process.platform === 'win32' ? windowsLauncher : serverEntrypoint],
      cwd: projectRoot,
      env: {
        ...inheritedEnvironment,
        LOG_LEVEL: 'error',
        SLACK_RESPONSE_FORMAT: 'json',
        SLACK_ENABLE_SCHEDULE_MESSAGE: testSchedule ? '1' : '0',
      },
      stderr: 'pipe',
    });
    // Drain stderr so a noisy failure cannot block the stdio child. It is not
    // echoed because integration errors may contain workspace-specific data.
    transport.stderr?.resume();

    mcp = new Client({ name: 'slack-local-live-self-smoke', version: '1.0.0' });
    await mcp.connect(transport);

    const listed = await mcp.listTools();
    const actualToolNames = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(actualToolNames, [...enabledTools].sort());
    record(checks, 'pass', 'MCP handshake and registry', `${actualToolNames.length} tools`);

    const users = await callTool('search_users', {
      query: targetName,
      limit: 5,
    });
    assert.ok(isObject(users) && Array.isArray(users.results), 'search_users returned no results');
    record(
      checks,
      'pass',
      'search_users',
      `${users.match_count} result(s) via ${users.source || 'unknown source'}; exhaustive=${users.exhaustive}`,
    );

    if (allowWrites) {
      identity = await loadAuthenticatedSelf(targetName);
      record(checks, 'pass', 'authenticated self identity', `${targetName} (${identity.id})`);
    }

    if (fileReference) {
      const metadata = await callTool('get_file_info', { file: fileReference });
      assert.ok(isObject(metadata) && isObject(metadata.file), 'get_file_info returned no file');
      assert.doesNotMatch(JSON.stringify(metadata), /url_private|xox[acdpors]-/i);
      record(
        checks,
        'pass',
        'get_file_info',
        `${metadata.file.id} ${metadata.file.mimetype} ${metadata.file.size} bytes`,
      );

      const download = await callTool('download_file', { file: fileReference });
      if (download.downloaded) {
        assert.equal(typeof download.path, 'string');
        assert.ok(isPathInside(path.join(os.tmpdir(), 'slack-local-mcp'), download.path));
        const stats = await fs.stat(download.path);
        assert.equal(stats.size, download.bytes);
        assert.equal(await sha256File(download.path), download.sha256);
        trackedDownloads.push(download.path);
        record(checks, 'pass', 'download_file', `${download.bytes} bytes verified in TEMP`);
      } else {
        record(checks, 'skip', 'download_file', download.reason || 'file policy skipped it');
      }
    } else {
      record(checks, 'skip', 'file tools', 'SLACK_LIVE_FILE was not set');
    }

    if (!allowWrites) {
      record(
        checks,
        'skip',
        'Slack write tools',
        'set SLACK_LIVE_ALLOW_WRITES=1 after reviewing the target identity',
      );
    } else {
      const marker = `SLACKMCP${Date.now()}${randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const root = await callTool('send_direct_message', {
        user: identity.id,
        text: `${marker} temporary self-DM smoke root; this message will be deleted.`,
      });
      assert.ok(root.success && root.channel && root.ts);
      const rootRecord = { channel: root.channel, timestamp: root.ts, label: 'self-DM root' };
      trackedMessages.push(rootRecord);
      record(checks, 'pass', 'send_direct_message', `self-DM ${root.channel}`);

      const second = await callTool('send_message', {
        channel: root.channel,
        text: `${marker} temporary send_message smoke; this message will be deleted.`,
        unfurl_links: false,
      });
      assert.ok(second.success && second.channel === root.channel && second.ts);
      const secondRecord = {
        channel: second.channel,
        timestamp: second.ts,
        label: 'send_message root',
      };
      trackedMessages.push(secondRecord);
      record(checks, 'pass', 'send_message', 'same authenticated self-DM');

      const edited = await callTool('edit_message', {
        channel: root.channel,
        timestamp: root.ts,
        text: `${marker} temporary self-DM smoke root EDITED; this message will be deleted.`,
      });
      assert.ok(edited.success && edited.ts === root.ts);
      record(checks, 'pass', 'edit_message');

      const reaction = await callTool('add_reaction', {
        channel: root.channel,
        timestamp: root.ts,
        reaction: 'white_check_mark',
      });
      assert.equal(reaction.success, true);
      record(checks, 'pass', 'add_reaction');

      const reply = await callTool('reply_to_thread', {
        channel: root.channel,
        thread_ts: root.ts,
        text: `${marker} temporary thread reply; this message will be deleted.`,
        broadcast: false,
      });
      assert.ok(reply.success && reply.channel === root.channel && reply.ts);
      const replyRecord = {
        channel: reply.channel,
        timestamp: reply.ts,
        label: 'thread reply',
      };
      trackedMessages.push(replyRecord);
      record(checks, 'pass', 'reply_to_thread', 'non-broadcast self-DM reply');

      const thread = await callTool('fetch_thread_messages', {
        channel: root.channel,
        thread_ts: root.ts,
        limit: 20,
      });
      assert.ok(isObject(thread) && Array.isArray(thread.messages));
      assert.ok(thread.messages.some((message) => message.ts === root.ts));
      assert.ok(thread.messages.some((message) => message.ts === reply.ts));
      record(checks, 'pass', 'fetch_thread_messages', `${thread.message_count} messages`);

      const channelMessages = await callTool('fetch_channel_messages', {
        channel: root.channel,
        limit: 20,
      });
      assert.ok(isObject(channelMessages) && Array.isArray(channelMessages.messages));
      assert.ok(channelMessages.messages.some((message) => message.ts === root.ts));
      assert.ok(channelMessages.messages.some((message) => message.ts === second.ts));
      record(checks, 'pass', 'fetch_channel_messages', `${channelMessages.message_count} messages`);

      let indexed = false;
      for (let attempt = 0; attempt < 5 && !indexed; attempt += 1) {
        const search = await callTool('search_messages', {
          query: marker,
          count: 20,
          page: 1,
          sort: 'timestamp',
          sort_dir: 'desc',
          highlight: false,
        });
        indexed =
          isObject(search) &&
          Array.isArray(search.messages) &&
          search.messages.some((message) => message.text.includes(marker));
        if (!indexed && attempt < 4) await delay(2_000);
      }
      record(
        checks,
        indexed ? 'pass' : 'warn',
        'search_messages',
        indexed
          ? 'new self-DM message indexed'
          : 'API succeeded; new message not indexed within 8s',
      );

      if (testSchedule) {
        try {
          const scheduled = await callTool('schedule_message', {
            channel: root.channel,
            text: `${marker} temporary scheduled self-DM; this schedule will be cancelled.`,
            post_at: Math.floor(Date.now() / 1000) + 300,
          });
          assert.ok(scheduled.success && scheduled.scheduled_message_id);
          const scheduleRecord = {
            channel: scheduled.channel,
            id: scheduled.scheduled_message_id,
          };
          trackedSchedules.push(scheduleRecord);
          record(checks, 'pass', 'schedule_message', 'self-DM scheduled');
          await identity.slack.deleteScheduledMessage({
            channel: scheduleRecord.channel,
            scheduled_message_id: scheduleRecord.id,
          });
          forget(trackedSchedules, scheduleRecord);
          record(checks, 'pass', 'scheduled-message cleanup', 'cancelled immediately');
        } catch (error) {
          if (error instanceof ToolCallError && /not_allowed_token_type/i.test(error.message)) {
            record(checks, 'skip', 'schedule_message', 'Slack cookie token type does not allow it');
          } else {
            throw error;
          }
        }
      } else {
        record(checks, 'skip', 'schedule_message', 'SLACK_LIVE_TEST_SCHEDULE was not set');
      }

      const deleted = await callTool('delete_message', {
        channel: secondRecord.channel,
        timestamp: secondRecord.timestamp,
      });
      assert.equal(deleted.success, true);
      forget(trackedMessages, secondRecord);
      record(checks, 'pass', 'delete_message');
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (identity) {
      for (const schedule of [...trackedSchedules].reverse()) {
        try {
          await identity.slack.deleteScheduledMessage({
            channel: schedule.channel,
            scheduled_message_id: schedule.id,
          });
          forget(trackedSchedules, schedule);
          record(checks, 'pass', 'cleanup scheduled message', schedule.id);
        } catch (error) {
          cleanupErrors.push(new Error(`Scheduled message ${schedule.id}: ${error.message}`));
        }
      }
    }

    if (mcp) {
      for (const message of [...trackedMessages].reverse()) {
        try {
          await callTool('delete_message', {
            channel: message.channel,
            timestamp: message.timestamp,
          });
          forget(trackedMessages, message);
          record(checks, 'pass', `cleanup ${message.label}`, message.timestamp);
        } catch (error) {
          cleanupErrors.push(new Error(`${message.label} ${message.timestamp}: ${error.message}`));
        }
      }
    }

    for (const filePath of [...trackedDownloads].reverse()) {
      try {
        await fs.unlink(filePath);
        forget(trackedDownloads, filePath);
        record(checks, 'pass', 'cleanup TEMP download', path.basename(filePath));
      } catch (error) {
        cleanupErrors.push(new Error(`TEMP file ${filePath}: ${error.message}`));
      }
    }

    if (transport) {
      try {
        await transport.close();
      } catch (error) {
        cleanupErrors.push(new Error(`MCP transport: ${error.message}`));
      }
    }
  }

  if (cleanupErrors.length > 0) {
    const details = cleanupErrors.map((error) => error.message).join('; ');
    if (primaryError) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        `Live smoke and cleanup failed: ${details}`,
      );
    }
    throw new AggregateError(cleanupErrors, `Live smoke cleanup failed: ${details}`);
  }
  if (primaryError) throw primaryError;

  const passed = checks.filter((check) => check.status === 'pass').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  const skipped = checks.filter((check) => check.status === 'skip').length;
  console.log(`DONE ${passed} passed, ${warnings} warnings, ${skipped} skipped; cleanup complete`);
}

main().catch((error) => {
  const messages =
    error instanceof AggregateError
      ? error.errors.map((item) => (item instanceof Error ? item.message : String(item)))
      : [error instanceof Error ? error.message : String(error)];
  console.error(`FAIL ${messages.join(' | ')}`);
  process.exitCode = 1;
});
