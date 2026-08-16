# Slack Local MCP

<img alt="MR Approval use-case" src="docs/mr-approval.gif" width="600" />

A Model Context Protocol (MCP) server for Slack automation using cookie-based authentication. No app creation or OAuth setup required—just extract your browser cookie and start automating.

The MCP process starts without reading the Windows registry or contacting Slack. It loads configuration, the Slack client, the workspace token, and `auth.test` only on the first valid tool call. Concurrent first calls share one bounded authentication attempt. The authenticated client is reused until Slack reports that authentication expired, at which point it is replaced and the operation is retried once.

## Why Local?

**Skip the complexity**: Other Slack integrations require creating apps, managing OAuth tokens, and configuring webhooks. Slack Local MCP connects directly using your browser session, perfect for personal productivity and quick automation.

**Real-world use cases**:

- 🔔 **Team notifications**: Send MR approval requests, deployment alerts, or status updates
- 🔎 **Workspace search**: Find users, messages, threads, and attachments
- 📊 **Channel summaries**: Fetch and summarize team discussions with AI
- 🖼️ **Slack images**: Inspect attachments and download eligible images to the OS temp folder
- ⚡ **Quick responses**: React to messages, reply to threads, manage conversations
- 🧹 **Safe live testing**: Restrict writes to an authenticated self-DM and clean up test data

⚠️ **Note**: Uses your Slack web cookie for authentication. Keep it secure and avoid public exposure.

## Quick Start

### 1. Clone and Build

```bash
git clone https://github.com/berialcheng/slack-local-mcp.git
cd slack-local-mcp
npm install
npm run build
```

### 2. Extract Your Slack Cookie

1. Open Slack in your browser (Chrome/Firefox/Edge)
2. Press `F12` (or `Cmd+Option+I` on Mac) to open Developer Tools
3. Go to **Application** → **Cookies** → `https://app.slack.com`
4. Find the cookie named `d` (starts with `xoxd-`)
5. Copy the **URL-encoded** value (contains `%2B`, `%2F`, `%3D` characters)
6. Add it to your MCP settings as `SLACK_COOKIE_D`

**Cookie validity**: Lasts weeks/months but expires if you log out. Extract a fresh one if authentication fails.

### 3. Configure MCP Settings

