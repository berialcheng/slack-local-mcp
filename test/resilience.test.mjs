import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SlackClient } from '../build/slack-client.js';
import { fetchChannelMessagesTool } from '../build/tools/fetch-tools.js';
import {
  handleReplyToThread,
  handleSendDirectMessage,
  replyToThreadTool,
  sendDirectMessageTool,
} from '../build/tools/message-tools.js';
import { handleSearchMessages } from '../build/tools/search-tools.js';
import { handleSearchUsers } from '../build/tools/user-tools.js';
import {
  AuthenticationError,
  CancelledError,
  SlackError,
  ValidationError,
} from '../build/types.js';
import { handleSlackError } from '../build/utils/errors.js';
import {
  cleanupSlackDownloadDirectory,
  COMPLETED_DOWNLOAD_RETENTION_MS,
  PART_DOWNLOAD_RETENTION_MS,
} from '../build/utils/file-download.js';

const cookieD = `xoxd-${'x'.repeat(50)}`;

function createClient(options = {}) {
  return new SlackClient({
    cookieD,
    workspaceUrl: 'https://example.slack.com',
    logLevel: 'error',
    ...options,
  });
}

test('rejects non-Slack workspace origins before attaching the cookie', async () => {
  assert.throws(() => createClient({ workspaceUrl: 'https://not-slack.example' }), ValidationError);
  assert.throws(() => createClient({ workspaceUrl: 'http://example.slack.com' }), ValidationError);
  assert.throws(
    () => createClient({ workspaceUrl: 'https://user@example.slack.com' }),
    ValidationError,
  );

  const client = createClient();
  const requests = [];
  client.workspaceClient.get = async (url, config) => {
    requests.push({ url, cookie: config.headers.Cookie });
    return {
      status: 302,
      headers: { location: 'https://not-slack.example/capture' },
      data: '',
    };
  };

  await assert.rejects(client.fetchWorkspaceHtml('https://example.slack.com'), ValidationError);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/example\.slack\.com\//);
  assert.match(requests[0].cookie, /^d=xoxd-/);
});

test('classifies Slack application authentication errors for controlled reauthentication', async () => {
  const client = createClient();
  client.apiToken = 'xoxc-test-token';
  client.client.post = async () => ({ data: { ok: false, error: 'invalid_auth' } });

  await assert.rejects(
    client.sendMessage({ channel: 'C0000000000', text: 'test' }),
    AuthenticationError,
  );
});

test('classifies token_expired for lazy-client reauthentication', () => {
  assert.ok(handleSlackError(new Error('token_expired')) instanceof AuthenticationError);
});

test('preserves an Axios failure when the response body is null', () => {
  const mapped = handleSlackError({
    response: { status: 500, data: null },
    message: 'upstream server failed',
  });

  assert.ok(mapped instanceof SlackError);
  assert.match(mapped.message, /upstream server failed/);
});

