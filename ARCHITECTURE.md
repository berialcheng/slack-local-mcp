# Slack MCP Server - Architecture & Design Document

## Overview

A Model Context Protocol (MCP) server that provides tools for interacting with Slack using cookie-based authentication from web sessions. This server enables sending/editing/deleting messages, attempting native scheduling where the token permits it, fetching conversations for summarization, reacting to messages, and downloading policy-approved Slack files to temporary local storage.

## Authentication Strategy

### Phase 1: Cookie-Based Authentication (Current Scope)

- Uses the `d` cookie from Slack web session
- Defers Windows user-environment lookup, Slack client loading, token retrieval, and `auth.test` until the first valid tool call
- Coalesces concurrent first calls into one authentication attempt and reuses the authenticated client per MCP process
- Bounds initialization to 45 seconds, propagates MCP cancellation into Slack requests, and retries once with a new client after an authenticated client reports token expiry
- Validates the initial workspace URL and every token-page redirect as HTTPS on a Slack-owned host before attaching the cookie
- Reference: https://papermtn.co.uk/retrieving-and-using-slack-cookies-for-authentication/
- Requires users to extract cookie from their browser's developer tools
- Single workspace focus

### Phase 2: OAuth/Bot Token Support (Future)

- Support for official Slack OAuth tokens
- Support for Bot tokens
- Multi-workspace capability

## System Architecture

```mermaid
graph TB
    A[MCP Client] -->|MCP Protocol| B[Slack MCP Server]
    B -->|Cookie Auth| C[Slack Web API]
    B -->|Tool Calls| D[Tool Handlers]
    D -->|API Requests| C

    D --> E[Message Tools]
    D -. opt-in .-> F[Scheduling Tools]
    D --> G[Fetch Tools]
    D --> H[Reaction Tools]
    D --> J[Search Tools]
    D --> K[File Tools]

    E --> E1[Send to Channel]
    E --> E2[Send DM]
    E --> E3[Reply to Thread]
    E --> E4[Edit Message]
    E --> E5[Delete Message]

    F --> F1[Schedule Message]

    G --> G1[Fetch Channel Messages]
    G --> G2[Fetch Thread Messages]

    H --> H1[Add Reaction]

    J --> J1[Search Messages]

    K --> K1[Get File Info]
    K --> K2[Download to OS Temp]
```

## Core Components

### 1. Slack Client Module (`src/slack-client.ts`)

**Purpose**: Handle all Slack API interactions with cookie authentication

**Key Features**:

- Cookie-based authentication handler
- HTTP client configuration with proper headers
- Rate limiting and retry logic
- Error handling for API responses

**Methods**:

- `authenticate()`: Validate cookie and get workspace info
- `sendMessage()`: Send messages to channels/DMs
- `updateMessage()`: Edit existing messages
- `deleteMessage()`: Delete messages
- `scheduleMessage()`: Schedule messages using Slack API
- `fetchMessages()`: Retrieve messages from channels/threads
- `addReaction()`: Add emoji reactions to messages
- `searchMessages()`: Search for messages across workspace
- `getFileInfo()`: Retrieve Slack file metadata
- `downloadFile()`: Download a validated Slack-hosted file atomically to OS temp
- `getUserInfo()`: Get user information
- `getChannelInfo()`: Get channel information

### 2. Tool Handlers (`src/tools/`)

#### a. Message Tools (`message-tools.ts`)

- **send_message**: Send messages to channels or DMs
- **reply_to_thread**: Reply to a specific thread
- **send_direct_message**: Send by ID/exact username or return readable candidates for a name
- **edit_message**: Edit previously sent messages
- **delete_message**: Delete previously sent messages

**Input Parameters**:

```typescript
{
  channel?: string;        // Channel ID or name
  user?: string;           // User ID, exact @username, or human-readable name
  text: string;            // Message content
  thread_ts?: string;      // Thread timestamp for replies
  blocks?: Array<Block>;   // Rich formatting (optional)
}
```

#### b. Scheduling Tools (`schedule-tools.ts`)

- **schedule_message**: Schedule a message for future delivery

**Input Parameters**:

```typescript
{
  channel: string;         // Channel ID
  text: string;            // Message content
  post_at: number;         // Unix timestamp
  thread_ts?: string;      // Thread timestamp (optional)
}
```

