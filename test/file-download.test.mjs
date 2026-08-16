import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import axios from 'axios';

import {
  assertAllowedSlackDownloadUrl,
  classifySlackFile,
  formatSlackFile,
  getDownloadSkipReason,
  MAX_FILE_DOWNLOAD_BYTES,
  normalizeSlackFileId,
  sanitizeDownloadFilename,
} from '../build/utils/file-download.js';
import { SlackClient } from '../build/slack-client.js';

const hostedUrl = 'https://files.slack.com/files-pri/T123-F123/download/image.png';

test('accepts Slack file IDs and extracts IDs from Slack permalinks', () => {
  assert.equal(normalizeSlackFileId('F0BP8MB69U2'), 'F0BP8MB69U2');
  assert.equal(
    normalizeSlackFileId('https://example.slack.com/files/U05257WCETV/F0BP8MB69U2/image.png'),
    'F0BP8MB69U2',
  );
});

test('rejects non-Slack, non-HTTPS, and malformed file references', () => {
  assert.throws(() => normalizeSlackFileId('not-a-file'), /Slack file ID or Slack file permalink/);
  assert.throws(
    () => normalizeSlackFileId('https://example.com/files/U123/F0BP8MB69U2/image.png'),
    /Only HTTPS Slack file permalinks/,
  );
  assert.throws(
    () => assertAllowedSlackDownloadUrl('http://files.slack.com/file.png'),
    /must use HTTPS/,
  );
  assert.throws(
    () => assertAllowedSlackDownloadUrl('https://files.slack.com:8443/file.png'),
    /unsupported credentials or port/,
  );
});

test('classifies Slack MIME types', () => {
  assert.equal(classifySlackFile('image/png'), 'image');
  assert.equal(classifySlackFile('video/mp4'), 'video');
  assert.equal(classifySlackFile('application/pdf'), 'other');
  assert.equal(classifySlackFile(undefined), 'other');
});

test('allows images below 20 MiB and enforces the exclusive hard limit', () => {
  const image = {
    id: 'F0BP8MB69U2',
    name: 'image.png',
    mimetype: 'image/png',
    size: MAX_FILE_DOWNLOAD_BYTES - 1,
    mode: 'hosted',
    url_private_download: hostedUrl,
  };
  assert.equal(getDownloadSkipReason(image), undefined);
  assert.equal(formatSlackFile(image).download_eligible_by_default, true);

  const atLimit = { ...image, size: MAX_FILE_DOWNLOAD_BYTES };
  assert.match(getDownloadSkipReason(atLimit), /strictly below/);
  assert.equal(formatSlackFile(atLimit).download_eligible_by_default, false);

  const invalidSize = { ...image, size: -1 };
  assert.match(getDownloadSkipReason(invalidSize), /valid file size/);
  assert.equal(formatSlackFile(invalidSize).size, null);
  assert.equal(formatSlackFile(invalidSize).download_eligible_by_default, false);
});

test('requires explicit opt-in for videos and other file types', () => {
  const video = {
    id: 'FVIDEO1234',
    name: 'clip.mp4',
    mimetype: 'video/mp4',
    size: 1024,
    mode: 'hosted',
    url_private_download: hostedUrl,
  };
  const document = {
    ...video,
    id: 'FDOC123456',
    name: 'notes.pdf',
    mimetype: 'application/pdf',
  };

  assert.match(getDownloadSkipReason(video), /Video downloads are disabled/);
  assert.equal(getDownloadSkipReason(video, { allowVideo: true }), undefined);
  assert.match(getDownloadSkipReason(document), /Non-image downloads are disabled/);
  assert.equal(getDownloadSkipReason(document, { allowOther: true }), undefined);
});

test('reapplies video policy to the final response content type before writing', async () => {
  const client = new SlackClient({
    cookieD: `xoxd-${'x'.repeat(50)}`,
    workspaceUrl: 'https://example.slack.com',
    logLevel: 'error',
  });
  client.openSlackDownloadStream = async () => ({
    stream: (async function* () {
      yield Buffer.from('data');
    })(),
    contentType: 'video/mp4',
    contentLength: 4,
    redirectCount: 0,
    finalUrl: new URL(hostedUrl),
  });

  await assert.rejects(
    client.downloadFile(
      {
        id: 'FOTHER1234',
        name: 'unknown.bin',
        mimetype: 'application/octet-stream',
        size: 4,
        mode: 'hosted',
        url_private_download: hostedUrl,
      },
      { allowOther: true, allowVideo: false },
    ),
    /Video downloads are disabled/,
  );
});