test('serializes authenticated forms without empty optional fields', async () => {
  const client = createClient();
  client.apiToken = 'xoxc-test-token';
  const requests = [];
  client.client.post = async (url, body, config) => {
    requests.push({
      url,
      body: Object.fromEntries(body),
      cookie: config.headers.Cookie,
    });

    if (url === '/chat.postMessage') {
      return { data: { ok: true, channel: 'C0000000000', ts: '1.000001' } };
    }
    if (url === '/chat.scheduleMessage') {
      return {
        data: {
          ok: true,
          channel: 'C0000000000',
          scheduled_message_id: 'Q1',
          post_at: 2_000_000_000,
        },
      };
    }
    return { data: { ok: true } };
  };

  await client.sendMessage({
    channel: 'C0000000000',
    text: 'hello',
    thread_ts: '',
    unfurl_links: false,
  });
  await client.sendMessage({
    channel: 'C0000000000',
    text: 'broadcast',
    thread_ts: '1.000001',
    reply_broadcast: true,
  });
  await client.scheduleMessage({
    channel: 'C0000000000',
    text: 'later',
    post_at: 2_000_000_000,
    thread_ts: '',
  });
  await client.deleteScheduledMessage({
    channel: 'C0000000000',
    scheduled_message_id: 'Q1',
  });

  assert.deepEqual(requests, [
    {
      url: '/chat.postMessage',
      body: {
        token: 'xoxc-test-token',
        channel: 'C0000000000',
        text: 'hello',
        unfurl_links: 'false',
      },
      cookie: `d=${cookieD}`,
    },
    {
      url: '/chat.postMessage',
      body: {
        token: 'xoxc-test-token',
        channel: 'C0000000000',
        text: 'broadcast',
        thread_ts: '1.000001',
        unfurl_links: 'true',
        reply_broadcast: 'true',
      },
      cookie: `d=${cookieD}`,
    },
    {
      url: '/chat.scheduleMessage',
      body: {
        token: 'xoxc-test-token',
        channel: 'C0000000000',
        text: 'later',
        post_at: '2000000000',
      },
      cookie: `d=${cookieD}`,
    },
    {
      url: '/chat.deleteScheduledMessage',
      body: {
        token: 'xoxc-test-token',
        channel: 'C0000000000',
        scheduled_message_id: 'Q1',
      },
      cookie: `d=${cookieD}`,
    },
  ]);
});

test('exposes the authenticated user only after auth.test has established it', () => {
  const client = createClient();

  assert.throws(() => client.getAuthenticatedUserId(), AuthenticationError);
  client.userId = 'U0000000000';
  assert.equal(client.getAuthenticatedUserId(), 'U0000000000');
});

test('passes thread broadcast through the tool handler', async () => {
  let sent;
  const result = await handleReplyToThread(
    {
      channel: 'C0000000000',
      thread_ts: '1.000001',
      text: 'reply',
      broadcast: true,
    },
    {
      sendMessage: async (params) => {
        sent = params;
        return { ok: true, channel: params.channel, ts: '1.000002' };
      },
    },
  );

  assert.deepEqual(sent, {
    channel: 'C0000000000',
    text: 'reply',
    thread_ts: '1.000001',
    reply_broadcast: true,
  });
  assert.equal(result.message, 'Reply sent to thread and broadcast to channel');
});

test('rejects empty recipients, empty thread timestamps, and channel names for history', () => {
  assert.equal(
    sendDirectMessageTool.inputSchema.safeParse({ user: '@', text: 'hello' }).success,
    false,
  );
  assert.equal(
    replyToThreadTool.inputSchema.safeParse({
      channel: 'C12345678',
      thread_ts: '',
      text: 'reply',
    }).success,
    false,
  );
  assert.equal(
    fetchChannelMessagesTool.inputSchema.safeParse({ channel: '#general' }).success,
    false,
  );
  for (const channel of ['C12345678', 'G12345678', 'D12345678']) {
    assert.equal(fetchChannelMessagesTool.inputSchema.safeParse({ channel }).success, true);
  }
});

test('returns human-readable recipient candidates without sending to a guessed user', async () => {
  let opened = false;
  let observedOptions;
  const result = await handleSendDirectMessage(
    { user: 'Cheng Zhong', text: 'hello' },
    {
      searchUsersIncremental: async (_scoreFn, limit, options) => {
        assert.equal(limit, 5);
        observedOptions = options;
        return {
          results: [
            {
              id: 'U05257WCETV',
              name: 'cheng.zhong',
              display_name: 'Cheng Zhong',
              real_name: 'Cheng Zhong',
              score: 100,
            },
          ],
          source: 'api',
          exhaustive: false,
          scannedUsers: 100,
          nextCursor: 'cursor-2',
        };
      },
      openDirectMessage: async () => {
        opened = true;
      },
    },
  );

  assert.equal(opened, false);
  assert.equal(result.status, 'recipient_confirmation_required');
  assert.equal(result.candidates[0].username, 'cheng.zhong');
  assert.equal(result.next_cursor, 'cursor-2');
  assert.deepEqual(observedOptions, { earlyStopThreshold: 100, maxPages: 3 });
});