#### c. Fetch Tools (`fetch-tools.ts`)

- **fetch_channel_messages**: Get recent messages from a channel
- **fetch_thread_messages**: Get one page of messages from a specific thread

**Input Parameters**:

```typescript
{
  channel: string;         // Channel ID
  limit?: number;          // Number of messages (default: 50, max: 200)
  thread_ts?: string;      // Thread timestamp for thread messages
  cursor?: string;         // Opaque continuation cursor for thread messages
  oldest?: string;         // Oldest timestamp to include
  latest?: string;         // Latest timestamp to include
}
```

**Output Format**:

```typescript
{
  messages: Array<{
    user: string;
    text: string;
    ts: string;
    thread_ts?: string;
    reply_count?: number;
    reactions?: Array<{
      name: string;
      count: number;
    }>;
  }>;
  message_count: number;
  has_more?: boolean;
  next_cursor?: string;
}
```

#### d. Reaction Tools (`reaction-tools.ts`)

- **add_reaction**: Add an emoji reaction to a message

**Input Parameters**:

```typescript
{
  channel: string; // Channel ID
  timestamp: string; // Message timestamp
  reaction: string; // Emoji name (without colons)
}
```

#### e. Search Tools (`search-tools.ts`)

- **search_messages**: Search for messages across all channels

**Input Parameters**:

```typescript
{
  query: string;           // Search query with optional modifiers
  count?: number;          // Results per page (1-100, default: 20)
  page?: number;           // Page number (default: 1)
  sort?: 'score' | 'timestamp';  // Sort by relevance or time (default: score)
  sort_dir?: 'asc' | 'desc';     // Sort direction (default: desc)
  highlight?: boolean;     // Enable highlighting (default: true)
}
```

**Search Query Modifiers**:

- `from:@username` - Messages from specific user
- `in:#channel` - Messages in specific channel
- `has:link` - Messages with links
- `has:file` - Messages with file attachments
- `has:reaction` - Messages with reactions
- `before:YYYY-MM-DD` - Messages before date
- `after:YYYY-MM-DD` - Messages after date

**Output Format**:

```typescript
{
  messages: Array<{
    user: string;
    user_name: string;
    text: string;
    ts: string;
    timestamp: string;
    channel_id: string;
    channel_name: string;
    permalink: string;
    thread_ts?: string;
    reactions?: Array<{
      name: string;
      count: number;
    }>;
  }>;
  message_count: number; // Results on current page
  total_count: number; // Total matching messages
  page: number; // Current page number
  page_count: number; // Total pages
}
```

#### f. File Tools (`file-tools.ts`)

- **get_file_info**: Return safe file metadata without private download URLs
- **download_file**: Download eligible Slack-hosted files under the OS temp directory

File downloads use an exclusive 20 MiB limit. Images are enabled by default;
videos and other files require explicit opt-in. External files remain
metadata-only. Redirects are followed manually, limited to five hops, and must
remain HTTPS URLs on Slack-owned hosts. Authentication and file downloads retry
only transient failures, with a maximum of three attempts. Idempotent Slack GET
requests share that bounded retry, while message writes are not retried
automatically. Direct file downloads may also honor HTTP 429 `Retry-After`.
Completed MCP-owned temp downloads are retained for seven days and abandoned
partial files for one hour. Cleanup is lazy, coalesced across concurrent
downloads, and attempted at most once per hour per MCP process.

### 3. Utilities (`src/utils/`)

#### a. Validation (`validation.ts`)

- Channel ID/name validation
- User ID validation
- Timestamp format validation
- Emoji name validation
- Message length validation

#### b. Formatters (`formatters.ts`)

- Convert Slack message objects to readable text
- Format timestamps to human-readable dates
- Handle mentions, channels, and special formatting
- Create markdown-friendly output for AI processing

#### c. Error Handling (`errors.ts`)

- Custom error classes for different scenarios
- Slack API error mapping
- User-friendly error messages
- Debug logging

## Security Considerations

### 1. Cookie Storage

- Store cookie in environment variable (`SLACK_COOKIE_D`)
- Never log or expose the cookie value
- Validate cookie format before use
- Clear instructions for users on secure cookie extraction

### 2. API Rate Limiting