Add to your MCP client configuration (e.g., Claude Code `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "slack-local": {
      "command": "node",
      "args": ["/absolute/path/to/slack-local-mcp/build/index.js"],
      "env": {
        "SLACK_COOKIE_D": "xoxd-your-cookie-value-here",
        "SLACK_WORKSPACE_URL": "https://your-workspace.slack.com"
      }
    }
  }
}
```

### Windows: Codex and OpenCode

On Windows, an MCP client that was already running may not inherit newly added
user environment variables. The optional Windows launcher marks the user
environment as a fallback but does not read it during MCP startup. On the first
valid tool call, all missing tracked values are loaded with one
`HKCU\Environment` query. Process environment values continue to take priority.

First, set `SLACK_COOKIE_D` and `SLACK_WORKSPACE_URL` as Windows **user**
environment variables, then build the project:

```powershell
npm install
npm run build
```

Configure Codex with the tracked launcher:

```powershell
codex mcp add slack-local -- node C:\absolute\path\to\slack-local-mcp\scripts\start-windows.mjs
```

For OpenCode, add a local MCP entry to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "slack-local": {
      "type": "local",
      "command": ["node", "C:\\absolute\\path\\to\\slack-local-mcp\\scripts\\start-windows.mjs"],
      "enabled": true,
      "timeout": 15000
    }
  }
}
```

You can also start the same launcher manually with `npm run start:windows`.
Windows user environment variables are stored in the current user's registry;
they are not an encrypted secrets vault. Keep the Slack cookie private and
rotate it if it is exposed.

### 4. Start Using

Your AI assistant can now control Slack with natural language:

- "Send a message to #team asking for MR reviews"
- "Fetch the last 50 messages from #product and summarize"
- "Download the image attached to this Slack message"
- "Find my latest deployment discussion and fetch its thread"
- "React with :ty: to the latest message in #team"
- 🏆 "Create an MR for these changes and ask #team for approval!"

## What You Can Do

### 📬 Messaging

- **Send messages**: Post to channels, DMs, or reply to threads
- **Edit/delete**: Modify or remove your messages
- **Schedule messages**: Compatibility-only; requires explicit opt-in and a supported token
- **Reply to threads**: Continue conversations with context

### 📥 Information

- **Fetch channel messages**: Get recent conversations for AI summarization
- **Read threads**: Extract entire thread discussions
- **Search messages**: Find specific messages across all channels using keywords and filters
- **Inspect attachments**: Message and search results include safe file metadata
- **Download files safely**: Save eligible Slack-hosted files under the OS temp folder
- **Smart formatting**: Messages optimized for AI analysis with TOON format (40% fewer tokens)

### 🎯 Reactions

- **Add reactions**: Respond with emoji to any message

## Usage Examples

### Daily Standup Automation

**You:** "Fetch messages from #dev-team since yesterday and summarize key updates"  
**AI:**

> Fetching messages from #dev-team...  
> 📊 Found 47 messages from the last 24 hours
>
> Analyzing discussions...  
> ✅ **PRs Merged**: 3 features shipped to production<br>
> 🚀 **Deployments**: Backend v2.4.1 deployed successfully<br>
> 🐛 **Bug Fixes**: Resolved 2 critical issues (login timeout, API rate limit)<br>
> 💬 **Active Discussions**: Performance optimization thread (12 replies)

**You:** "Send this summary to #daily-standup"  
**AI:**

> 📤 Posted to #daily-standup:
>
> "**Development Team Updates (Last 24h)**  
> ✅ 3 PRs merged and deployed<br>
> 🚀 Backend v2.4.1 live<br>
> 🐛 2 critical bugs resolved<br>
> 💡 Active: Performance optimization discussion"
>
> ✨ Team notified!

---

### End-to-End MR Workflow (Autonomous Chaining)

**You:** "Commit these changes, create an MR, and send it to #team-devs for approval"
**AI:**

> Step 1: Creating MR...  
> ✅ Created MR #1234: Add user authentication feature https://gitlab.com/project/merge_requests/1234
>
> Step 2: Notifying team...  
> 📤 Sent to #team-devs: "Hi team, mini MR review https://gitlab.com/project/merge_requests/1234"
>
> ✨ MR created and the team has been notified.

**What happened**: One natural language request triggered the AI to autonomously:

1. 🔧 Create and push MR (via GitLab MCP)
2. 📣 Send approval request to team channel
3. 🔍 Fetch the approval thread when prompted
4. 🙏 Thank reviewers with reactions or replies

This demonstrates **true workflow automation**—describe what you want, and let AI handle the details.

## Available Tools

| Tool                     | Purpose                              | Key Parameters                 |
| ------------------------ | ------------------------------------ | ------------------------------ |
| `send_message`           | Post to channels                     | channel, text, thread_ts       |
| `send_direct_message`    | Send DMs or return recipient choices | user, text                     |
| `reply_to_thread`        | Reply to threads                     | channel, thread_ts, text       |
| `edit_message`           | Modify your messages                 | channel, timestamp, text       |
| `delete_message`         | Remove messages                      | channel, timestamp             |
| `fetch_channel_messages` | Get conversation history             | channel ID, limit              |
| `fetch_thread_messages`  | Read thread replies                  | channel, thread_ts             |
| `search_messages`        | Search across workspace              | query, count, page, sort       |
| `get_file_info`          | Get safe file metadata               | file                           |
| `download_file`          | Download an eligible file to OS temp | file, allow_video, allow_other |
| `add_reaction`           | React with emoji                     | channel, timestamp, reaction   |
| `search_users`           | Bounded user-name search             | query, limit, cursor           |

The default registry contains 12 tools, all verified with this project's
browser-session authentication. `schedule_message` is also disabled by default
because the cookie token returned `not_allowed_token_type` in live validation;
set `SLACK_ENABLE_SCHEDULE_MESSAGE=1` directly in the MCP process environment
only when testing a token known to support the method.

The legacy `list_reminders`, `create_reminder`, `complete_reminder`, and
`delete_reminder` tools were removed in August 2026. Slack began retiring the
underlying `reminders.*` Web APIs in March 2023 and documents them as deprecated
and degraded. Live validation also observed `reminders.add` returning an ID that
`reminders.list` could not retrieve. Slack's user-facing reminders remain
available in Slack; this removal applies only to the retired Web API integration.
Use Slack's Later/reminder UI, `/remind`, or a Workflow scheduled trigger instead.
See Slack's [reminder API retirement notice](https://docs.slack.dev/changelog/2023-07-its-later-already-for-stars-and-reminders)
and [current reminder help](https://slack.com/help/articles/208423427-Set-a-reminder).

The guarded live smoke enables `schedule_message` only when
`SLACK_LIVE_TEST_SCHEDULE=1`; a token-type rejection is reported as unsupported
and creates no scheduled message.

### 👤 Recipient Resolution

`send_direct_message` accepts a Slack user ID, an exact `@username`, or a
human-readable name. IDs and exact usernames can be sent immediately. A plain
name such as `Cheng Zhong` is never resolved by silently taking the first match;
the tool returns up to five readable candidates and sends nothing until one is
selected.

Normal name searches inspect at most three `users.list` pages per call. An
incomplete result includes `next_cursor`, which `search_users` can use to
continue without restarting the scan. A cached miss also performs a bounded
live check so newly joined users are not hidden by an older snapshot. Set
`refresh_cache=true` only when an explicit complete cache rebuild is desired;
large workspaces may require many paginated requests.

### 📁 File Metadata and Downloads

`fetch_channel_messages`, `fetch_thread_messages`, and `search_messages` expose
safe attachment metadata such as file ID, MIME type, size, dimensions, and
download eligibility. Private Slack download URLs are never returned to the MCP
client.

Use `get_file_info` with either a file ID or a Slack `/files/...` permalink to
inspect one file. Use `download_file` to save it locally. The download policy is:

- Images are allowed by default only when their declared and downloaded sizes
  are both **strictly below 20 MiB**.
- Videos are skipped by default; set `allow_video=true` for an explicit download.
- Other file types are skipped by default; set `allow_other=true` to opt in.
- The same type policy is reapplied to the final HTTP `Content-Type` before a
  temporary file is opened.
- The 20 MiB hard limit applies even when video or other-file downloads are enabled.
- External/remote files are metadata-only.
- Files are written atomically under the OS temp directory. On Windows this is
  `%TEMP%\slack-local-mcp`.
- Completed MCP-owned downloads expire after seven days; abandoned `.part`
  files expire after one hour. Cleanup runs only when a download is requested.
- Downloads use authenticated HTTPS, at most five Slack-only redirects, response
  type/size checks, and at most three attempts for transient network failures.

The tools never open a browser or request an interactive login. On Windows, the
tracked launcher can read the existing user environment configuration, making
downloads suitable for unattended MCP and scheduled-task use while the Slack
cookie remains valid.

### 🔍 Search Messages

Find specific messages across your entire Slack workspace using keywords and advanced filters.

**Basic search:**

```
"project deadline"
```

**Advanced search with filters:**

```
from:@john urgent              # Messages from a specific user
in:#general meeting notes      # Messages in a specific channel
has:link deployment            # Messages containing links
before:2024-01-15 budget       # Messages before a date
after:2024-01-01 announcement  # Messages after a date
```

**Pagination:**

- Default: 20 results per page
- Maximum: 100 results per page
- Use `page` parameter to navigate results

**Sorting options:**

- `score` (default): Sort by relevance
- `timestamp`: Sort by time (newest/oldest)
- `sort_dir`: `desc` (default) or `asc`

**Example usage:**

```
Search for: "from:@sarah in:#product has:link after:2024-01-01"
Page: 1
Results per page: 20
Sort: timestamp (desc)
```

**Search query modifiers:**

- `from:@username` - Messages from specific user (Note: Use actual username from Slack, not `@me`)
- `in:#channel` - Messages in specific channel
- `has:link` - Messages with links
- `has:file` - Messages with file attachments
- `has:reaction` - Messages with reactions
- `before:YYYY-MM-DD` - Messages before date
- `after:YYYY-MM-DD` - Messages after date