test('distinguishes bounded and exhaustive recipient misses without opening a DM', async () => {
  const searchResults = [
    {
      results: [],
      source: 'api',
      exhaustive: false,
      scannedUsers: 300,
      nextCursor: 'cursor-4',
    },
    {
      results: [],
      source: 'api',
      exhaustive: true,
      scannedUsers: 42,
    },
  ];
  let opened = 0;
  let sent = 0;
  const client = {
    searchUsersIncremental: async () => searchResults.shift(),
    openDirectMessage: async () => {
      opened += 1;
      return 'D000000001';
    },
    sendMessage: async () => {
      sent += 1;
      return { ok: true };
    },
  };

  const incomplete = await handleSendDirectMessage({ user: 'Missing User', text: 'one' }, client);
  assert.equal(incomplete.status, 'recipient_search_incomplete');
  assert.equal(incomplete.search_complete, false);
  assert.equal(incomplete.next_cursor, 'cursor-4');

  const missing = await handleSendDirectMessage({ user: 'Missing User', text: 'two' }, client);
  assert.equal(missing.status, 'recipient_not_found');
  assert.equal(missing.search_complete, true);
  assert.equal(missing.next_cursor, undefined);
  assert.equal(opened, 0);
  assert.equal(sent, 0);
});

test('sends an exact @username or legacy-length user ID without a full user scan', async () => {
  const openedUsers = [];
  const sentChannels = [];
  const client = {
    searchUsersIncremental: async () => ({
      results: [
        {
          id: 'U05257WCETV',
          name: 'cheng.zhong',
          display_name: 'Cheng Zhong',
          real_name: 'Cheng Zhong',
          score: 100,
        },
      ],
      source: 'api',
      exhaustive: false,
      scannedUsers: 100,
      nextCursor: 'cursor-2',
    }),
    openDirectMessage: async (user) => {
      openedUsers.push(user);
      return `D${openedUsers.length}`;
    },
    sendMessage: async ({ channel }) => {
      sentChannels.push(channel);
      return { ok: true, channel, ts: '1234567890.000001' };
    },
  };

  assert.equal(
    (await handleSendDirectMessage({ user: '@cheng.zhong', text: 'one' }, client)).success,
    true,
  );
  client.searchUsersIncremental = async () => {
    throw new Error('legacy Slack IDs must not enter name search');
  };
  assert.equal(
    (await handleSendDirectMessage({ user: 'U12345678', text: 'two' }, client)).success,
    true,
  );
  assert.deepEqual(openedUsers, ['U05257WCETV', 'U12345678']);
  assert.deepEqual(sentChannels, ['D1', 'D2']);
});

test('stops an exact username lookup on the later page where it is found', async () => {
  const client = createClient();
  client.apiToken = 'xoxc-test-token';
  client.workspaceId = 'T1';
  const cursors = [];
  client.client.get = async (_url, config) => {
    cursors.push(config.params.cursor);
    const found = cursors.length === 2;
    return {
      data: {
        ok: true,
        members: [
          {
            id: found ? 'U05257WCETV' : 'U0000000001',
            name: found ? 'cheng.zhong' : 'someone.else',
            real_name: found ? 'Cheng Zhong' : 'Someone Else',
            profile: { display_name: found ? 'Cheng Zhong' : 'Someone Else' },
          },
        ],
        response_metadata: { next_cursor: found ? 'cursor-3' : 'cursor-2' },
      },
    };
  };
  client.sleep = async () => {};

  const result = await client.searchUsersIncremental(
    (user) => (user.name === 'cheng.zhong' ? 100 : 0),
    1,
    { earlyStopThreshold: 100, skipCache: true, maxPages: 3 },
  );

  assert.deepEqual(cursors, [undefined, 'cursor-2']);
  assert.equal(result.results[0].id, 'U05257WCETV');
  assert.equal(result.exhaustive, false);
  assert.equal(result.nextCursor, 'cursor-3');
});