- Implement exponential backoff for rate limits
- Respect Slack's rate limit headers
- Queue requests if necessary
- Log rate limit warnings

### 3. Input Validation

- Sanitize all user inputs
- Validate channel/user IDs format
- Limit message lengths
- Prevent injection attacks

### 4. Error Information

- Don't expose sensitive data in error messages
- Sanitize error responses
- Log detailed errors internally only

## API Endpoints Used

### Web API Endpoints (with cookie auth)

- `POST /api/chat.postMessage` - Send messages
- `POST /api/chat.scheduleMessage` - Schedule messages
- `GET /api/conversations.history` - Fetch channel messages
- `GET /api/conversations.replies` - Fetch thread replies
- `POST /api/reactions.add` - Add reactions
- `POST /api/chat.update` - Edit messages
- `POST /api/chat.delete` - Delete messages
- `GET /api/search.messages` - Search messages
- `GET /api/files.info` - Fetch file metadata and private download location
- `GET /api/users.list` - List users
- `POST /api/auth.test` - Validate authentication

## Configuration

### Environment Variables

```bash
SLACK_COOKIE_D=xoxd-...         # Required: Slack session cookie
SLACK_WORKSPACE_URL=https://workspace.slack.com  # Required
SLACK_RESPONSE_FORMAT=toon       # Optional: toon or json
LOG_LEVEL=info                   # Optional: debug, info, warn, or error
```

### MCP Settings Configuration

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["/path/to/slack-local-mcp/build/index.js"],
      "env": {
        "SLACK_COOKIE_D": "user-slack-d-cookie",
        "SLACK_WORKSPACE_URL": "https://workspace.slack.com"
      }
    }
  }
}
```

## Project Structure

```
slack-local-mcp/
├── package.json
├── tsconfig.json
├── eslint.config.cjs
├── scripts/
│   └── start-windows.mjs        # Lazy Windows environment launcher
├── src/
│   ├── index.ts                 # Main MCP server entry point
│   ├── config.ts                # First-use runtime configuration
│   ├── lazy-slack-client.ts     # Shared lazy initialization
│   ├── slack-client.ts          # Slack API client
│   ├── types.ts                 # TypeScript type definitions
│   ├── tools/                   # Tool definitions and handlers by feature
│   └── utils/                   # Validation, formatting, downloads, errors, logging
├── test/                        # Offline unit and MCP boundary tests
└── build/                       # Compiled JavaScript output
```

## Tool Specifications

### 1. send_message

**Description**: Send a message to a Slack channel or direct message

**Parameters**:

- `channel` (string, required): Channel ID (C...) or channel name
- `text` (string, required): Message content (max 40,000 chars)
- `thread_ts` (string, optional): Thread timestamp to reply to
- `unfurl_links` (boolean, optional): Enable link previews (default: true)

**Returns**: Message timestamp and channel ID

---

### 2. send_direct_message

**Description**: Send a direct message or return recipient candidates without sending

**Parameters**:

- `user` (string, required): User ID, exact `@username`, or human-readable name
- `text` (string, required): Message content
- `thread_ts` (string, optional): Thread timestamp if continuing conversation

**Returns**: Message timestamp and conversation ID, or up to five candidates
with `search_complete` and `next_cursor`. Plain names always require candidate
selection; ordinary resolution scans at most three user-list pages.

---

### 3. reply_to_thread

**Description**: Reply to a specific thread in a channel

**Parameters**:

- `channel` (string, required): Channel ID
- `thread_ts` (string, required): Parent message timestamp
- `text` (string, required): Reply content
- `broadcast` (boolean, optional): Also send to channel (default: false)

**Returns**: Message timestamp

---

### 4. edit_message

**Description**: Edit a previously sent message

**Parameters**:

- `channel` (string, required): Channel ID
- `timestamp` (string, required): Message timestamp to edit
- `text` (string, required): New message content

**Returns**: Updated message timestamp

---

### 5. delete_message

**Description**: Delete a previously sent message

**Parameters**:

- `channel` (string, required): Channel ID
- `timestamp` (string, required): Message timestamp to delete

**Returns**: Success confirmation

---

### 6. schedule_message

**Description**: Schedule a message to be sent at a future time

**Parameters**:

- `channel` (string, required): Channel ID
- `text` (string, required): Message content
- `post_at` (number, required): Unix timestamp for delivery
- `thread_ts` (string, optional): Thread timestamp if replying

**Returns**: Scheduled message ID and post time

---

### 7. fetch_channel_messages

**Description**: Fetch recent messages from a channel for summarization

**Parameters**:

- `channel` (string, required): Slack conversation ID beginning with C, G, or D
- `limit` (number, optional): Number of messages to fetch (default: 50, max: 200)
- `oldest` (string, optional): Oldest timestamp to include
- `latest` (string, optional): Latest timestamp to include

**Returns**: Array of messages with formatted text for AI processing

---

### 8. fetch_thread_messages

**Description**: Fetch one page of messages from a specific thread

**Parameters**:

- `channel` (string, required): Channel ID
- `thread_ts` (string, required): Thread parent timestamp
- `limit` (number, optional): Max messages (default: 100, max: 200)
- `cursor` (string, optional): Opaque cursor returned by the previous page

**Returns**: Thread replies with `has_more` and `next_cursor` when another page remains

---

### 9. add_reaction

**Description**: Add an emoji reaction to a message

**Parameters**:

- `channel` (string, required): Channel ID
- `timestamp` (string, required): Message timestamp
- `reaction` (string, required): Emoji name without colons (e.g., "thumbsup")

**Returns**: Success confirmation

---

### 10. search_messages

**Description**: Search for messages across all channels in the workspace

**Parameters**:

- `query` (string, required): Search query with optional modifiers
  - Supports: `from:@user`, `in:#channel`, `has:link`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`
