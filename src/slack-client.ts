/**
 * Slack API Client with cookie-based authentication
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import * as os from 'node:os';
import * as path from 'path';

import axios from 'axios';
import type { AxiosInstance } from 'axios';

import type {
  SlackApiResponse,
  SlackClientConfig,
  SlackAuthTestResponse,
  SlackMessageResponse,
  SlackScheduledMessageResponse,
  SlackConversationsHistoryResponse,
  SlackConversationsRepliesResponse,
  SlackConversationsOpenResponse,
  SlackReactionsAddResponse,
  SlackUsersInfoResponse,
  SlackUsersListResponse,
  SlackMessage,
  SlackThreadPage,
  SlackUser,
  SlackSearchMessagesResponse,
  SlackFile,
  SlackFilesInfoResponse,
  FileDownloadResult,
} from './types.js';
import { AuthenticationError, CancelledError, SlackError, ValidationError } from './types.js';
import { handleSlackError } from './utils/errors.js';
import {
  assertAllowedSlackDownloadUrl,
  classifySlackFile,
  cleanupSlackDownloadDirectory,
  DOWNLOAD_DIRECTORY_CLEANUP_INTERVAL_MS,
  getFileCategorySkipReason,
  MAX_FILE_DOWNLOAD_BYTES,
  normalizeSlackFileId,
  sanitizeDownloadFilename,
} from './utils/file-download.js';
import type { FileDownloadOptions } from './utils/file-download.js';
import { logger } from './utils/logger.js';
import {
  assertAllowedSlackUrl,
  normalizeSlackWorkspaceUrl,
  validateFetchLimit,
  validateSlackCookie,
} from './utils/validation.js';

export type UserRecord = {
  id: string;
  name: string;
  display_name: string;
  real_name: string;
};

type ScoredUserRecord = UserRecord & { score: number };

interface UserCacheData {
  users: UserRecord[];
  timestamp: number;
  workspace_id: string;
}

interface SlackDownloadStream {
  stream: AsyncIterable<Uint8Array> & { destroy?: () => void };
  contentType: string;
  contentLength?: number;
  redirectCount: number;
  finalUrl: URL;
}

interface TransientRetryOptions {
  retryRateLimit?: boolean;
  maxAttempts?: number;
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);

function insertTopScoredUser(
  results: ScoredUserRecord[],
  user: UserRecord,
  score: number,
  limit: number,
): void {
  if (!Number.isFinite(score) || score <= 0 || limit <= 0) return;

  // Binary insertion keeps only the requested top results. Equal scores stay
  // in workspace order, matching stable Array.sort behavior without creating
  // a scored copy of every cached user.
  let low = 0;
  let high = results.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (results[middle].score >= score) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low >= limit) return;

  results.splice(low, 0, { ...user, score });
  if (results.length > limit) results.pop();
}

export interface SearchUsersIncrementalResult {
  results: ScoredUserRecord[];
  source: 'cache' | 'api';
  exhaustive: boolean;
  scannedUsers: number;
  nextCursor?: string;
}

export interface SearchUsersIncrementalOptions {
  earlyStopThreshold?: number;
  skipCache?: boolean;
  forceFullScan?: boolean;
  maxPages?: number;
  cursor?: string;
}

type SlackApiField = string | number | boolean | undefined;

export class SlackClient {
  private client: AxiosInstance;
  private workspaceClient: AxiosInstance;
  private cookieD: string;
  private apiToken?: string;
  private workspaceUrl?: string;
  private workspaceId?: string;
  private userId?: string;
  private userAgent: string;
  private userCache: Map<string, string> = new Map();
  private userListCache: UserCacheData | null = null;
  private userCacheFile: string;
  private retryDelay = 1000; // milliseconds
  private readonly maxTransientAttempts = 3;
  private readonly requestSignal = new AsyncLocalStorage<AbortSignal>();
  private readonly userCacheTtlMs = 60 * 60 * 1000;
  private readonly userLookupConcurrency = 8;
  private readonly maxUserEnrichmentLookups = 32;
  private readonly maxCachedUsernames = 1000;
  private downloadDirectoryCleanup: Promise<void> | undefined;
  private lastDownloadDirectoryCleanupAt = 0;

  constructor(config: SlackClientConfig) {
    // Validate cookie
    validateSlackCookie(config.cookieD);

    this.cookieD = config.cookieD;
    this.workspaceUrl = config.workspaceUrl
      ? normalizeSlackWorkspaceUrl(config.workspaceUrl)
      : undefined;
    this.userAgent = config.userAgent || 'Slack-MCP-Client/1.0';

    // Configure user list cache file path
    const workspaceCacheKey = createHash('sha256')
      .update(this.workspaceUrl || 'unknown-workspace')
      .digest('hex')
      .slice(0, 12);
    this.userCacheFile =
      config.userCacheFile ||
      path.join(os.tmpdir(), 'slack-local-mcp', `users-${workspaceCacheKey}.json`);

    // Create workspace client for initial token fetch
    this.workspaceClient = axios.create({
      timeout: 15000,
      headers: {
        'User-Agent': this.userAgent,
      },
    });

    // Set log level if provided
    if (config.logLevel) {
      logger.setLevel(config.logLevel);
    }

    // Create axios instance with default configuration
    this.client = axios.create({
      baseURL: 'https://slack.com/api',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      },
    });

    // Add request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        config.signal ??= this.requestSignal.getStore();
        logger.debug(`API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        logger.error('Request interceptor error', error);
        return Promise.reject(error);
      },
    );

    // Keep transport interception observational only. Retry policy belongs to
    // the explicit operation wrappers below so POST writes are never replayed.
    this.client.interceptors.response.use((response) => {
      logger.debug(`API Response: ${response.config.url}`, {
        status: response.status,
        ok: response.data?.ok,
      });
      return response;
    });
  }

  /**
   * Sleep utility for delays
   */
  private sleep(ms: number): Promise<void> {
    const signal = this.requestSignal.getStore();
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
        );
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async withRequestSignal<T>(
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!signal) {
      return action();
    }
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    }
    return this.requestSignal.run(signal, action);
  }

  private isTransientNetworkError(
    error: unknown,
    { retryRateLimit = false }: TransientRetryOptions = {},
  ): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as {
      code?: string;
      response?: { status?: number };
    };
    const status = candidate.response?.status || 0;
    return (
      (candidate.code ? TRANSIENT_NETWORK_CODES.has(candidate.code) : false) ||
      TRANSIENT_HTTP_STATUSES.has(status) ||
      (retryRateLimit && status === 429)
    );
  }

  private getRetryDelay(error: unknown, attempt: number): number {
    if (error && typeof error === 'object' && 'response' in error) {
      const response = (
        error as {
          response?: { headers?: Record<string, string | string[] | undefined> };
        }
      ).response;
      const retryAfter = response?.headers?.['retry-after'];
      const value = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
      const seconds = value ? Number.parseInt(value, 10) : Number.NaN;
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 30_000);
      }
    }
    return this.retryDelay * attempt;
  }

  private async withTransientRetry<T>(
    operation: string,
    action: () => Promise<T>,
    options: TransientRetryOptions = {},
  ): Promise<T> {
    const maxAttempts = options.maxAttempts ?? this.maxTransientAttempts;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        lastError = error;
        if (!this.isTransientNetworkError(error, options) || attempt === maxAttempts) {
          throw error;
        }
        const delay = this.getRetryDelay(error, attempt);
        logger.warn(`${operation} hit a transient network error; retrying`, {
          attempt,
          max_attempts: maxAttempts,
          delay_ms: delay,
          code: (error as { code?: string }).code,
        });
        await this.sleep(delay);
      }
    }
    throw lastError;
  }

  private requireApiToken(): string {
    if (!this.apiToken) {
      throw new AuthenticationError('Slack client is not authenticated');
    }
    return this.apiToken;
  }

  private requireWorkspaceId(): string {
    if (!this.workspaceId) {
      throw new AuthenticationError('Slack workspace is not authenticated');
    }
    return this.workspaceId;
  }

  private createAuthenticatedForm(fields: Record<string, SlackApiField>): URLSearchParams {
    const formData = new URLSearchParams();
    for (const [name, value] of Object.entries(this.createAuthenticatedParams(fields))) {
      formData.append(name, String(value));
    }
    return formData;
  }

  private createAuthenticatedParams(
    fields: Record<string, SlackApiField> = {},
  ): Record<string, Exclude<SlackApiField, undefined>> {
    const params: Record<string, Exclude<SlackApiField, undefined>> = {
      token: this.requireApiToken(),
    };
    for (const [name, value] of Object.entries(fields)) {
      if (value !== undefined) {
        params[name] = value;
      }
    }
    return params;
  }

  private getCookieHeaders(): { Cookie: string } {
    return { Cookie: `d=${this.cookieD}` };
  }

  private async getSlackApi<T extends SlackApiResponse>(
    endpoint: string,
    fields: Record<string, SlackApiField> = {},
    retryOptions: TransientRetryOptions = {},
  ): Promise<T> {
    // Primary GET operations are idempotent and own one bounded retry budget,
    // including HTTP 429. Callers may lower that budget for optional enrichment.
    return this.withTransientRetry(
      `Slack GET ${endpoint}`,
      async () => {
        const response = await this.client.get<T>(endpoint, {
          params: this.createAuthenticatedParams(fields),
          headers: this.getCookieHeaders(),
        });
        return response.data;
      },
      { retryRateLimit: true, ...retryOptions },
    );
  }

  private async postSlackApi<T extends SlackApiResponse>(
    endpoint: string,
    fields: Record<string, SlackApiField>,
  ): Promise<T> {
    const response = await this.client.post<T>(endpoint, this.createAuthenticatedForm(fields), {
      headers: this.getCookieHeaders(),
    });
    return response.data;
  }

  private assertSlackOk<T extends SlackApiResponse>(response: T, fallbackMessage: string): T {
    if (!response.ok) {
      throw new Error(response.error || fallbackMessage);
    }
    return response;
  }

  private async withSlackError<T>(context: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw handleSlackError(error, context);
    }
  }

  /**
   * Fetch API token from workspace using the d cookie
   */
  private async fetchApiToken(workspaceUrl: string): Promise<string> {
    return this.withSlackError('fetch_api_token', async () => {
      logger.debug('Fetching API token from workspace...');

      const response = await this.withTransientRetry(
        'Slack token fetch',
        () => this.fetchWorkspaceHtml(workspaceUrl),
        { retryRateLimit: true },
      );

      // Extract api_token from the response HTML
      const html = String(response.data);

      // Try to find the api_token in the boot_data
      const match = html.match(/"api_token"\s*:\s*"([^"]+)"/);

      if (!match || !match[1]) {
        logger.error('Failed to extract API token. Response length:', html.length);
        logger.debug('Response type:', typeof response.data);
        // Check if api_token appears anywhere
        const hasApiToken = html.includes('api_token');
        logger.debug('Contains "api_token":', hasApiToken);
        if (hasApiToken) {
          const context = html.substring(
            html.indexOf('api_token') - 50,
            html.indexOf('api_token') + 150,
          );
          logger.debug('Context around api_token:', context);
        }
        throw new AuthenticationError('Failed to extract API token from workspace response');
      }

      const apiToken = match[1];
      logger.debug('API token fetched successfully');

      return apiToken;
    });
  }

  private async fetchWorkspaceHtml(workspaceUrl: string): Promise<{ data: string }> {
    let currentUrl = new URL('/ssb/redirect', `${normalizeSlackWorkspaceUrl(workspaceUrl)}/`);
    const maxRedirects = 5;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const response = await this.workspaceClient.get(currentUrl.href, {
        headers: { Cookie: `d=${this.cookieD}` },
        responseType: 'text',
        maxRedirects: 0,
        signal: this.requestSignal.getStore(),
        validateStatus: (status) => status >= 200 && status < 400,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const locationHeader = response.headers.location;
        const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
        if (!location) {
          throw new ValidationError('Slack workspace redirect did not include a Location header');
        }
        if (redirectCount === maxRedirects) {
          throw new ValidationError(`Slack workspace request exceeded ${maxRedirects} redirects`);
        }
        currentUrl = assertAllowedSlackUrl(new URL(String(location), currentUrl).href);
        continue;
      }

      if (response.status !== 200) {
        throw new Error(`Slack workspace request returned HTTP ${response.status}`);
      }
      return { data: String(response.data) };
    }

    throw new ValidationError('Slack workspace redirect handling failed');
  }

  /**
   * Detect workspace URL from cookie or use provided one
   */
  private async detectWorkspaceUrl(): Promise<string> {
    // If workspace URL is already configured, use it
    if (this.workspaceUrl) {
      return this.workspaceUrl;
    }

    // Try to detect from a test call or environment
    // For now, we'll throw an error asking user to provide it
    throw new AuthenticationError(
      'Workspace URL is required. Please provide it in the configuration (e.g., https://your-workspace.slack.com)',
    );
  }

  /**
   * Authenticate and validate the cookie
   */
  async authenticate(signal?: AbortSignal): Promise<void> {
    return this.withRequestSignal(signal, () =>
      this.withSlackError('authentication', async () => {
        logger.info('Authenticating with Slack...');

        // Determine the workspace URL
        const workspaceUrl = await this.detectWorkspaceUrl();

        // Fetch the API token using the d cookie
        this.apiToken = await this.fetchApiToken(workspaceUrl);
        this.workspaceUrl = workspaceUrl;

        const response = await this.withTransientRetry(
          'Slack authentication',
          () => this.postSlackApi<SlackAuthTestResponse>('/auth.test', {}),
          // auth.test is a non-mutating read despite using POST, so a bounded
          // HTTP 429 retry is safe. Message-writing POST calls remain unwrapped.
          { retryRateLimit: true },
        );

        if (!response.ok) {
          throw new AuthenticationError(
            'Authentication failed: ' + (response.error || 'Unknown error'),
          );
        }

        this.workspaceId = response.team_id;
        this.userId = response.user_id;
        this.workspaceUrl = response.url ? normalizeSlackWorkspaceUrl(response.url) : workspaceUrl;

        logger.info('Authentication successful', {
          workspace: response.team,
          user: response.user,
          team_id: this.workspaceId,
          user_id: this.userId,
        });
      }),
    );
  }

  /**
   * Return the user established by auth.test. This is intentionally not
   * exposed as an MCP tool, but lets guarded integration tests prove that a
   * requested self-only write target is the authenticated account.
   */
  getAuthenticatedUserId(): string {
    if (!this.userId) {
      throw new AuthenticationError('Slack client is not authenticated');
    }
    return this.userId;
  }

  /**
   * Send a message to a channel or DM
   */
  async sendMessage(params: {
    channel: string;
    text: string;
    thread_ts?: string;
    unfurl_links?: boolean;
    reply_broadcast?: boolean;
  }): Promise<SlackMessageResponse> {
    return this.withSlackError('send_message', async () => {
      logger.info('Sending message', {
        channel: params.channel,
        thread: params.thread_ts || 'none',
      });

      const response = this.assertSlackOk(
        await this.postSlackApi<SlackMessageResponse>('/chat.postMessage', {
          channel: params.channel,
          text: params.text,
          thread_ts: params.thread_ts || undefined,
          unfurl_links: params.unfurl_links ?? true,
          reply_broadcast: params.reply_broadcast || undefined,
        }),
        'Failed to send message',
      );

      logger.info('Message sent successfully', {
        channel: response.channel,
        ts: response.ts,
      });

      return response;
    });
  }

  /**
   * Update/edit an existing message
   */
  async updateMessage(params: {
    channel: string;
    ts: string;
    text: string;
  }): Promise<SlackMessageResponse> {
    return this.withSlackError('update_message', async () => {
      logger.info('Updating message', {
        channel: params.channel,
        ts: params.ts,
      });

      const response = this.assertSlackOk(
        await this.postSlackApi<SlackMessageResponse>('/chat.update', {
          channel: params.channel,
          ts: params.ts,
          text: params.text,
        }),
        'Failed to update message',
      );

      logger.info('Message updated successfully', {
        channel: response.channel,
        ts: response.ts,
      });

      return response;
    });
  }

  /**
   * Delete a message
   */
  async deleteMessage(params: { channel: string; ts: string }): Promise<void> {
    return this.withSlackError('delete_message', async () => {
      logger.info('Deleting message', {
        channel: params.channel,
        ts: params.ts,
      });

      this.assertSlackOk(
        await this.postSlackApi<SlackApiResponse>('/chat.delete', {
          channel: params.channel,
          ts: params.ts,
        }),
        'Failed to delete message',
      );

      logger.info('Message deleted successfully');
    });
  }

  /**
   * Schedule a message for future delivery
   */
  async scheduleMessage(params: {
    channel: string;
    text: string;
    post_at: number;
    thread_ts?: string;
  }): Promise<SlackScheduledMessageResponse> {
    return this.withSlackError('schedule_message', async () => {
      logger.info('Scheduling message', {
        channel: params.channel,
        post_at: new Date(params.post_at * 1000).toISOString(),
      });

      const response = this.assertSlackOk(
        await this.postSlackApi<SlackScheduledMessageResponse>('/chat.scheduleMessage', {
          channel: params.channel,
          text: params.text,
          post_at: params.post_at,
          thread_ts: params.thread_ts || undefined,
        }),
        'Failed to schedule message',
      );

      logger.info('Message scheduled successfully', {
        scheduled_message_id: response.scheduled_message_id,
        post_at: response.post_at,
      });

      return response;
    });
  }

  /**
   * Cancel a scheduled message. Kept at the client layer so live tests can
   * clean up a successful schedule without expanding the public MCP surface.
   */
  async deleteScheduledMessage(params: {
    channel: string;
    scheduled_message_id: string;
  }): Promise<void> {
    return this.withSlackError('delete_scheduled_message', async () => {
      this.assertSlackOk(
        await this.postSlackApi<SlackApiResponse>('/chat.deleteScheduledMessage', {
          channel: params.channel,
          scheduled_message_id: params.scheduled_message_id,
        }),
        'Failed to delete scheduled message',
      );
    });
  }

  /**
   * Fetch messages from a channel
   */
  async fetchMessages(params: {
    channel: string;
    limit?: number;
    oldest?: string;
    latest?: string;
  }): Promise<SlackMessage[]> {
    return this.withSlackError('fetch_messages', async () => {
      logger.info('Fetching messages', {
        channel: params.channel,
        limit: params.limit || 50,
      });

      const response = this.assertSlackOk(
        await this.getSlackApi<SlackConversationsHistoryResponse>('/conversations.history', {
          channel: params.channel,
          limit: params.limit || 50,
          oldest: params.oldest,
          latest: params.latest,
        }),
        'Failed to fetch messages',
      );

      logger.info(`Fetched ${response.messages.length} messages`);

      return response.messages;
    });
  }

  /**
   * Fetch one upstream page, separating parent context from paginated replies.
   */
  async fetchThreadReplies(params: {
    channel: string;
    thread_ts: string;
    limit?: number;
    cursor?: string;
  }): Promise<SlackThreadPage> {
    return this.withSlackError('fetch_thread_replies', async () => {
      const limit = params.limit ?? 100;
      validateFetchLimit(limit);
      const cursor = params.cursor?.trim() || undefined;
      logger.info('Fetching thread replies', {
        channel: params.channel,
        thread_ts: params.thread_ts,
      });

      const response = this.assertSlackOk(
        await this.getSlackApi<SlackConversationsRepliesResponse>('/conversations.replies', {
          channel: params.channel,
          ts: params.thread_ts,
          limit,
          cursor,
        }),
        'Failed to fetch thread replies',
      );

      // A reply link can identify a different timestamp than its thread root.
      // Reject that mismatch rather than misclassifying the linked reply as the parent.
      const differentThread = response.messages.find(
        (message) => message.thread_ts && message.thread_ts !== params.thread_ts,
      );
      if (differentThread) {
        throw new ValidationError(
          `thread_ts must be the parent message timestamp; Slack returned thread ${differentThread.thread_ts}.`,
        );
      }

      const parentMessage =
        response.messages.find((message) => message.ts === params.thread_ts) ?? null;
      const messages = response.messages.filter((message) => message.ts !== params.thread_ts);
      if (messages.length > limit) {
        // The upstream cursor has already advanced over this entire page. Slicing
        // the replies would permanently hide the discarded portion from callers.
        throw new SlackError(
          `Slack returned ${messages.length} replies for limit ${limit}; refusing to truncate the page.`,
          'PAGINATION_ERROR',
        );
      }

      const nextCursor = response.response_metadata?.next_cursor?.trim() || null;
      if (response.has_more && !nextCursor) {
        throw new SlackError(
          'Slack reported more thread replies without a continuation cursor.',
          'PAGINATION_ERROR',
        );
      }
      if (nextCursor && nextCursor === cursor) {
        throw new SlackError(
          'Slack returned a thread cursor that did not advance.',
          'PAGINATION_ERROR',
        );
      }

      logger.info(`Fetched ${messages.length} thread replies`, {
        parent_available: parentMessage !== null,
      });
      return {
        parentMessage,
        messages,
        hasMore: Boolean(nextCursor),
        nextCursor,
      };
    });
  }

  /**
   * Fetch metadata for a Slack file without exposing its private download URL.
   */
  async getFileInfo(fileId: string): Promise<SlackFile> {
    return this.withSlackError('get_file_info', async () => {
      logger.info('Fetching Slack file metadata', { file_id: fileId });
      const response = await this.getSlackApi<SlackFilesInfoResponse>('/files.info', {
        file: fileId,
      });

      this.assertSlackOk(response, 'Failed to fetch file information');
      if (!response.file) {
        throw new Error('Failed to fetch file information');
      }
      return response.file;
    });
  }

  private async openSlackDownloadStream(startUrl: string): Promise<SlackDownloadStream> {
    let currentUrl = assertAllowedSlackDownloadUrl(startUrl);
    const maxRedirects = 5;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const response = await axios.get(currentUrl.href, {
        timeout: 30_000,
        signal: this.requestSignal.getStore(),
        responseType: 'stream',
        maxRedirects: 0,
        decompress: false,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          Authorization: `Bearer ${this.requireApiToken()}`,
          Cookie: `d=${this.cookieD}`,
          'User-Agent': this.userAgent,
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.data?.destroy?.();
        const locationHeader = response.headers.location;
        const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
        if (!location) {
          throw new ValidationError('Slack returned a redirect without a Location header');
        }
        if (redirectCount === maxRedirects) {
          throw new ValidationError(`Slack file download exceeded ${maxRedirects} redirects`);
        }
        currentUrl = assertAllowedSlackDownloadUrl(new URL(String(location), currentUrl).href);
        continue;
      }

      if (response.status !== 200) {
        response.data?.destroy?.();
        throw Object.assign(new Error(`Slack file download returned HTTP ${response.status}`), {
          response: {
            status: response.status,
            headers: response.headers,
          },
        });
      }

      const lengthHeader = response.headers['content-length'];
      const lengthValue = lengthHeader ? String(lengthHeader).trim() : '';
      const parsedLength = /^\d+$/.test(lengthValue) ? Number(lengthValue) : Number.NaN;
      return {
        stream: response.data as SlackDownloadStream['stream'],
        contentType: String(response.headers['content-type'] || 'application/octet-stream')
          .split(';', 1)[0]
          .trim()
          .toLowerCase(),
        contentLength:
          Number.isSafeInteger(parsedLength) && parsedLength >= 0 ? parsedLength : undefined,
        redirectCount,
        finalUrl: currentUrl,
      };
    }

    throw new ValidationError('Slack file download redirect handling failed');
  }

  private async downloadFileOnce(
    file: SlackFile,
    downloadUrl: string,
    finalPath: string,
    options: FileDownloadOptions,
  ): Promise<FileDownloadResult> {
    const temporaryPath = `${finalPath}.${randomUUID()}.part`;
    let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
    let stream: SlackDownloadStream['stream'] | undefined;

    try {
      const response = await this.openSlackDownloadStream(downloadUrl);
      stream = response.stream;

      if (
        response.contentLength !== undefined &&
        response.contentLength >= MAX_FILE_DOWNLOAD_BYTES
      ) {
        throw new ValidationError('Slack response exceeds the 20 MiB download limit');
      }
      if (response.contentLength !== undefined && response.contentLength !== file.size) {
        throw new ValidationError('Slack response size does not match files.info metadata');
      }
      const expectedCategory = classifySlackFile(file.mimetype);
      const responseCategory = classifySlackFile(response.contentType);
      const responseSkipReason = getFileCategorySkipReason(responseCategory, options);
      if (responseSkipReason) {
        throw new ValidationError(`Slack response was rejected: ${responseSkipReason}`);
      }
      if (expectedCategory !== 'other' && responseCategory !== expectedCategory) {
        throw new ValidationError(
          `Slack returned ${response.contentType} for a ${expectedCategory} file; download was rejected`,
        );
      }

      handle = await fsPromises.open(temporaryPath, 'wx', 0o600);
      const hash = createHash('sha256');
      let bytes = 0;

      for await (const chunk of stream) {
        // Axios' Node stream normally yields Buffer instances. Reuse them
        // instead of copying every download chunk into a second allocation.
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes >= MAX_FILE_DOWNLOAD_BYTES) {
          throw new ValidationError('Downloaded content reached the 20 MiB limit');
        }
        hash.update(buffer);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
          if (bytesWritten <= 0) {
            throw new Error('Temporary Slack file write made no progress');
          }
          offset += bytesWritten;
        }
      }

      if (bytes !== file.size) {
        throw new ValidationError(
          `Downloaded ${bytes} bytes but files.info reported ${file.size} bytes`,
        );
      }

      // This is a TEMP artifact, so closing before the atomic rename is enough;
      // forcing a physical disk flush would add latency to every small image.
      await handle.close();
      handle = undefined;
      await fsPromises.rename(temporaryPath, finalPath);

      return {
        path: finalPath,
        bytes,
        sha256: hash.digest('hex'),
        content_type: response.contentType,
        redirect_count: response.redirectCount,
        final_host: response.finalUrl.hostname,
      };
    } catch (error) {
      stream?.destroy?.();
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await fsPromises.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async cleanupDownloadDirectoryIfDue(
    outputDirectory: string,
    now: number = Date.now(),
  ): Promise<void> {
    if (this.downloadDirectoryCleanup) {
      await this.downloadDirectoryCleanup;
      return;
    }
    if (now - this.lastDownloadDirectoryCleanupAt < DOWNLOAD_DIRECTORY_CLEANUP_INTERVAL_MS) {
      return;
    }

    // Record attempts, not just successes: a temporary cleanup failure should
    // not make every subsequent download retry filesystem work immediately.
    this.lastDownloadDirectoryCleanupAt = now;
    const cleanup = cleanupSlackDownloadDirectory(outputDirectory, now)
      .then((removed) => {
        if (removed > 0) logger.info(`Removed ${removed} expired Slack temp file(s)`);
      })
      .catch((error: unknown) => {
        logger.warn('Failed to clean expired Slack temp files', error);
      })
      .finally(() => {
        this.downloadDirectoryCleanup = undefined;
      });
    this.downloadDirectoryCleanup = cleanup;
    await cleanup;
  }

  /**
   * Download a previously validated Slack-hosted file into the OS temp folder.
   */
  async downloadFile(
    file: SlackFile,
    options: FileDownloadOptions = {},
  ): Promise<FileDownloadResult> {
    return this.withSlackError('download_file', async () => {
      const fileSize = file.size;
      if (typeof fileSize !== 'number' || !Number.isSafeInteger(fileSize) || fileSize < 0) {
        throw new ValidationError('Slack file size is missing or invalid');
      }
      if (fileSize >= MAX_FILE_DOWNLOAD_BYTES) {
        throw new ValidationError('Slack file must be strictly smaller than 20 MiB');
      }
      if (file.is_external || file.mode === 'external') {
        throw new ValidationError('External or remote Slack files are metadata-only');
      }

      const privateUrl = file.url_private_download || file.url_private;
      if (!privateUrl) {
        throw new ValidationError('Slack did not provide a private download URL');
      }
      assertAllowedSlackDownloadUrl(privateUrl);

      const safeFileId = normalizeSlackFileId(file.id);
      const outputDirectory = path.join(os.tmpdir(), 'slack-local-mcp');
      await fsPromises.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      await this.cleanupDownloadDirectoryIfDue(outputDirectory);
      const filename = sanitizeDownloadFilename(file.name || file.title || safeFileId, safeFileId);
      const finalPath = path.join(
        outputDirectory,
        `${safeFileId}-${Date.now()}-${randomUUID().slice(0, 8)}-${filename}`,
      );

      return await this.withTransientRetry(
        'Slack file download',
        () => this.downloadFileOnce(file, privateUrl, finalPath, options),
        { retryRateLimit: true },
      );
    });
  }

  /**
   * Add a reaction to a message
   */
  async addReaction(params: { channel: string; timestamp: string; name: string }): Promise<void> {
    return this.withSlackError('add_reaction', async () => {
      logger.info('Adding reaction', {
        channel: params.channel,
        timestamp: params.timestamp,
        emoji: params.name,
      });

      const response = await this.postSlackApi<SlackReactionsAddResponse>('/reactions.add', {
        channel: params.channel,
        timestamp: params.timestamp,
        name: params.name,
      });

      if (!response.ok) {
        // Handle "already_reacted" gracefully
        if (response.error === 'already_reacted') {
          logger.info('Reaction already exists, skipping');
          return;
        }
        this.assertSlackOk(response, 'Failed to add reaction');
      }

      logger.info('Reaction added successfully');
    });
  }
  /**
   * Open a DM conversation with a user
   */
  async openDirectMessage(userId: string): Promise<string> {
    return this.withSlackError('open_dm', async () => {
      logger.info('Opening DM conversation', { userId });

      const response = this.assertSlackOk(
        await this.postSlackApi<SlackConversationsOpenResponse>('/conversations.open', {
          users: userId,
        }),
        'Failed to open DM',
      );

      const channelId = response.channel.id;
      logger.info('DM conversation opened', { channelId });

      return channelId;
    });
  }

  private cacheUsername(userId: string, displayName: string): void {
    const normalizedName = displayName.trim();
    if (!normalizedName) return;

    // Keep a small insertion-ordered working set rather than retaining an
    // entire large workspace directory in every long-lived MCP process.
    this.userCache.delete(userId);
    this.userCache.set(userId, normalizedName);
    if (this.userCache.size > this.maxCachedUsernames) {
      const oldestUserId = this.userCache.keys().next().value;
      if (oldestUserId !== undefined) {
        this.userCache.delete(oldestUserId);
      }
    }
  }

  private getCachedUsername(userId: string): string | undefined {
    const displayName = this.userCache.get(userId);
    if (displayName !== undefined) {
      // Refresh recently used message authors before optional enrichment can
      // evict older entries from the bounded cache.
      this.userCache.delete(userId);
      this.userCache.set(userId, displayName);
    }
    return displayName;
  }

  private cacheUserRecords(users: Iterable<UserRecord>): void {
    for (const user of users) {
      this.cacheUsername(user.id, user.display_name || user.real_name || user.name);
    }
  }

  /**
   * Get user information and cache it
   */
  async getUserInfo(userId: string): Promise<SlackUser> {
    return this.withSlackError('get_user_info', async () => {
      const response = this.assertSlackOk(
        await this.getSlackApi<SlackUsersInfoResponse>(
          '/users.info',
          { user: userId },
          // Name enrichment is best-effort. One failed lookup should fall back
          // to the user ID instead of multiplying optional network requests.
          { retryRateLimit: false, maxAttempts: 1 },
        ),
        'Failed to get user info',
      );

      // Cache the user's display name
      const displayName =
        response.user.profile.display_name || response.user.real_name || response.user.name;
      this.cacheUsername(userId, displayName);

      return response.user;
    });
  }

  /**
   * Get cached username or fetch if not cached
   */
  async resolveUsername(userId: string): Promise<string> {
    const cachedName = this.getCachedUsername(userId);
    if (cachedName !== undefined) {
      return cachedName;
    }

    try {
      const user = await this.getUserInfo(userId);
      return user.profile.display_name || user.real_name || user.name;
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof CancelledError) {
        throw error;
      }
      logger.debug(`Could not resolve username for ${userId}`);
      return userId;
    }
  }

  /**
   * Load user list cache from file
   */
  private async loadUserListCache(): Promise<UserCacheData | null> {
    try {
      const data = await fsPromises.readFile(this.userCacheFile, 'utf-8');
      const cache: UserCacheData = JSON.parse(data);

      // Check if cache is for the same workspace
      if (cache.workspace_id !== this.workspaceId) {
        logger.debug('Cache is for different workspace, ignoring');
        return null;
      }

      // Validate cache structure
      if (!Array.isArray(cache.users)) {
        logger.debug('Invalid cache structure, ignoring');
        return null;
      }
      const now = Date.now();
      const age = now - cache.timestamp;
      if (
        !Number.isFinite(cache.timestamp) ||
        cache.timestamp <= 0 ||
        age < 0 ||
        age > this.userCacheTtlMs
      ) {
        logger.debug('User list cache is stale, ignoring', {
          age_ms: Number.isFinite(age) ? age : null,
          ttl_ms: this.userCacheTtlMs,
        });
        return null;
      }

      logger.debug('Loaded user list cache from file', {
        users: cache.users.length,
        age: Math.floor(age / 1000) + 's',
      });

      return cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Failed to load user list cache', error);
      }
      return null;
    }
  }

  /**
   * Save user list cache to file
   */
  private async saveUserListCache(cache: UserCacheData): Promise<void> {
    let temporaryFile: string | undefined;
    try {
      // Ensure directory exists
      const dir = path.dirname(this.userCacheFile);
      await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });

      temporaryFile = `${this.userCacheFile}.${process.pid}.${randomUUID()}.tmp`;
      await fsPromises.writeFile(temporaryFile, JSON.stringify(cache), {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      await fsPromises.rename(temporaryFile, this.userCacheFile);
      temporaryFile = undefined;
      logger.debug('Saved user list cache to file', {
        users: cache.users.length,
        file: this.userCacheFile,
      });
    } catch (error) {
      logger.warn('Failed to save user list cache', error);
    } finally {
      if (temporaryFile) {
        // Best-effort cleanup after a concurrent writer or interrupted rename.
        await fsPromises.unlink(temporaryFile).catch(() => undefined);
      }
    }
  }

  /**
   * Paginate through users.list incrementally, applying scoreFn per page.
   * Stops early when enough high-confidence matches are found.
   * Saves full cache to disk only when all pages have been fetched.
   */
  async searchUsersIncremental(
    scoreFn: (user: UserRecord) => number,
    limit: number,
    options: SearchUsersIncrementalOptions = {},
  ): Promise<SearchUsersIncrementalResult> {
    const earlyStopThreshold = options.earlyStopThreshold ?? 80;
    const forceFullScan = options.forceFullScan ?? false;
    const maxPages = forceFullScan
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(options.maxPages ?? Number.POSITIVE_INFINITY));
    const startingCursor = options.cursor?.trim() || undefined;

    // Phase 1: Try cache first (zero Slack API calls; disk access is async)
    if (!options.skipCache && !startingCursor) {
      const cached = await this.getOrLoadUserListCache();
      if (cached) {
        const scored: ScoredUserRecord[] = [];
        for (const user of cached.users) {
          insertTopScoredUser(scored, user, scoreFn(user), limit);
        }
        if (scored.length > 0) {
          // Intentional bounded-staleness trade-off: positive hits remain
          // zero-network for the one-hour TTL. Callers can explicitly skip or
          // refresh the cache when a current directory matters more.
          this.cacheUserRecords(scored);
          return {
            results: scored,
            source: 'cache',
            exhaustive: true,
            scannedUsers: 0,
          };
        }
        // A cached miss is not authoritative: a user may have joined since the
        // snapshot. Fall through to a bounded live search instead.
        logger.debug('User cache had no matches; checking Slack for newer users');
      }
    }

    // Phase 2: Incremental API pagination
    return this.withSlackError('search_users_incremental', async () => {
      logger.info('Searching users via incremental API pagination');
      const allFetchedUsers: UserRecord[] = [];
      const scoredResults: ScoredUserRecord[] = [];
      let cursor: string | undefined = startingCursor;
      let pagesFetched = 0;
      const pageSize = 100;

      do {
        const response: SlackUsersListResponse = this.assertSlackOk(
          await this.getSlackApi<SlackUsersListResponse>('/users.list', {
            limit: pageSize,
            cursor,
          }),
          'Failed to list users',
        );

        pagesFetched += 1;

        // Build the persistent directory snapshot while retaining only the
        // best requested matches in the separate in-memory display-name cache.
        for (const user of response.members || []) {
          if (user.deleted || user.is_bot) continue;
          const record: UserRecord = {
            id: user.id,
            name: user.name,
            display_name: user.profile.display_name || '',
            real_name: user.real_name || '',
          };
          allFetchedUsers.push(record);
          insertTopScoredUser(scoredResults, record, scoreFn(record), limit);
        }

        logger.debug(
          `Paginated ${allFetchedUsers.length} users so far, retained ${scoredResults.length} top matches`,
        );

        cursor = response.response_metadata?.next_cursor || undefined;

        // Early termination: enough high-confidence matches AND more pages remain
        if (!forceFullScan && cursor && scoredResults.length >= limit) {
          const topN = scoredResults;
          if (topN.every((r) => r.score >= earlyStopThreshold)) {
            logger.info(`Early stop: found ${limit} matches scoring >= ${earlyStopThreshold}`);
            this.cacheUserRecords(topN);
            return {
              results: topN,
              source: 'api',
              exhaustive: false,
              scannedUsers: allFetchedUsers.length,
              nextCursor: cursor,
            };
          }
        }

        if (!forceFullScan && cursor && pagesFetched >= maxPages) {
          logger.info(`User search paused after ${pagesFetched} page(s)`);
          this.cacheUserRecords(scoredResults);
          return {
            results: scoredResults,
            source: 'api',
            exhaustive: false,
            scannedUsers: allFetchedUsers.length,
            nextCursor: cursor,
          };
        }

        // Do not add an unconditional inter-page delay. The shared idempotent
        // GET policy already honors HTTP 429 Retry-After with a bounded retry.
      } while (cursor);

      // Only a scan that started at the beginning represents a complete list.
      if (!startingCursor) {
        const cache: UserCacheData = {
          users: allFetchedUsers,
          timestamp: Date.now(),
          workspace_id: this.requireWorkspaceId(),
        };
        this.userListCache = cache;
        await this.saveUserListCache(cache);
        logger.info(`Full pagination complete: ${allFetchedUsers.length} users cached`);
      }

      this.cacheUserRecords(scoredResults);
      return {
        results: scoredResults,
        source: 'api',
        exhaustive: true,
        scannedUsers: allFetchedUsers.length,
      };
    });
  }

  /**
   * Return a complete directory only when it is already loaded and still fresh.
   */
  private getFreshInMemoryUserListCache(): UserCacheData | null {
    if (!this.userListCache) return null;

    const age = Date.now() - this.userListCache.timestamp;
    if (Number.isFinite(age) && age >= 0 && age <= this.userCacheTtlMs) {
      return this.userListCache;
    }
    this.userListCache = null;
    return null;
  }

  /**
   * Get user list from cache only (memory or async file I/O). Never triggers API calls.
   * Returns null if no cache is available.
   */
  async getOrLoadUserListCache(): Promise<UserCacheData | null> {
    const memoryCache = this.getFreshInMemoryUserListCache();
    if (memoryCache) return memoryCache;

    const fileCache = await this.loadUserListCache();
    if (fileCache) {
      this.userListCache = fileCache;
    }
    return this.userListCache;
  }

  /**
   * Get the user cache for formatting
   */
  getUserCache(): Map<string, string> {
    return this.userCache;
  }

  /**
   * Populate user cache for a list of messages
   */
  async populateUserCache(messages: Iterable<{ user?: string; username?: string }>): Promise<void> {
    const userIds = new Set<string>();

    for (const message of messages) {
      if (!message.user) continue;
      if (this.getCachedUsername(message.user) !== undefined) {
        userIds.delete(message.user);
        continue;
      }

      // search.messages normally supplies a usable username already. Prefer
      // that response hint over an optional users.info round trip.
      const usernameHint = message.username?.trim();
      if (usernameHint) {
        userIds.delete(message.user);
        this.cacheUsername(message.user, usernameHint);
        continue;
      }
      userIds.add(message.user);
    }

    // Reuse a complete directory only when another user-search operation has
    // already loaded it. Do not pull a potentially large file into memory just
    // to decorate one message response.
    const directoryCache = this.getFreshInMemoryUserListCache();
    if (directoryCache && userIds.size > 0) {
      for (const user of directoryCache.users) {
        if (!userIds.has(user.id)) continue;
        this.cacheUsername(user.id, user.display_name || user.real_name || user.name);
        userIds.delete(user.id);
        if (userIds.size === 0) break;
      }
    }

    // Name enrichment is optional: bound both its concurrency and total work.
    // Four waves of eight lookups keep common authors readable without making a
    // large message page wait for every previously unseen user.
    const pendingUserIds = Array.from(userIds).slice(0, this.maxUserEnrichmentLookups);
    const omittedUserIds = userIds.size - pendingUserIds.length;
    if (omittedUserIds > 0) {
      logger.debug('Skipped optional user-name enrichment beyond the per-response limit', {
        limit: this.maxUserEnrichmentLookups,
        omitted_users: omittedUserIds,
      });
    }
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(this.userLookupConcurrency, pendingUserIds.length) },
      async () => {
        while (nextIndex < pendingUserIds.length) {
          const userId = pendingUserIds[nextIndex];
          nextIndex += 1;
          await this.resolveUsername(userId).catch((error: unknown) => {
            if (error instanceof AuthenticationError || error instanceof CancelledError) {
              throw error;
            }
            logger.debug(`Failed to fetch user info for ${userId}`);
          });
        }
      },
    );
    await Promise.all(workers);
  }

  /**
   * Search for messages in the workspace
   */
  async searchMessages(params: {
    query: string;
    count?: number;
    page?: number;
    sort?: 'score' | 'timestamp';
    sort_dir?: 'asc' | 'desc';
    highlight?: boolean;
  }): Promise<SlackSearchMessagesResponse> {
    return this.withSlackError('search_messages', async () => {
      // Validate query parameter
      const trimmedQuery = params.query.trim();
      if (!trimmedQuery) {
        throw new ValidationError('Search query cannot be empty');
      }

      logger.info('Searching messages', {
        query: trimmedQuery,
        count: params.count || 20,
        page: params.page || 1,
      });

      const response = this.assertSlackOk(
        await this.getSlackApi<SlackSearchMessagesResponse>('/search.messages', {
          query: trimmedQuery,
          count: params.count || 20,
          page: params.page || 1,
          sort: params.sort || 'score',
          sort_dir: params.sort_dir || 'desc',
          highlight: params.highlight !== false,
        }),
        'Failed to search messages',
      );

      logger.info(
        `Found ${response.messages.matches.length} messages (${response.messages.total} total)`,
      );

      return response;
    });
  }
}
