/**
 * Type definitions for Slack MCP Server
 */

// ============================================================================
// Slack API Response Types
// ============================================================================

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  response_metadata?: {
    next_cursor?: string;
    warnings?: string[];
  };
}

export interface SlackAuthTestResponse extends SlackApiResponse {
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
}

// ============================================================================
// Message Types
// ============================================================================

export interface SlackMessage {
  type: string;
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reply_users_count?: number;
  latest_reply?: string;
  reactions?: SlackReaction[];
  edited?: {
    user: string;
    ts: string;
  };
  bot_id?: string;
  app_id?: string;
  attachments?: unknown[];
  blocks?: unknown[];
}

export interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

export interface SlackMessageResponse extends SlackApiResponse {
  channel: string;
  ts: string;
  message: SlackMessage;
}

export interface SlackScheduledMessageResponse extends SlackApiResponse {
  channel: string;
  scheduled_message_id: string;
  post_at: number;
  message: {
    text: string;
    bot_id: string;
  };
}

export interface SlackReminder {
  id: string;
  creator: string;
  user: string;
  text: string;
  recurring: boolean;
  time: number;
  complete_ts: number;
}

export interface SlackRemindersListResponse extends SlackApiResponse {
  reminders: SlackReminder[];
}

export interface SlackReminderResponse extends SlackApiResponse {
  reminder: SlackReminder;
}

// ============================================================================
// Conversation Types
// ============================================================================

export interface SlackConversation {
  id: string;
  name?: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
  created: number;
  is_archived: boolean;
  is_general: boolean;
  is_member: boolean;
  num_members?: number;
}

export interface SlackConversationsHistoryResponse extends SlackApiResponse {
  messages: SlackMessage[];
  has_more: boolean;
  pin_count?: number;
  response_metadata?: {
    next_cursor: string;
  };
}

export interface SlackConversationsRepliesResponse extends SlackApiResponse {
  messages: SlackMessage[];
  has_more: boolean;
  response_metadata?: {
    next_cursor: string;
  };
}

export interface SlackConversationsListResponse extends SlackApiResponse {
  channels: SlackConversation[];
  response_metadata?: {
    next_cursor: string;
  };
}

export interface SlackConversationsOpenResponse extends SlackApiResponse {
  channel: {
    id: string;
  };
}

// ============================================================================
// Search Types
// ============================================================================

export interface SlackSearchMessage {
  type: string;
  user?: string;
  username?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  permalink: string;
  channel: {
    id: string;
    name: string;
  };
  team?: string;
  iid?: string;
  reactions?: SlackReaction[];
}

export interface SlackSearchMessagesResponse extends SlackApiResponse {
  query: string;
  messages: {
    total: number;
    pagination: {
      total_count: number;
      page: number;
      per_page: number;
      page_count: number;
      first: number;
      last: number;
    };
    paging?: {
      count: number;
      total: number;
      page: number;
      pages: number;
    };
    matches: SlackSearchMessage[];
  };
}

// ============================================================================
// User Types
// ============================================================================

export interface SlackUser {
  id: string;
  team_id: string;
  name: string;
  deleted: boolean;
  real_name: string;
  profile: {
    display_name: string;
    real_name: string;
    email?: string;
    image_24?: string;
    image_32?: string;
    image_48?: string;
  };
  is_bot: boolean;
  is_app_user: boolean;
}

export interface SlackUsersListResponse extends SlackApiResponse {
  members: SlackUser[];
  cache_ts: number;
  response_metadata?: {
    next_cursor: string;
  };
}

export interface SlackUsersInfoResponse extends SlackApiResponse {
  user: SlackUser;
}

// ============================================================================
// Reaction Types
// ============================================================================

export interface SlackReactionsAddResponse extends SlackApiResponse {
  // Successfully added reaction returns basic response
}

// ============================================================================
// Tool Input Types
// ============================================================================

export interface SendMessageInput {
  channel: string;
  text: string;
  thread_ts?: string;
  unfurl_links?: boolean;
}

export interface SendDirectMessageInput {
  user: string;
  text: string;
  thread_ts?: string;
}

