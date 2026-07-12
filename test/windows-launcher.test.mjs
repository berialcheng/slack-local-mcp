import assert from 'node:assert/strict';
import test from 'node:test';

import { loadWindowsUserEnvironment, parseRegistryQuery } from '../scripts/start-windows.mjs';

test('parses REG_SZ and REG_EXPAND_SZ values', () => {
  assert.equal(
    parseRegistryQuery(
      '\n    SLACK_COOKIE_D    REG_SZ    xoxd-example%2Fvalue\n',
      'SLACK_COOKIE_D',
    ),
    'xoxd-example%2Fvalue',
  );
  assert.equal(
    parseRegistryQuery(
      '\n    SLACK_USER_CACHE_FILE    REG_EXPAND_SZ    C:/Slack Cache/users.json\n',
      'SLACK_USER_CACHE_FILE',
    ),
    'C:/Slack Cache/users.json',
  );
});

test('keeps process values and only fills missing values from the user environment', () => {
  const env = {
    SLACK_COOKIE_D: 'process-cookie',
  };
  const values = {
    SLACK_COOKIE_D: 'registry-cookie',
    SLACK_WORKSPACE_URL: 'https://example.slack.com',
    LOG_LEVEL: 'warn',
  };

  loadWindowsUserEnvironment({
    env,
    platform: 'win32',
    readUserEnvironment: (name) => values[name],
  });

  assert.equal(env.SLACK_COOKIE_D, 'process-cookie');
  assert.equal(env.SLACK_WORKSPACE_URL, 'https://example.slack.com');
  assert.equal(env.LOG_LEVEL, 'warn');
});

test('reports all missing required variables without exposing values', () => {
  assert.throws(
    () =>
      loadWindowsUserEnvironment({
        env: {},
        platform: 'win32',
        readUserEnvironment: () => undefined,
      }),
    /SLACK_COOKIE_D, SLACK_WORKSPACE_URL/,
  );
});

test('rejects non-Windows use with direct-entrypoint guidance', () => {
  assert.throws(
    () =>
      loadWindowsUserEnvironment({
        env: {},
        platform: 'linux',
        readUserEnvironment: () => undefined,
      }),
    /build\/index\.js directly/,
  );
});
