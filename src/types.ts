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

export interface SlackFile {
  id: string;
  created?: number;
  timestamp?: number;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  pretty_type?: string;
  user?: string;
  size?: number;
  mode?: string;
  is_external?: boolean;
  external_type?: string;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  original_w?: number;
  original_h?: number;
  alt_txt?: string;
  file_access?: string;
}

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
  files?: SlackFile[];
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

export interface SlackFilesInfoResponse extends SlackApiResponse {
  file?: SlackFile;
  comments?: unknown[];
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

// ============================================================================
// Conversation Types
// ============================================================================

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

export interface SlackThreadPage {
  parentMessage: SlackMessage | null;
  /** Replies only; the parent never contributes to the page size. */
  messages: SlackMessage[];
  hasMore: boolean;
  nextCursor: string | null;
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
  files?: SlackFile[];
}

export interface SlackSearchMessagesResponse extends SlackApiResponse {
  query: string;
  messages: {
    total: number;
    pagination?: {
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

// Successfully adding a reaction returns only the basic Slack API response.
export type SlackReactionsAddResponse = SlackApiResponse;

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
  cursor?: string;
}

export interface AddReactionInput {
  channel: string;
  timestamp: string;
  reaction: string;
}

export interface SearchMessagesInput {
  query: string;
  count?: number;
  page?: number;
  sort?: 'score' | 'timestamp';
  sort_dir?: 'asc' | 'desc';
  highlight?: boolean;
}

export interface GetFileInfoInput {
  file: string;
}

export interface DownloadFileInput {
  file: string;
  allow_video?: boolean;
  allow_other?: boolean;
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
  has_more?: boolean;
  next_cursor?: string;
}

export interface FetchThreadMessagesOutput {
  thread_ts: string;
  /** Context returned on every page, or null when Slack omitted the parent. */
  parent_message: FormattedMessage | null;
  messages: FormattedMessage[];
  /** Number of replies in messages, excluding parent_message. */
  message_count: number;
  has_more: boolean;
  next_cursor: string | null;
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
  files?: FormattedSlackFile[];
}

export type SlackFileCategory = 'image' | 'video' | 'other';

export interface FormattedSlackFile {
  id: string;
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
  size: number | null;
  mode: string;
  category: SlackFileCategory;
  permalink?: string;
  original_w?: number;
  original_h?: number;
  alt_text?: string;
  download_available: boolean;
  download_eligible_by_default: boolean;
}

export interface FileDownloadPolicy {
  max_bytes_exclusive: number;
  max_size: string;
  default_images: boolean;
  default_videos: boolean;
  default_other_files: boolean;
}

export interface FileInfoToolOutput {
  file: FormattedSlackFile;
  download_policy: FileDownloadPolicy;
}

export interface FileDownloadResult {
  path: string;
  bytes: number;
  sha256: string;
  content_type: string;
  redirect_count: number;
  final_host: string;
}

export interface DownloadFileToolOutput {
  downloaded: boolean;
  status: 'downloaded' | 'skipped';
  file: FormattedSlackFile;
  policy: FileDownloadPolicy;
  reason?: string;
  path?: string;
  bytes?: number;
  sha256?: string;
  content_type?: string;
  redirect_count?: number;
  final_host?: string;
}

export interface ReactionToolOutput {
  success: boolean;
  message: string;
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
  files?: FormattedSlackFile[];
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
    public details?: unknown,
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
    details?: unknown,
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

export class CancelledError extends SlackError {
  constructor(message: string = 'Operation cancelled', details?: unknown) {
    super(message, 'CANCELLED', 499, details);
    this.name = 'CancelledError';
  }
}

export class TimeoutError extends SlackError {
  constructor(message: string, details?: unknown) {
    super(message, 'TIMEOUT', 504, details);
    this.name = 'TimeoutError';
  }
}