test('passes an opaque user-search continuation cursor through the tool handler', async () => {
  let observedOptions;
  const result = await handleSearchUsers(
    { query: 'Cheng', limit: 2, cursor: '  cursor-4  ' },
    {
      searchUsersIncremental: async (_scoreFn, limit, options) => {
        assert.equal(limit, 2);
        observedOptions = options;
        return {
          results: [],
          source: 'api',
          exhaustive: false,
          scannedUsers: 300,
          nextCursor: 'cursor-7',
        };
      },
    },
  );

  assert.deepEqual(observedOptions, {
    earlyStopThreshold: 80,
    skipCache: true,
    forceFullScan: false,
    maxPages: 3,
    cursor: 'cursor-4',
  });
  assert.equal(result.next_cursor, 'cursor-7');
  assert.equal(result.exhaustive, false);
});

test('adds authentication to GET requests and omits undefined fields', async () => {
  const client = createClient();
  client.apiToken = 'xoxc-test-token';
  let request;
  client.client.get = async (url, config) => {
    request = { url, params: config.params, cookie: config.headers.Cookie };
    return { data: { ok: true, messages: [], has_more: false } };
  };

  assert.deepEqual(await client.fetchMessages({ channel: 'C0000000000', limit: 25 }), []);
  assert.deepEqual(request, {
    url: '/conversations.history',
    params: {
      token: 'xoxc-test-token',
      channel: 'C0000000000',
      limit: 25,
    },
    cookie: `d=${cookieD}`,
  });
});

test('rejects authenticated form calls locally when no token is loaded', async () => {
  const client = createClient();
  let called = false;
  client.client.post = async () => {
    called = true;
    return { data: { ok: true } };
  };

  await assert.rejects(
    client.sendMessage({ channel: 'C0000000000', text: 'test' }),
    AuthenticationError,
  );
  assert.equal(called, false);
});

