import assert from 'node:assert/strict';
import test from 'node:test';

import { decode } from '@toon-format/toon';

import { SlackClient } from '../build/slack-client.js';
import { handleFetchThreadMessages } from '../build/tools/fetch-tools.js';
import { SlackError, ValidationError } from '../build/types.js';
import { formatFetchThreadMessagesResponse } from '../build/utils/tool-formatters.js';

const channel = 'C12345678';
const rootTs = '1700000000.000001';
const user = 'U12345678';
const names = new Map([[user, 'Example User']]);
const parent = {
  type: 'message',
  ts: rootTs,
  thread_ts: rootTs,
  user,
  text: 'Root question',
  reply_count: 5,
  reactions: [{ name: 'eyes', count: 1, users: [user] }],
  files: [
    {
      id: 'F12345678',
      name: 'context.png',
      mimetype: 'image/png',
      filetype: 'png',
      mode: 'hosted',
      size: 42,
      url_private: 'https://files.slack.com/private/must-not-be-returned',
    },
  ],
};
const reply = (number) => ({
  type: 'message',
  ts: `170000000${number}.00000${number}`,
  thread_ts: rootTs,
  user,
  text: `Reply ${number}`,
});
const input = (extra = {}) => ({ channel, thread_ts: rootTs, limit: 2, ...extra });

function stubClient(pages) {
  const client = new SlackClient({
    cookieD: `xoxd-${'x'.repeat(50)}`,
    workspaceUrl: 'https://example.slack.com',
    logLevel: 'error',
  });
  client.apiToken = 'xoxc-offline-test';
  const requests = [];
  const enrichments = [];
  client.client.get = async (endpoint, config) => {
    assert.equal(endpoint, '/conversations.replies');
    const page = pages[requests.length];
    assert.ok(page, 'must not fetch extra pages to fill a reply limit');
    requests.push(config.params);
    return { data: { ok: true, ...page } };
  };
  client.populateUserCache = async (messages) => enrichments.push(messages);
  client.getUserCache = () => names;
  return { client, requests, enrichments };
}

test('returns parent context on every page and preserves all five replies across raw 3/3/2 pages', async () => {
  const { client, requests, enrichments } = stubClient([
    {
      messages: [parent, reply(4), reply(5)],
      has_more: true,
      response_metadata: { next_cursor: 'page-2' },
    },
    // Parent position is not used as its identity.
    {
      messages: [reply(2), parent, reply(3)],
      has_more: true,
      response_metadata: { next_cursor: 'page-3' },
    },
    { messages: [parent, reply(1)], has_more: false, response_metadata: { next_cursor: '' } },
  ]);
  const pages = [];
  let cursor;
  do {
    const page = await handleFetchThreadMessages(input({ cursor }), client);
    assert.equal(page.thread_ts, rootTs);
    assert.equal(page.parent_message.ts, rootTs);
    assert.equal(page.parent_message.user, 'Example User');
    assert.equal(page.parent_message.files[0].id, 'F12345678');
    assert.equal(page.message_count, page.messages.length);
    assert.ok(page.messages.length <= 2);
    assert.ok(page.messages.every((message) => message.ts !== rootTs));
    pages.push(page);
    cursor = page.next_cursor;
  } while (cursor);

  assert.deepEqual(
    pages.map((page) => page.message_count),
    [2, 2, 1],
  );
  assert.deepEqual(
    pages.flatMap((page) => page.messages.map((message) => message.ts)),
    [reply(4).ts, reply(5).ts, reply(2).ts, reply(3).ts, reply(1).ts],
  );
  assert.equal(
    new Set(pages.flatMap((page) => page.messages.map((message) => message.ts))).size,
    5,
  );
  assert.deepEqual(
    requests.map((request) => request.cursor),
    [undefined, 'page-2', 'page-3'],
  );
  assert.ok(
    requests.every(
      (request) => request.limit === 2 && request.ts === rootTs && request.channel === channel,
    ),
  );
  assert.ok(enrichments.every((messages) => messages.some((message) => message.ts === rootTs)));
  assert.equal(pages[2].has_more, false);
  assert.equal(pages[2].next_cursor, null);
});

test('limit=1 returns one reply plus separate parent without reducing the upstream limit to zero', async () => {
  const { client, requests } = stubClient([{ messages: [parent, reply(1)], has_more: false }]);
  const result = await handleFetchThreadMessages(input({ limit: 1 }), client);
  assert.equal(requests[0].limit, 1);
  assert.equal(result.parent_message.ts, rootTs);
  assert.deepEqual(
    result.messages.map((message) => message.ts),
    [reply(1).ts],
  );
});

test('a parent-only intermediate page retains its cursor without fetching another page', async () => {
  const { client, requests } = stubClient([
    {
      messages: [parent],
      has_more: true,
      response_metadata: { next_cursor: 'next' },
    },
  ]);
  const result = await handleFetchThreadMessages(input({ limit: 1 }), client);
  assert.equal(result.parent_message.ts, rootTs);
  assert.deepEqual(result.messages, []);
  assert.equal(result.message_count, 0);
  assert.equal(result.has_more, true);
  assert.equal(result.next_cursor, 'next');
  assert.equal(requests.length, 1);
});

test('an unthreaded parent returns structured context and zero replies', async () => {
  const unthreaded = { type: 'message', user, ts: rootTs, text: 'No replies' };
  const { client } = stubClient([{ messages: [unthreaded], has_more: false }]);
  const result = await handleFetchThreadMessages(input(), client);
  assert.equal(result.parent_message.text, 'No replies');
  assert.deepEqual(result.messages, []);
  assert.equal(result.message_count, 0);
  assert.equal(result.has_more, false);
  assert.equal(result.next_cursor, null);
});