export interface ReplyToThreadInput {
  channel: string;
  thread_ts: string;
  text: string;
  broadcast?: boolean;
}

export interface EditMessageInput {
  channel: string;
  timestamp: string;
  text: string;
}

export interface DeleteMessageInput {
  channel: string;
  timestamp: string;
}

export interface ScheduleMessageInput {
  channel: string;
  text: string;
  post_at: number;
  thread_ts?: string;
}

export interface FetchChannelMessagesInput {
  channel: string;
  limit?: number;
  oldest?: string;
  latest?: string;
}

export interface FetchThreadMessagesInput {
  channel: string;
  thread_ts: string;
  limit?: number;
}

export interface AddReactionInput {
  channel: string;
  timestamp: string;
  reaction: string;
}

export interface CreateReminderInput {
  text: string;
  time: number;
  user?: string;
}

export interface CompleteReminderInput {
  reminder_id: string;
}

export interface DeleteReminderInput {
  reminder_id: string;
}

export interface SearchMessagesInput {
  query: string;
  count?: number;
  page?: number;
  sort?: 'score' | 'timestamp';
  sort_dir?: 'asc' | 'desc';
  highlight?: boolean;
}

// ============================================================================
// Tool Output Types
// ============================================================================

export interface MessageToolOutput {
  success: boolean;
  channel: string;
  ts: string;
  message?: string;
}

export interface ScheduleToolOutput {
  success: boolean;
  channel: string;
  scheduled_message_id: string;
  post_at: number;
  scheduled_time: string;
}

export interface FetchMessagesOutput {
  messages: FormattedMessage[];
  message_count: number;
}

export interface FormattedMessage {
  user: string; // User name (not ID)
  text: string;
  ts: string;
  timestamp: string; // ISO 8601 format
  thread_ts?: string;
  reply_count?: number;
  reactions?: SlackReaction[];
  is_bot: boolean;
}

export interface ReactionToolOutput {
  success: boolean;
  message: string;
}

export interface ReminderToolOutput {
  success: boolean;
  reminder_id?: string;
  message: string;
}

export interface RemindersListOutput {
  reminders: FormattedReminder[];
  reminder_count: number;
}

export interface FormattedReminder {
  id: string;
  text: string;
  time: string; // ISO 8601 formatted (not raw number)
  user: string; // User name (not ID)
  status: 'pending' | 'recurring' | 'completed';
}

export interface SearchMessagesOutput {
  messages: FormattedSearchMessage[];
  message_count: number;
  total_count: number;
  page: number;
  page_count: number;
}

export interface FormattedSearchMessage {
  user: string; // User name (not ID)
  text: string;
  ts: string;
  timestamp: string; // ISO 8601 format
  channel: string; // Channel name (or ID if name unavailable)
  permalink: string;
  thread_ts?: string;
  reactions?: SlackReaction[];
}

// ============================================================================
// Client Configuration Types
// ============================================================================

export interface SlackClientConfig {
  cookieD: string;
  workspaceUrl?: string;
  userAgent?: string;
  logLevel?: LogLevel;
  userCacheFile?: string;
  userCacheTTL?: number; // in seconds
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ============================================================================
// Error Types
// ============================================================================

export interface SlackErrorResponse {
  ok: false;
  error: string;
  detail?: string;
}

export class SlackError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'SlackError';
  }
}

export class AuthenticationError extends SlackError {
  constructor(message: string, details?: unknown) {
    super(message, 'AUTH_ERROR', 401, details);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends SlackError {
  constructor(
    message: string,
    public retryAfter: number,
    details?: unknown
  ) {
    super(message, 'RATE_LIMIT', 429, details);
    this.name = 'RateLimitError';
  }
}

export class NotFoundError extends SlackError {
  constructor(message: string, details?: unknown) {
    super(message, 'NOT_FOUND', 404, details);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends SlackError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}

export class PermissionError extends SlackError {
  constructor(message: string, details?: unknown) {
    super(message, 'PERMISSION_ERROR', 403, details);
    this.name = 'PermissionError';
  }
}