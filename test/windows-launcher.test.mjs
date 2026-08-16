import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSlackRuntimeConfig, parseWindowsUserEnvironment } from '../build/config.js';

test('parses all tracked REG_SZ and REG_EXPAND_SZ values from one registry query', () => {
  const values = parseWindowsUserEnvironment(`
    SLACK_COOKIE_D          REG_SZ           xoxd-example%2Fvalue
    SLACK_WORKSPACE_URL     REG_SZ           https://example.slack.com
    SLACK_USER_CACHE_FILE   REG_EXPAND_SZ    C:/Slack Cache/users.json
  `);

  assert.equal(values.SLACK_COOKIE_D, 'xoxd-example%2Fvalue');
  assert.equal(values.SLACK_WORKSPACE_URL, 'https://example.slack.com');
  assert.equal(values.SLACK_USER_CACHE_FILE, 'C:/Slack Cache/users.json');
});

test('queries the Windows user environment once and preserves process values', async () => {
  let reads = 0;
  const config = await loadSlackRuntimeConfig({
    env: {
      SLACK_COOKIE_D: `xoxd-${'p'.repeat(50)}`,
      SLACK_LOAD_WINDOWS_USER_ENV: '1',
    },
    platform: 'win32',
    readUserEnvironment: async () => {
      reads += 1;
      return {
        SLACK_COOKIE_D: `xoxd-${'r'.repeat(50)}`,
        SLACK_WORKSPACE_URL: 'https://example.slack.com',
        LOG_LEVEL: 'warn',
        SLACK_RESPONSE_FORMAT: 'json',
      };
    },
  });

  assert.equal(reads, 1);
  assert.equal(config.cookieD, `xoxd-${'p'.repeat(50)}`);
  assert.equal(config.workspaceUrl, 'https://example.slack.com');
  assert.equal(config.logLevel, 'warn');
  assert.equal(config.responseFormat, 'json');
});

test('does not query the registry when all tracked values are already present', async () => {
  let reads = 0;
  const config = await loadSlackRuntimeConfig({
    env: {
      SLACK_COOKIE_D: `xoxd-${'x'.repeat(50)}`,
      SLACK_WORKSPACE_URL: 'https://example.slack.com',
      LOG_LEVEL: 'info',
      SLACK_RESPONSE_FORMAT: 'toon',
      SLACK_USER_CACHE_FILE: 'C:/cache/users.json',
      SLACK_USER_AGENT: 'test-agent',
      SLACK_LOAD_WINDOWS_USER_ENV: '1',
    },
    platform: 'win32',
    readUserEnvironment: async () => {
      reads += 1;
      return {};
    },
  });

  assert.equal(reads, 0);
  assert.equal(config.userAgent, 'test-agent');
});

test('reports missing lazy configuration without exposing any configured value', async () => {
  await assert.rejects(
    loadSlackRuntimeConfig({
      env: {},
      platform: 'win32',
      useWindowsUserEnvironment: false,
    }),
    /SLACK_COOKIE_D, SLACK_WORKSPACE_URL/,
  );
});