**Note on `from:@me`**: The Slack search API doesn't support `from:@me` syntax. To search for your own messages, you need to use your actual Slack username (e.g., `from:@john.doe`). The authenticated user information is available through the MCP server context - AI agents should use the actual username when constructing search queries for "my messages".

*Requires bot token (not available with cookie auth)

## Configuration Options

### Required

- `SLACK_COOKIE_D`: Your `d` cookie value (URL-encoded, starts with `xoxd-`)
- `SLACK_WORKSPACE_URL`: Your workspace URL (e.g., `https://your-workspace.slack.com`)

### Optional

- `SLACK_RESPONSE_FORMAT`: Response format for array data - `toon` or `json` (default: `toon`)
  - `toon`: TOON format - 40% fewer tokens, optimized for LLMs
  - `json`: Standard JSON format - better for debugging
- `SLACK_USER_AGENT`: Custom User-Agent (default: `Slack-MCP-Client/1.0`)
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error` (default: `info`)
- `SLACK_USER_CACHE_FILE`: User list cache path (default: a workspace-specific file under the OS temp `slack-local-mcp` directory)

Complete user-list caches expire after one hour and are replaced atomically.
Ordinary searches are bounded to three pages and return a continuation cursor;
`refresh_cache=true` is the explicit, potentially expensive full-rebuild path.
A cache miss still checks Slack for newly joined users. Message formatting
resolves at most eight previously unseen users concurrently.

## Performance: TOON Format

**Token efficiency**: This MCP server uses [TOON (Token-Oriented Object Notation)](https://github.com/toon-format/toon) by default for responses containing arrays (messages, users, and search results).

**Benefits:**

- ⚡ **40% fewer tokens** compared to JSON for array data
- 🎯 **Better LLM parsing** (73.9% vs 69.9% accuracy)
- 💰 **Lower costs** for token-based AI services
- 🔄 **Lossless** round-trip conversion to/from JSON

**Example:**

<details>
<summary>JSON format (165 tokens)</summary>

\`\`\`json
{
"messages": [
{
"ts": "1234567890.123456",
"user": "John Doe",
"text": "Hello team!",
"timestamp": "2025-11-12T10:30:00Z",
"reactions": 2
},
{
"ts": "1234567890.234567",
"user": "Jane Smith",
"text": "Great work!",
"timestamp": "2025-11-12T10:31:00Z",
"reactions": 0
}
]
}
\`\`\`
</details>

<details>
<summary>TOON format (98 tokens - 40% reduction)</summary>

\`\`\`
messages[2]{ts,user,text,timestamp,reactions}:
1234567890.123456,John Doe,Hello team!,2025-11-12T10:30:00Z,2
1234567890.234567,Jane Smith,Great work!,2025-11-12T10:31:00Z,0
\`\`\`
</details>

**Switch to JSON:**
\`\`\`json
{
"env": {
"SLACK_RESPONSE_FORMAT": "json"
}
}
\`\`\`

## Troubleshooting

**Authentication Error**: Cookie expired or invalid

- Extract fresh cookie from browser (ensure URL-encoded)
- Verify the workspace URL is an HTTPS `slack.com` host; other origins are rejected before the cookie is attached
- With the Windows launcher registry fallback, retry the tool after updating the user value. Restart the MCP client when the old cookie was supplied directly in its process environment.

**Channel Not Found**: Access or ID issue

- Verify you're a member of the channel
- Use channel ID (starts with `C`) or name (e.g., `general`)

**Rate Limited**: Too many requests

- Wait a few seconds between operations
- HTTP 429 responses are retried once; transient token/file network failures use a bounded retry budget

**Server Not Appearing**: Configuration issue

- Check MCP settings file path and syntax
- Verify `npx` is available: `npx --version`
- Check MCP client logs for startup errors

## Security

✅ **Do:**

- Store cookie in environment variables only
- Rotate cookie regularly (log out and back in)
- Monitor Slack activity for unexpected actions

❌ **Don't:**

- Commit cookie to version control
- Share cookie with others
- Use in production systems (use OAuth-based solutions instead)
- Store cookies in plain text files

## Building from Source

```bash
git clone https://github.com/berialcheng/slack-local-mcp.git
cd slack-local-mcp
npm install
npm run build
```

### Guarded live smoke test

`npm test` is fully local. The optional live smoke goes through the real MCP
stdio transport and refuses Slack writes unless it first proves that the
requested name is the currently authenticated account. Writes are confined to
that account's self-DM; test messages and TEMP downloads are cleaned up.

```powershell
$env:SLACK_LIVE_SELF_NAME = 'Your exact Slack display name'
$env:SLACK_LIVE_ALLOW_WRITES = '1' # omit for read-only checks
$env:SLACK_LIVE_FILE = 'F012ABCDEF' # optional metadata/download check
$env:SLACK_LIVE_TEST_SCHEDULE = '1' # optional; immediately cancelled on success
npm run test:live
```

The script has no default channel or user ID. It exits before writes if the
authenticated user's username, display name, or real name is not an exact
match for `SLACK_LIVE_SELF_NAME`.

Configure with `node` command:

```json
{
  "mcpServers": {
    "slack-local": {
      "command": "node",
      "args": ["/path/to/slack-local-mcp/build/index.js"],
      "env": {
        "SLACK_COOKIE_D": "xoxd-...",
        "SLACK_WORKSPACE_URL": "https://..."
      }
    }
  }
}
```

## Links

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Slack API Documentation](https://api.slack.com/)
- [Cookie Authentication Guide](https://papermtn.co.uk/retrieving-and-using-slack-cookies-for-authentication/)

---

**Happy automating! 🚀**