test('missing parent context is explicit and the first real reply is preserved', async () => {
  const { client, requests } = stubClient([{ messages: [reply(1), reply(2)], has_more: false }]);
  const result = await handleFetchThreadMessages(input({ cursor: 'resume' }), client);
  assert.equal(result.parent_message, null);
  assert.deepEqual(
    result.messages.map((message) => message.ts),
    [reply(1).ts, reply(2).ts],
  );
  assert.equal(requests.length, 1);
});

test('an empty final page still has the complete structured envelope', async () => {
  const { client } = stubClient([{ messages: [], has_more: false }]);
  assert.deepEqual(await handleFetchThreadMessages(input(), client), {
    thread_ts: rootTs,
    parent_message: null,
    messages: [],
    message_count: 0,
    has_more: false,
    next_cursor: null,
  });
});

test('a cursor permits continuation after an empty page even when the upstream has_more flag is false', async () => {
  const { client } = stubClient([
    {
      messages: [],
      has_more: false,
      response_metadata: { next_cursor: '  next  ' },
    },
  ]);
  const result = await handleFetchThreadMessages(input(), client);
  assert.equal(result.parent_message, null);
  assert.equal(result.message_count, 0);
  assert.equal(result.has_more, true);
  assert.equal(result.next_cursor, 'next');
});

test('rejects reply overflow without returning a cursor that would skip discarded messages', async () => {
  const { client, requests } = stubClient([
    {
      messages: [parent, reply(1), reply(2)],
      has_more: true,
      response_metadata: { next_cursor: 'next' },
    },
  ]);
  await assert.rejects(client.fetchThreadReplies(input({ limit: 1 })), (error) => {
    assert.ok(error instanceof SlackError);
    assert.equal(error.code, 'PAGINATION_ERROR');
    assert.match(error.message, /refusing to truncate/);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('rejects an upstream has_more flag without a usable cursor', async () => {
  const { client } = stubClient([
    {
      messages: [parent, reply(1)],
      has_more: true,
      response_metadata: { next_cursor: ' ' },
    },
  ]);
  await assert.rejects(client.fetchThreadReplies(input()), (error) => {
    assert.equal(error.code, 'PAGINATION_ERROR');
    assert.match(error.message, /without a continuation cursor/);
    return true;
  });
});

test('rejects a repeated cursor instead of allowing a pagination loop', async () => {
  const { client } = stubClient([
    {
      messages: [parent, reply(1)],
      has_more: true,
      response_metadata: { next_cursor: 'same' },
    },
  ]);
  await assert.rejects(client.fetchThreadReplies(input({ cursor: ' same ' })), (error) => {
    assert.equal(error.code, 'PAGINATION_ERROR');
    assert.match(error.message, /did not advance/);
    return true;
  });
});

test('rejects a reply timestamp as the requested root rather than hiding that reply', async () => {
  const { client } = stubClient([{ messages: [parent, reply(1)], has_more: false }]);
  await assert.rejects(client.fetchThreadReplies(input({ thread_ts: reply(1).ts })), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.match(error.message, /parent message timestamp/);
    assert.ok(error.message.includes(rootTs));
    return true;
  });
});

test('rejects invalid direct-client limits before requesting Slack', async () => {
  const { client, requests } = stubClient([]);
  for (const limit of [0, 201, 1.5, NaN, Infinity, -Infinity]) {
    await assert.rejects(client.fetchThreadReplies(input({ limit })), ValidationError);
  }
  assert.equal(requests.length, 0);
});

test('JSON and TOON both retain parent context, attachments, reactions and reply-only counts', async () => {
  const { client } = stubClient([{ messages: [parent, reply(1)], has_more: false }]);
  const result = await handleFetchThreadMessages(input(), client);
  const jsonText = formatFetchThreadMessagesResponse(result, 'json', names);
  const toonText = formatFetchThreadMessagesResponse(result, 'toon', names);
  const json = JSON.parse(jsonText);
  const toon = decode(toonText);
  for (const page of [json, toon]) {
    assert.equal(page.parent_message.ts, rootTs);
    assert.equal(page.parent_message.text, 'Root question');
    assert.deepEqual(
      page.messages.map((message) => message.ts),
      [reply(1).ts],
    );
    assert.equal(page.message_count, 1);
    assert.equal(page.next_cursor, null);
    assert.equal(page.has_more, false);
  }
  assert.equal(json.parent_message.files[0].id, 'F12345678');
  assert.match(
    toon.parent_message.files,
    /F12345678:context.png:image\/png:42:image:default-download/,
  );
  assert.match(toon.parent_message.reactions, /eyes×1\(Example User\)/);
  assert.doesNotMatch(jsonText + toonText, /url_private|must-not-be-returned/);
});

test('TOON explicitly retains unavailable parent context on an empty continuation page', async () => {
  const { client } = stubClient([
    {
      messages: [],
      has_more: true,
      response_metadata: { next_cursor: 'next' },
    },
  ]);
  const result = await handleFetchThreadMessages(input(), client);
  const decoded = decode(formatFetchThreadMessagesResponse(result, 'toon', names));
  assert.equal(decoded.parent_message, null);
  assert.deepEqual(decoded.messages, []);
  assert.equal(decoded.message_count, 0);
  assert.equal(decoded.has_more, true);
  assert.equal(decoded.next_cursor, 'next');
});