- `count` (number, optional): Results per page (1-100, default: 20)
- `page` (number, optional): Page number for pagination (default: 1)
- `sort` (enum, optional): Sort by 'score' or 'timestamp' (default: score)
- `sort_dir` (enum, optional): Sort direction 'asc' or 'desc' (default: desc)
- `highlight` (boolean, optional): Enable search term highlighting (default: true)

**Returns**: Array of matching messages with pagination info

**Examples**:

- Basic: `"project deadline"`
- User filter: `"from:@john urgent"`
- Channel filter: `"in:#general meeting notes"`
- Date filter: `"after:2024-01-01 announcement"`
- Combined: `"from:@sarah in:#product has:link after:2024-01-01"`

---

### 11. search_users

**Description**: Search users by username, display name, or real name without
requiring a full workspace scan on every call.

Normal searches inspect at most three pages and return an opaque `next_cursor`
when more users remain. `refresh_cache=true` is the explicit full-scan path. A
cached miss falls through to a bounded live request so new users can be found.

---

## Error Handling Strategy

### Error Types

1. **Authentication Errors**: Invalid or expired cookie
2. **Permission Errors**: Insufficient permissions for action
3. **Not Found Errors**: Channel, user, or message not found
4. **Rate Limit Errors**: API rate limit exceeded
5. **Validation Errors**: Invalid input parameters
6. **Network Errors**: Connection or timeout issues

### Error Response Format

```typescript
{
  content: [{
    type: "text",
    text: "Error: <user-friendly-message>"
  }],
  isError: true
}
```

## Implementation Best Practices

### 1. Type Safety

- Use TypeScript strict mode
- Define interfaces for all API responses
- Use Zod for runtime validation
- No `any` types

### 2. Code Organization

- Single Responsibility Principle
- Separate concerns (API client, tools, utils)
- Modular and testable code
- Clear function naming

### 3. Performance

- Minimize API calls
- Use a one-hour, workspace-specific, asynchronously persisted complete user cache
- Accept positive cache hits during that TTL as a zero-network performance trade-off
- Bound ordinary user searches to three pages and expose continuation cursors
- Continue successful user pages immediately; wait only when bounded HTTP 429 handling requires it
- Treat cached misses as hints and perform a bounded live check for new users
- Reuse usernames embedded in search results before calling `users.info`
- Reuse an already-loaded complete directory without loading it solely for message formatting
- Bound previously unseen user lookups to eight concurrent and 32 total requests per response
- Keep the per-process display-name working set bounded to 1,000 entries
- Use pagination for large datasets
- Async/await for all I/O operations

### 4. Reliability