test('writes an allowed image and removes partial data after a streamed size mismatch', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-local-mcp-stream-test-'));
  const client = new SlackClient({
    cookieD: `xoxd-${'x'.repeat(50)}`,
    workspaceUrl: 'https://example.slack.com',
    logLevel: 'error',
  });
  const file = {
    id: 'FIMAGE1234',
    name: 'image.png',
    mimetype: 'image/png',
    size: 4,
    mode: 'hosted',
    url_private_download: hostedUrl,
  };
  const finalPath = path.join(directory, 'image.png');

  try {
    client.openSlackDownloadStream = async () => ({
      stream: (async function* () {
        yield Buffer.from('data');
      })(),
      contentType: 'image/png',
      contentLength: 4,
      redirectCount: 1,
      finalUrl: new URL(hostedUrl),
    });

    const downloaded = await client.downloadFileOnce(file, hostedUrl, finalPath, {});
    assert.equal(downloaded.bytes, 4);
    assert.equal(downloaded.redirect_count, 1);
    assert.equal(downloaded.sha256.length, 64);
    assert.equal(await fs.readFile(finalPath, 'utf8'), 'data');

    client.openSlackDownloadStream = async () => ({
      stream: (async function* () {
        yield Buffer.from('bad');
      })(),
      contentType: 'image/png',
      contentLength: undefined,
      redirectCount: 0,
      finalUrl: new URL(hostedUrl),
    });

    await assert.rejects(
      client.downloadFileOnce(file, hostedUrl, path.join(directory, 'mismatch.png'), {}),
      /Downloaded 3 bytes but files.info reported 4 bytes/,
    );
    assert.deepEqual(await fs.readdir(directory), ['image.png']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retries transient file responses and stream resets without leaving partial files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-local-mcp-retry-test-'));
  const client = new SlackClient({
    cookieD: `xoxd-${'x'.repeat(50)}`,
    workspaceUrl: 'https://example.slack.com',
    logLevel: 'error',
  });
  client.apiToken = 'xoxc-test-token';
  client.retryDelay = 1;
  const originalGet = axios.get;
  const file = {
    id: 'FRETRY1234',
    name: 'image.png',
    mimetype: 'image/png',
    size: 4,
    mode: 'hosted',
    url_private_download: hostedUrl,
  };

  async function runScenario(name, firstResponse) {
    let attempts = 0;
    axios.get = async () => {
      attempts += 1;
      if (attempts === 1) return firstResponse();
      return {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '4' },
        data: (async function* () {
          yield Buffer.from('data');
        })(),
      };
    };

    const finalPath = path.join(directory, `${name}.png`);
    const result = await client.withTransientRetry(name, () =>
      client.downloadFileOnce(file, hostedUrl, finalPath, {}),
    );
    assert.equal(attempts, 2);
    assert.equal(result.bytes, 4);
    assert.equal(await fs.readFile(finalPath, 'utf8'), 'data');
  }

  try {
    await runScenario('http-503', () => ({
      status: 503,
      headers: {},
      data: { destroy() {} },
    }));
    await runScenario('stream-reset', () => ({
      status: 200,
      headers: { 'content-type': 'image/png' },
      data: (async function* () {
        yield Buffer.from('da');
        const error = new Error('connection reset');
        error.code = 'ECONNRESET';
        throw error;
      })(),
    }));

    assert.deepEqual((await fs.readdir(directory)).sort(), ['http-503.png', 'stream-reset.png']);
  } finally {
    axios.get = originalGet;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('never downloads external files and sanitizes local filenames', () => {
  const external = {
    id: 'FEXTERNAL1',
    name: 'remote.png',
    mimetype: 'image/png',
    size: 1024,
    mode: 'external',
    is_external: true,
    url_private: 'https://example.com/remote.png',
  };
  assert.match(getDownloadSkipReason(external), /metadata-only/);
  assert.equal(formatSlackFile(external).download_available, false);
  assert.equal(sanitizeDownloadFilename('../bad:name?.png', 'fallback'), 'bad_name_.png');
  assert.equal(sanitizeDownloadFilename('.', '../fallback:name'), 'fallback_name');
});

test('retries transient network failures without duplicating interceptor rate-limit retries', async () => {
  const client = new SlackClient({
    cookieD: `xoxd-${'x'.repeat(50)}`,
    workspaceUrl: 'https://example.slack.com',
    logLevel: 'error',
  });
  client.retryDelay = 1;

  let transientAttempts = 0;
  const result = await client.withTransientRetry('test retry', async () => {
    transientAttempts += 1;
    if (transientAttempts === 1) {
      const error = new Error('connection reset');
      error.code = 'ECONNRESET';
      throw error;
    }
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(transientAttempts, 2);

  let rateLimitAttempts = 0;
  await assert.rejects(
    client.withTransientRetry('test rate limit', async () => {
      rateLimitAttempts += 1;
      const error = new Error('rate limited');
      error.response = { status: 429, headers: { 'retry-after': '0' } };
      throw error;
    }),
    /rate limited/,
  );
  assert.equal(rateLimitAttempts, 1);

  let permanentAttempts = 0;
  await assert.rejects(
    client.withTransientRetry('test permanent error', async () => {
      permanentAttempts += 1;
      throw new Error('invalid_auth');
    }),
    /invalid_auth/,
  );
  assert.equal(permanentAttempts, 1);
});