test('propagates cancellation into an in-flight Slack API request', async () => {
  const client = createClient();
  client.apiToken = 'xoxc-test-token';
  let observedSignal;
  client.client.defaults.adapter = async (config) => {
    observedSignal = config.signal;
    return new Promise((_resolve, reject) => {
      config.signal.addEventListener('abort', () => reject(config.signal.reason), { once: true });
    });
  };

  const controller = new AbortController();
  const request = client.withRequestSignal(controller.signal, () =>
    client.fetchMessages({ channel: 'C0000000000', limit: 1 }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(request, CancelledError);
  assert.equal(observedSignal, controller.signal);
});

test('does not hide cancellation or authentication failures during username resolution', async () => {
  const client = createClient();
  client.getUserInfo = async () => {
    throw new CancelledError();
  };
  await assert.rejects(client.resolveUsername('U12345678'), CancelledError);

  client.resolveUsername = async () => {
    throw new AuthenticationError('expired');
  };
  await assert.rejects(client.populateUserCache([{ user: 'U12345678' }]), AuthenticationError);
});

test('reuses bounded user-cache population and supports legacy search paging', async () => {
  let populated;
  const result = await handleSearchMessages(
    { query: 'project', page: 2 },
    {
      searchMessages: async () => ({
        ok: true,
        query: 'project',
        messages: {
          total: 42,
          paging: { count: 20, total: 42, page: 2, pages: 3 },
          matches: [],
        },
      }),
      populateUserCache: async (messages) => {
        populated = messages;
      },
      getUserCache: () => new Map(),
    },
  );

  assert.deepEqual(populated, []);
  assert.deepEqual(result, {
    messages: [],
    message_count: 0,
    total_count: 42,
    page: 2,
    page_count: 3,
  });
});

test('uses a bounded user lookup fan-out and rejects stale cache entries', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-local-mcp-cache-test-'));
  const cacheFile = path.join(directory, 'users.json');
  const client = createClient({ userCacheFile: cacheFile });
  client.workspaceId = 'T1';
  client.userListCache = {
    users: [{ id: 'U1', name: 'old', display_name: 'Old', real_name: 'Old User' }],
    timestamp: 0,
    workspace_id: 'T1',
  };

  try {
    assert.equal(client.getOrLoadUserListCache(), null);

    let active = 0;
    let maxActive = 0;
    client.resolveUsername = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return 'user';
    };
    await client.populateUserCache(
      Array.from({ length: 200 }, (_, index) => ({
        user: `U${String(index).padStart(10, '0')}`,
      })),
    );
    assert.equal(maxActive, 8);

    const freshCache = {
      users: [{ id: 'U2', name: 'fresh', display_name: 'Fresh', real_name: 'Fresh User' }],
      timestamp: Date.now(),
      workspace_id: 'T1',
    };
    client.saveUserListCache(freshCache);
    assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, 'utf8')), freshCache);
    assert.deepEqual(await fs.readdir(directory), ['users.json']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('places the default user cache under OS temp and isolates workspaces', () => {
  const first = createClient();
  const second = createClient({ workspaceUrl: 'https://another.slack.com' });
  const expectedDirectory = path.join(os.tmpdir(), 'slack-local-mcp');

  assert.equal(path.dirname(first.userCacheFile), expectedDirectory);
  assert.equal(path.dirname(second.userCacheFile), expectedDirectory);
  assert.notEqual(first.userCacheFile, second.userCacheFile);
});

test('rejects future-dated user caches and serves valid cache hits without Slack calls', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-local-mcp-cache-validity-'));
  const cacheFile = path.join(directory, 'users.json');
  const client = createClient({ userCacheFile: cacheFile });
  client.workspaceId = 'T1';

  try {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        users: [{ id: 'U0000000001', name: 'future', display_name: 'Future', real_name: 'Future' }],
        timestamp: Date.now() + 60_000,
        workspace_id: 'T1',
      }),
    );
    assert.equal(client.getOrLoadUserListCache(), null);

    client.userListCache = {
      users: [
        {
          id: 'U05257WCETV',
          name: 'cheng.zhong',
          display_name: 'Cheng Zhong',
          real_name: 'Cheng Zhong',
        },
      ],
      timestamp: Date.now(),
      workspace_id: 'T1',
    };
    client.client.get = async () => {
      throw new Error('a valid cache hit must not call Slack');
    };

    const result = await client.searchUsersIncremental(
      (user) => (user.name === 'cheng.zhong' ? 100 : 0),
      5,
    );
    assert.equal(result.source, 'cache');
    assert.equal(result.exhaustive, true);
    assert.equal(result.scannedUsers, 0);
    assert.equal(result.results[0].id, 'U05257WCETV');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('forces full pagination when explicitly refreshing the user cache', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-local-mcp-refresh-test-'));
  const client = createClient({ userCacheFile: path.join(directory, 'users.json') });
  client.apiToken = 'xoxc-test-token';
  client.workspaceId = 'T1';
  let pages = 0;
  client.client.get = async () => {
    pages += 1;
    return {
      data: {
        ok: true,
        members: [
          {
            id: `U${pages}`,
            name: `user${pages}`,
            real_name: `User ${pages}`,
            profile: { display_name: `User ${pages}` },
          },
        ],
        response_metadata: { next_cursor: pages === 1 ? 'next' : '' },
      },
    };
  };
  client.sleep = async () => {};

  try {
    const result = await client.searchUsersIncremental(() => 100, 1, {
      earlyStopThreshold: 80,
      skipCache: true,
      forceFullScan: true,
    });
    assert.equal(pages, 2);
    assert.equal(result.exhaustive, true);
    assert.equal(JSON.parse(await fs.readFile(client.userCacheFile, 'utf8')).users.length, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('bounds ordinary user searches and returns a continuation cursor', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-local-mcp-bounded-search-'));
  const client = createClient({ userCacheFile: path.join(directory, 'users.json') });
  client.apiToken = 'xoxc-test-token';
  client.workspaceId = 'T1';
  const cursors = [];
  client.client.get = async (_url, config) => {
    cursors.push(config.params.cursor);
    const page = cursors.length;
    return {
      data: {
        ok: true,
        members: [
          {
            id: `U000000000${page}`,
            name: `user${page}`,
            real_name: `User ${page}`,
            profile: { display_name: `User ${page}` },
          },
        ],
        response_metadata: { next_cursor: `cursor-${page + 1}` },
      },
    };
  };
  client.sleep = async () => {};

  try {
    const result = await client.searchUsersIncremental(() => 0, 5, {
      skipCache: true,
      maxPages: 2,
    });
    assert.deepEqual(cursors, [undefined, 'cursor-2']);
    assert.equal(result.exhaustive, false);
    assert.equal(result.nextCursor, 'cursor-3');
    assert.equal(result.scannedUsers, 2);
    await assert.rejects(fs.access(client.userCacheFile));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('does not replace the complete user cache with a continuation-page fragment', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-local-mcp-continuation-'));
  const cacheFile = path.join(directory, 'users.json');
  const client = createClient({ userCacheFile: cacheFile });
  client.apiToken = 'xoxc-test-token';
  client.workspaceId = 'T1';
  let observedCursor;
  client.client.get = async (_url, config) => {
    observedCursor = config.params.cursor;
    return {
      data: {
        ok: true,
        members: [
          {
            id: 'U05257WCETV',
            name: 'cheng.zhong',
            real_name: 'Cheng Zhong',
            profile: { display_name: 'Cheng Zhong' },
          },
        ],
        response_metadata: { next_cursor: '' },
      },
    };
  };

  try {
    const result = await client.searchUsersIncremental(() => 100, 5, {
      skipCache: true,
      cursor: 'cursor-4',
      maxPages: 3,
    });
    assert.equal(observedCursor, 'cursor-4');
    assert.equal(result.exhaustive, true);
    assert.equal(result.results[0].id, 'U05257WCETV');
    assert.equal(client.userListCache, null);
    await assert.rejects(fs.access(cacheFile));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('checks Slack after a cached miss so newly joined users can be found', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-local-mcp-new-user-'));
  const client = createClient({ userCacheFile: path.join(directory, 'users.json') });
  client.apiToken = 'xoxc-test-token';
  client.workspaceId = 'T1';
  client.userListCache = {
    users: [{ id: 'U0000000001', name: 'old', display_name: 'Old', real_name: 'Old User' }],
    timestamp: Date.now(),
    workspace_id: 'T1',
  };
  let apiCalls = 0;
  client.client.get = async () => {
    apiCalls += 1;
    return {
      data: {
        ok: true,
        members: [
          {
            id: 'U05257WCETV',
            name: 'new.user',
            real_name: 'New User',
            profile: { display_name: 'New User' },
          },
        ],
        response_metadata: { next_cursor: '' },
      },
    };
  };

  try {
    const result = await client.searchUsersIncremental(
      (user) => (user.name === 'new.user' ? 100 : 0),
      5,
      { maxPages: 1 },
    );
    assert.equal(apiCalls, 1);
    assert.equal(result.source, 'api');
    assert.equal(result.results[0].id, 'U05257WCETV');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('cleans only expired MCP-owned temp downloads', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-local-mcp-download-test-'));
  const now = Date.now();
  const oldCompleted = path.join(directory, 'F0000000000-1-abcd1234-old.png');
  const oldPart = path.join(directory, 'F0000000000-1-abcd1234-old.png.uuid.part');
  const freshCompleted = path.join(directory, 'F0000000000-2-abcd1234-fresh.png');
  const unrelated = path.join(directory, 'unrelated.txt');

  try {
    await Promise.all(
      [oldCompleted, oldPart, freshCompleted, unrelated].map((file) => fs.writeFile(file, 'x')),
    );
    await fs.utimes(
      oldCompleted,
      new Date(now - COMPLETED_DOWNLOAD_RETENTION_MS - 1_000),
      new Date(now - COMPLETED_DOWNLOAD_RETENTION_MS - 1_000),
    );
    await fs.utimes(
      oldPart,
      new Date(now - PART_DOWNLOAD_RETENTION_MS - 1_000),
      new Date(now - PART_DOWNLOAD_RETENTION_MS - 1_000),
    );

    assert.equal(await cleanupSlackDownloadDirectory(directory, now), 2);
    assert.deepEqual((await fs.readdir(directory)).sort(), [
      'F0000000000-2-abcd1234-fresh.png',
      'unrelated.txt',
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