- Bounded retry for idempotent reads; no automatic retry for message writes
- Keep best-effort `users.info` display-name enrichment single-attempt
- Distinct timeout and caller-cancellation errors
- Graceful degradation
- Comprehensive error logging
- Clear error messages for users

### 5. Maintainability

- Extensive JSDoc comments
- README with setup instructions
- Examples for each tool
- Version control friendly structure

## Testing Strategy

The default suite is offline and deterministic. The opt-in `npm run test:live`
suite uses the MCP stdio boundary, requires an exact authenticated-self name
check before writes, targets only the resulting self-DM, and performs cleanup
from `finally`. It contains no fallback channel or user ID. Scheduled-message
testing is separately opt-in and cancels a successful schedule immediately.

The default MCP registry has 12 live-verified tools. `schedule_message` is
excluded unless `SLACK_ENABLE_SCHEDULE_MESSAGE=1` is present directly in the
server process environment because cookie-token validation returned
`not_allowed_token_type`. The flag is process-only so `listTools` does not need
to read HKCU or contact Slack.

The four tools backed by Slack's legacy `reminders.*` Web APIs were removed in
August 2026 rather than retained behind a compatibility flag. Slack began
retiring those methods in March 2023 and documents them as deprecated and
degraded; live validation also produced an unobservable reminder ID. This does
not remove Slack's user-facing reminder UI or `/remind`. Supported alternatives
are Slack Later/reminders and Workflow scheduled triggers.

### Manual Testing Checklist

1. Cookie authentication validation
2. Send message to channel
3. Send direct message to user
4. Reply to thread
5. Edit message
6. Delete message
7. Schedule message for future
8. Fetch channel messages with different limits
9. Fetch thread messages
10. Add reactions to messages
11. Search messages with various filters
12. Fetch file metadata without exposing private URLs
13. Download an eligible image to OS temp
14. Skip video/other files unless explicitly enabled
15. Reject files at or above 20 MiB
16. Error handling for invalid inputs
17. Rate limit and transient network retry handling
18. Lazy configuration without registry or Slack startup I/O
19. Slack-only workspace/token redirect validation
20. Top-level MCP `isError` propagation and expired-token recovery
21. Cancellation, bounded user lookup concurrency, cache expiry, and temp cleanup

### Test Scenarios

- Valid and invalid channel IDs
- Valid and invalid user IDs
- Empty messages
- Very long messages
- Special characters in messages
- Invalid timestamps
- Expired/invalid cookies
- Network failures

## Future Enhancements

### Phase 2 Features

- OAuth 2.0 token support
- Bot token support
- Multi-workspace management
- File upload capability
- User presence information
- Channel creation/management
- Pin/bookmark management

### Phase 3 Features

- Slack Events API integration
- Real-time message monitoring
- Custom emoji support
- Slash command integration
- Interactive components (buttons, modals)
- Workflow automation

## Dependencies

### Core Dependencies

- `@modelcontextprotocol/sdk`: MCP SDK for server implementation
- `axios`: HTTP client for Slack API calls
- `zod`: Runtime type validation
- `typescript`: Type safety

### Development Dependencies

- `@typescript-eslint/parser`: TypeScript linting
- `@typescript-eslint/eslint-plugin`: ESLint rules
- `eslint`: Code linting
- `prettier`: Code formatting
- `@types/node`: Node.js type definitions

## Documentation Deliverables

### 1. README.md

- Quick start guide
- How to extract Slack cookie
- Configuration instructions
- Tool usage examples
- Troubleshooting guide

### 2. ARCHITECTURE.md (this document)

- System design
- Component descriptions
- API specifications
- Security considerations

## Success Criteria

1. ✅ Successfully authenticate using Slack cookie
2. ✅ Send messages to channels and DMs
3. ✅ Reply to threads
4. ✅ Edit and delete messages
5. ✅ Report native scheduling support or token-type rejection accurately
6. ✅ Fetch and format messages for AI summarization
7. ✅ Add emoji reactions to messages
8. ✅ Remove integrations backed by retired Slack reminder APIs
9. ✅ Inspect message attachments and download policy-approved Slack files
10. ✅ Comprehensive error handling
11. ✅ Security best practices implemented
12. ✅ Clear documentation for users
13. ✅ Working MCP server integration
