import assert from 'node:assert/strict';
import test from 'node:test';

import { Logger } from '../build/utils/logger.js';

test('redacts Slack credentials and private file URLs embedded in log strings', () => {
  const logger = new Logger('debug');
  const originalConsoleError = console.error;
  const output = [];
  console.error = (...values) => output.push(values.join(' '));

  try {
    logger.debug(
      'Sensitive diagnostic',
      'api_token=xoxc-123_secret%2Dvalue Bearer abc.def https://files.slack.com/files-pri/T123-F123/download/image.png?origin=1',
    );
    logger.error('Request failed', new Error('cookie d=xoxd-654321-secret'));
  } finally {
    console.error = originalConsoleError;
  }

  const logged = output.join('\n');
  assert.doesNotMatch(logged, /xox[cd]-/i);
  assert.doesNotMatch(logged, /abc\.def/);
  assert.doesNotMatch(logged, /files-pri/);
  assert.match(logged, /REDACTED_SLACK_TOKEN/);
  assert.match(logged, /REDACTED_SLACK_FILE_URL/);
});
