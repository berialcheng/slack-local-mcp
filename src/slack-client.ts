/**
 * Slack API Client with cookie-based authentication
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import {
  SlackClientConfig,
  SlackAuthTestResponse,
  SlackMessageResponse,
  SlackScheduledMessageResponse,
  SlackConversationsHistoryResponse,
  SlackConversationsRepliesResponse,
  SlackConversationsOpenResponse,
  SlackReactionsAddResponse,
  SlackUsersInfoResponse,
  SlackMessage,
  SlackUser,
  AuthenticationError,
  ValidationError,
  SlackRemindersListResponse,
  SlackReminderResponse,
  SlackReminder,
  SlackSearchMessagesResponse,
} from './types.js';
import { logger } from './utils/logger.js';
import { handleSlackError } from './utils/errors.js';
import { validateSlackCookie } from './utils/validation.js';

interface UserCacheData {
  users: Array<{
    id: string;
    name: string;
    display_name: string;
    real_name: string;
  }>;
  timestamp: number;
  workspace_id: string;
}

interface BackgroundRefreshState {
  isRefreshing: boolean;
  lastRefreshAttempt: number;
}

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
  private userCacheTTL: number;
  private retryDelay = 1000; // milliseconds
  private backgroundRefreshState: BackgroundRefreshState = {
    isRefreshing: false,
    lastRefreshAttempt: 0,
  };

  constructor(config: SlackClientConfig) {
    // Validate cookie
    validateSlackCookie(config.cookieD);
    
    this.cookieD = config.cookieD;
    this.workspaceUrl = config.workspaceUrl;
    this.userAgent = config.userAgent || 'Slack-MCP-Client/1.0';
    
    // Configure user list cache (from config or defaults)
    this.userCacheFile = config.userCacheFile || '/tmp/slack-mcp-users-cache.json';
    this.userCacheTTL = (config.userCacheTTL || 86400) * 1000; // Default 24 hours, convert to ms
    
    // Create workspace client for initial token fetch
    this.workspaceClient = axios.create({
      timeout: 30000,
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
      timeout: 30000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      },
    });

    // Add request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        logger.debug(`API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        logger.error('Request interceptor error', error);
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging and error handling
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(`API Response: ${response.config.url}`, {
          status: response.status,
          ok: response.data?.ok,
        });
        return response;
      },
      async (error: AxiosError) => {
        // Handle rate limiting with retry
        if (error.response?.status === 429) {
          const retryAfter = error.response.headers['retry-after'];
          const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : this.retryDelay;
          
          logger.warn(`Rate limited, retrying after ${delay}ms`);
          
          await this.sleep(delay);
          // Retry the request once
          if (error.config) {
            return this.client.request(error.config);
          }
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Sleep utility for delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fetch API token from workspace using the d cookie
   */
  private async fetchApiToken(workspaceUrl: string): Promise<string> {
    try {
      logger.debug('Fetching API token from workspace...');
      
      const response = await this.workspaceClient.get(`${workspaceUrl}/ssb/redirect`, {
        headers: {
          Cookie: `d=${this.cookieD}`,
        },
        responseType: 'text', // Ensure we get text, not parsed JSON
      });
      
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
          const context = html.substring(html.indexOf('api_token') - 50, html.indexOf('api_token') + 150);
          logger.debug('Context around api_token:', context);
        }
        throw new AuthenticationError('Failed to extract API token from workspace response');
      }
      
      const apiToken = match[1];
      logger.debug('API token fetched successfully');
      
      return apiToken;
    } catch (error) {
      throw handleSlackError(error, 'fetch_api_token');
    }
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
      'Workspace URL is required. Please provide it in the configuration (e.g., https://your-workspace.slack.com)'
    );
  }

  /**
   * Authenticate and validate the cookie
   */
  async authenticate(): Promise<void> {
    try {
      logger.info('Authenticating with Slack...');
      
      // Determine the workspace URL
      const workspaceUrl = await this.detectWorkspaceUrl();
      
      // Fetch the API token using the d cookie
      this.apiToken = await this.fetchApiToken(workspaceUrl);
      this.workspaceUrl = workspaceUrl;
      
      // Now authenticate with both cookie and token
      const params = new URLSearchParams();
      params.append('token', this.apiToken);
      
      const response = await this.client.post<SlackAuthTestResponse>(
        '/auth.test',
        params,
        {
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );
      
      if (!response.data.ok) {
        throw new AuthenticationError(
          'Authentication failed: ' + (response.data.error || 'Unknown error')
        );
      }

      this.workspaceId = response.data.team_id;
      this.userId = response.data.user_id;
      this.workspaceUrl = response.data.url;

      logger.info('Authentication successful', {
        workspace: response.data.team,
        user: response.data.user,
        team_id: this.workspaceId,
        user_id: this.userId,
      });
    } catch (error) {
      throw handleSlackError(error, 'authentication');
    }
  }

  /**
   * Send a message to a channel or DM
   */
  async sendMessage(params: {
    channel: string;
    text: string;
    thread_ts?: string;
    unfurl_links?: boolean;
  }): Promise<SlackMessageResponse> {
    try {
      logger.info('Sending message', {
        channel: params.channel,
        thread: params.thread_ts || 'none',
      });

      const formData = new URLSearchParams();
      formData.append('token', this.apiToken!);
      formData.append('channel', params.channel);
      formData.append('text', params.text);
      if (params.thread_ts) formData.append('thread_ts', params.thread_ts);
      formData.append('unfurl_links', String(params.unfurl_links ?? true));
      
      const response = await this.client.post<SlackMessageResponse>(
        '/chat.postMessage',
        formData,
        {
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to send message');
      }

      logger.info('Message sent successfully', {
        channel: response.data.channel,
        ts: response.data.ts,
      });

      return response.data;
    } catch (error) {
      throw handleSlackError(error, 'send_message');
    }
  }

  /**
   * Update/edit an existing message
   */
  async updateMessage(params: {
    channel: string;
    ts: string;
    text: string;
  }): Promise<SlackMessageResponse> {
    try {
      logger.info('Updating message', {
        channel: params.channel,
        ts: params.ts,
      });

      const formData = new URLSearchParams();
      formData.append('token', this.apiToken!);
      formData.append('channel', params.channel);
      formData.append('ts', params.ts);
      formData.append('text', params.text);
      
      const response = await this.client.post<SlackMessageResponse>(
        '/chat.update',
        formData,
        {
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to update message');
      }

      logger.info('Message updated successfully', {
        channel: response.data.channel,
        ts: response.data.ts,
      });

      return response.data;
    } catch (error) {
      throw handleSlackError(error, 'update_message');
    }
  }

  /**
   * Delete a message
   */
  async deleteMessage(params: {
    channel: string;
    ts: string;
  }): Promise<void> {
    try {
      logger.info('Deleting message', {
        channel: params.channel,
        ts: params.ts,
      });

      const formData = new URLSearchParams();
      formData.append('token', this.apiToken!);
      formData.append('channel', params.channel);
      formData.append('ts', params.ts);
      
      const response = await this.client.post<SlackMessageResponse>(
        '/chat.delete',
        formData,
        {
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to delete message');
      }

      logger.info('Message deleted successfully');
    } catch (error) {
      throw handleSlackError(error, 'delete_message');
    }
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
    try {
      logger.info('Scheduling message', {
        channel: params.channel,
        post_at: new Date(params.post_at * 1000).toISOString(),
      });

      const formData = new URLSearchParams();
      formData.append('token', this.apiToken!);
      formData.append('channel', params.channel);
      formData.append('text', params.text);
      formData.append('post_at', String(params.post_at));
      if (params.thread_ts) formData.append('thread_ts', params.thread_ts);
      
      const response = await this.client.post<SlackScheduledMessageResponse>(
        '/chat.scheduleMessage',
        formData,
        {
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to schedule message');
      }

      logger.info('Message scheduled successfully', {
        scheduled_message_id: response.data.scheduled_message_id,
        post_at: response.data.post_at,
      });

      return response.data;
    } catch (error) {
      throw handleSlackError(error, 'schedule_message');
    }
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
    try {
      logger.info('Fetching messages', {
        channel: params.channel,
        limit: params.limit || 50,
      });

      const response = await this.client.get<SlackConversationsHistoryResponse>(
        '/conversations.history',
        {
          params: {
            token: this.apiToken!,
            channel: params.channel,
            limit: params.limit || 50,
            oldest: params.oldest,
            latest: params.latest,
          },
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to fetch messages');
      }

      logger.info(`Fetched ${response.data.messages.length} messages`);

      return response.data.messages;
    } catch (error) {
      throw handleSlackError(error, 'fetch_messages');
    }
  }

  /**
   * Fetch replies from a thread
   */
  async fetchThreadReplies(params: {
    channel: string;
    thread_ts: string;
    limit?: number;
  }): Promise<SlackMessage[]> {
    try {
      logger.info('Fetching thread replies', {
        channel: params.channel,
        thread_ts: params.thread_ts,
      });

      const response = await this.client.get<SlackConversationsRepliesResponse>(
        '/conversations.replies',
        {
          params: {
            token: this.apiToken!,
            channel: params.channel,
            ts: params.thread_ts,
            limit: params.limit || 100,
          },
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to fetch thread replies');
      }

      logger.info(`Fetched ${response.data.messages.length} thread replies`);

      return response.data.messages;
    } catch (error) {
      throw handleSlackError(error, 'fetch_thread_replies');
    }
  }

  /**
   * Add a reaction to a message
   */
  async addReaction(params: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<void> {
    try {
      logger.info('Adding reaction', {
        channel: params.channel,
        timestamp: params.timestamp,
        emoji: params.name,
      });

      const formData = new URLSearchParams();
      formData.append('token', this.apiToken!);
      formData.append('channel', params.channel);
      formData.append('timestamp', params.timestamp);
      formData.append('name', params.name);
      
      const response = await this.client.post<SlackReactionsAddResponse>(
        '/reactions.add',
        formData,
        {
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        // Handle "already_reacted" gracefully
        if (response.data.error === 'already_reacted') {
          logger.info('Reaction already exists, skipping');
          return;
        }
        throw new Error(response.data.error || 'Failed to add reaction');
      }

      logger.info('Reaction added successfully');
    } catch (error) {
      throw handleSlackError(error, 'add_reaction');
    }
  }
  /**
   * List all reminders
   */
  async listReminders(): Promise<SlackReminder[]> {
    try {
      logger.info('Fetching reminders list');

      const response = await this.client.get<SlackRemindersListResponse>('/reminders.list', {
        params: {
          token: this.apiToken!,
        },
        headers: {
          Cookie: `d=${this.cookieD}`,
        },
      });

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to list reminders');
      }

      logger.info(`Fetched ${response.data.reminders.length} reminders`);

      return response.data.reminders;
    } catch (error) {
      throw handleSlackError(error, 'list_reminders');
    }
  }

  /**
   * Create a new reminder
   */
  async createReminder(params: {
    text: string;
    time: number;
    user?: string;
  }): Promise<SlackReminder> {
    try {
      logger.info('Creating reminder', {
        text: params.text,
        time: new Date(params.time * 1000).toISOString(),
        user: params.user || 'self',
      });

      const formData = new URLSearchParams();
      formData.append('token', this.apiToken!);
      formData.append('text', params.text);
      formData.append('time', String(params.time));
      if (params.user) {
        formData.append('user', params.user);
      }
      
      const response = await this.client.post<SlackReminderResponse>(
        '/reminders.add',
        formData,
        {
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to create reminder');
      }

      logger.info('Reminder created successfully', {
        reminder_id: response.data.reminder.id,
      });

      return response.data.reminder;
    } catch (error) {
      throw handleSlackError(error, 'create_reminder');
    }
  }

  /**
   * Complete a reminder
   */
  async completeReminder(reminderId: string): Promise<void> {
    try {
      logger.info('Completing reminder', { reminderId });

      const formData = new URLSearchParams();
      formData.append('token', this.apiToken!);
      formData.append('reminder', reminderId);
      
      const response = await this.client.post<SlackReminderResponse>(
        '/reminders.complete',
        formData,
        {
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to complete reminder');
      }

      logger.info('Reminder completed successfully');
    } catch (error) {
      throw handleSlackError(error, 'complete_reminder');
    }
  }

  /**
   * Delete a reminder
   */
  async deleteReminder(reminderId: string): Promise<void> {
    try {
      logger.info('Deleting reminder', { reminderId });

      const formData = new URLSearchParams();
      formData.append('token', this.apiToken!);
      formData.append('reminder', reminderId);
      
      const response = await this.client.post<SlackReminderResponse>(
        '/reminders.delete',
        formData,
        {
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to delete reminder');
      }

      logger.info('Reminder deleted successfully');
    } catch (error) {
      throw handleSlackError(error, 'delete_reminder');
    }
  }


  /**
   * Open a DM conversation with a user
   */
  async openDirectMessage(userId: string): Promise<string> {
    try {
      logger.info('Opening DM conversation', { userId });

      const formData = new URLSearchParams();
      formData.append('token', this.apiToken!);
      formData.append('users', userId);
      
      const response = await this.client.post<SlackConversationsOpenResponse>(
        '/conversations.open',
        formData,
        {
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to open DM');
      }

      const channelId = response.data.channel.id;
      logger.info('DM conversation opened', { channelId });

      return channelId;
    } catch (error) {
      throw handleSlackError(error, 'open_dm');
    }
  }

  /**
   * Get user information and cache it
   */
  async getUserInfo(userId: string): Promise<SlackUser> {
    try {
      const response = await this.client.get<SlackUsersInfoResponse>('/users.info', {
        params: {
          token: this.apiToken!,
          user: userId
        },
        headers: {
          Cookie: `d=${this.cookieD}`,
        },
      });

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to get user info');
      }

      // Cache the user's display name
      const displayName = response.data.user.profile.display_name || 
                         response.data.user.real_name || 
                         response.data.user.name;
      this.userCache.set(userId, displayName);

      return response.data.user;
    } catch (error) {
      // If we can't get user info, just return the user ID
      logger.warn(`Failed to get user info for ${userId}`, error);
      throw handleSlackError(error, 'get_user_info');
    }
  }

  /**
   * Get cached username or fetch if not cached
   */
  async resolveUsername(userId: string): Promise<string> {
    if (this.userCache.has(userId)) {
      return this.userCache.get(userId)!;
    }

    try {
      const user = await this.getUserInfo(userId);
      return user.profile.display_name || user.real_name || user.name;
    } catch (error) {
      logger.debug(`Could not resolve username for ${userId}`);
      return userId;
    }
  }

  /**
   * Load user list cache from file
   */
  private loadUserListCache(): UserCacheData | null {
    try {
      if (!fs.existsSync(this.userCacheFile)) {
        return null;
      }

      const data = fs.readFileSync(this.userCacheFile, 'utf-8');
      const cache: UserCacheData = JSON.parse(data);

      // Check if cache is for the same workspace
      if (cache.workspace_id !== this.workspaceId) {
        logger.debug('Cache is for different workspace, ignoring');
        return null;
      }

      // Don't check expiry here - we'll handle stale cache in getUserList
      // Just validate the cache structure
      const now = Date.now();
      
      logger.debug('Loaded user list cache from file', {
        users: cache.users.length,
        age: Math.floor((now - cache.timestamp) / 1000) + 's',
      });

      return cache;
    } catch (error) {
      logger.warn('Failed to load user list cache', error);
      return null;
    }
  }

  /**
   * Save user list cache to file
   */
  private saveUserListCache(cache: UserCacheData): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.userCacheFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.userCacheFile, JSON.stringify(cache, null, 2), 'utf-8');
      logger.debug('Saved user list cache to file', {
        users: cache.users.length,
        file: this.userCacheFile,
      });
    } catch (error) {
      logger.warn('Failed to save user list cache', error);
    }
  }

  /**
   * Fetch and cache the full user list with pagination support
   */
  private async fetchAndCacheUserList(): Promise<UserCacheData> {
    try {
      logger.info('Fetching user list from Slack API');

      const allUsers: SlackUser[] = [];
      let cursor: string | undefined = undefined;
      const limit = 1000; // Maximum allowed by Slack API

      // Fetch all pages
      do {
        const params: Record<string, string> = {
          token: this.apiToken!,
          limit: String(limit),
        };

        if (cursor) {
          params.cursor = cursor;
        }

        const response = await this.client.get('/users.list', {
          params,
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        });

        if (!response.data.ok) {
          throw new Error(response.data.error || 'Failed to list users');
        }

        // Add users from this page
        if (response.data.members && Array.isArray(response.data.members)) {
          allUsers.push(...response.data.members);
          logger.debug(`Fetched ${response.data.members.length} users (total: ${allUsers.length})`);
        }

        // Get cursor for next page
        cursor = response.data.response_metadata?.next_cursor;
        
        // If there's a next page, add a small delay to avoid rate limits
        if (cursor) {
          await this.sleep(3000);
        }
      } while (cursor);

      // Extract relevant user data and filter out deleted users and bots
      const users = allUsers
        .filter((u: SlackUser) => {
          // Exclude deleted users
          if (u.deleted) return false;
          // Exclude bots
          if (u.is_bot) return false;
          return true;
        })
        .map((u: SlackUser) => ({
          id: u.id,
          name: u.name,
          display_name: u.profile.display_name || '',
          real_name: u.real_name || '',
        }));

      const cache: UserCacheData = {
        users,
        timestamp: Date.now(),
        workspace_id: this.workspaceId!,
      };

      // Save to memory and file
      this.userListCache = cache;
      this.saveUserListCache(cache);

      logger.info(`Cached ${users.length} users from ${allUsers.length} total members`);

      return cache;
    } catch (error) {
      logger.error('Failed to fetch user list', error);
      throw handleSlackError(error, 'fetch_user_list');
    }
  }

  /**
   * Get user list from cache or fetch if needed
   * Uses stale-while-revalidate pattern to avoid blocking on cache refresh
   */
  async getUserList(): Promise<UserCacheData> {
    const now = Date.now();

    // Check memory cache first
    if (this.userListCache) {
      const cacheAge = now - this.userListCache.timestamp;
      
      if (cacheAge <= this.userCacheTTL) {
        // Cache is fresh, use it
        logger.debug('Using fresh in-memory user list cache');
        return this.userListCache;
      } else {
        // Cache is stale but exists - use it and trigger background refresh
        logger.debug('Cache is stale, using stale cache and triggering background refresh');
        this.triggerBackgroundRefresh();
        return this.userListCache;
      }
    }

    // Try to load from file cache
    const fileCache = this.loadUserListCache();
    if (fileCache) {
      this.userListCache = fileCache;
      const cacheAge = now - fileCache.timestamp;
      
      if (cacheAge <= this.userCacheTTL) {
        // File cache is fresh
        logger.debug('Using fresh file cache');
        return fileCache;
      } else {
        // File cache is stale - use it and trigger background refresh
        logger.debug('File cache is stale, using stale cache and triggering background refresh');
        this.triggerBackgroundRefresh();
        return fileCache;
      }
    }

    // No cache available - check if already populating
    if (this.backgroundRefreshState.isRefreshing) {
      // Cache is being populated, inform caller to retry
      const elapsed = Math.floor((now - this.backgroundRefreshState.lastRefreshAttempt) / 1000);
      throw new Error(
        `User cache is being populated. Started ${elapsed}s ago. Please try again in a few moments.`
      );
    }

    // Start background population if not already in progress
    logger.info('No cache available, starting background population');
    this.triggerBackgroundRefresh();
    
    // Throw error to inform caller to retry
    throw new Error(
      'User cache is being populated. Please try again in a few moments.'
    );
  }

  /**
   * Trigger background refresh of user list cache
   * Uses stale-while-revalidate pattern to avoid blocking operations
   */
  private triggerBackgroundRefresh(): void {
    const now = Date.now();
    const minRefreshInterval = 60000; // Don't refresh more than once per minute

    // Check if already refreshing or recently attempted
    if (this.backgroundRefreshState.isRefreshing) {
      logger.debug('Background refresh already in progress, skipping');
      return;
    }

    if (now - this.backgroundRefreshState.lastRefreshAttempt < minRefreshInterval) {
      logger.debug('Background refresh attempted recently, skipping');
      return;
    }

    // Mark as refreshing and update last attempt time
    this.backgroundRefreshState.isRefreshing = true;
    this.backgroundRefreshState.lastRefreshAttempt = now;

    // Fetch in background without awaiting
    this.fetchAndCacheUserList()
      .then(() => {
        logger.info('Background user cache refresh completed successfully');
      })
      .catch((error) => {
        logger.warn('Background user cache refresh failed', error);
      })
      .finally(() => {
        this.backgroundRefreshState.isRefreshing = false;
      });
  }

  /**
   * Look up user ID by username or display name
   */
  async lookupUserByName(username: string): Promise<string | null> {
    try {
      // Remove @ prefix if present
      const cleanUsername = username.replace(/^@/, '');
      
      logger.info('Looking up user by name', { username: cleanUsername });

      // Get user list from cache
      const cache = await this.getUserList();

      // Search for user by name, display_name, or real_name
      const user = cache.users.find((u) => {
        const name = u.name.toLowerCase();
        const displayName = u.display_name.toLowerCase();
        const realName = u.real_name.toLowerCase();
        const searchTerm = cleanUsername.toLowerCase();
        
        return name === searchTerm ||
               displayName === searchTerm ||
               realName === searchTerm;
      });

      if (user) {
        logger.info('Found user', { userId: user.id, name: user.name });
        return user.id;
      }

      logger.warn('User not found', { username: cleanUsername });
      return null;
    } catch (error) {
      logger.error('Failed to lookup user by name', error);
      throw handleSlackError(error, 'lookup_user');
    }
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
  async populateUserCache(messages: SlackMessage[]): Promise<void> {
    const userIds = new Set<string>();
    
    for (const message of messages) {
      if (message.user && !this.userCache.has(message.user)) {
        userIds.add(message.user);
      }
    }

    // Fetch user info in parallel for all uncached users
    const promises = Array.from(userIds).map((userId) =>
      this.resolveUsername(userId).catch(() => {
        // Ignore errors, we'll just use user IDs
        logger.debug(`Failed to fetch user info for ${userId}`);
      })
    );

    await Promise.all(promises);
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
    try {
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

      const response = await this.client.get<SlackSearchMessagesResponse>(
        '/search.messages',
        {
          params: {
            token: this.apiToken!,
            query: trimmedQuery,
            count: params.count || 20,
            page: params.page || 1,
            sort: params.sort || 'score',
            sort_dir: params.sort_dir || 'desc',
            highlight: params.highlight !== false,
          },
          headers: {
            Cookie: `d=${this.cookieD}`,
          },
        }
      );

      if (!response.data.ok) {
        throw new Error(response.data.error || 'Failed to search messages');
      }

      logger.info(`Found ${response.data.messages.matches.length} messages (${response.data.messages.total} total)`);

      return response.data;
    } catch (error) {
      throw handleSlackError(error, 'search_messages');
    }
  }
}