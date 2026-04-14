# Slack Local MCP

<img alt="MR Approval use-case" src="docs/mr-approval.gif" width="600" />

<img alt="Reminder use-case" src="docs/reminder.gif" width="600" />

A Model Context Protocol (MCP) server for Slack automation using cookie-based authentication. No app creation or OAuth setup required—just extract your browser cookie and start automating.

## Why Local?

**Skip the complexity**: Other Slack integrations require creating apps, managing OAuth tokens, and configuring webhooks. Slack Local MCP connects directly using your browser session, perfect for personal productivity and quick automation.

**Real-world use cases**:
- 🔔 **Team notifications**: Send MR approval requests, deployment alerts, or status updates
- 📝 **Meeting reminders**: Schedule standup notifications or deadline reminders
- 📊 **Channel summaries**: Fetch and summarize team discussions with AI
- ⚡ **Quick responses**: React to messages, reply to threads, manage conversations
- ✅ **Task tracking**: Create, manage, and complete Slack reminders

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

### 4. Start Using

Your AI assistant can now control Slack with natural language:
- "Send a message to #team asking for MR reviews"
- "Fetch the last 50 messages from #product and summarize"
- "Remind me to check the deployment in 2 hours"
- "React with :ty: to the latest message in #team"
- 🏆 "Create an MR for these changes and ask #team for approval!"

## What You Can Do

### 📬 Messaging
- **Send messages**: Post to channels, DMs, or reply to threads
- **Edit/delete**: Modify or remove your messages
- **Schedule messages**: Post at specific future times (requires bot token)
- **Reply to threads**: Continue conversations with context

### 📥 Information
- **Fetch channel messages**: Get recent conversations for AI summarization
- **Read threads**: Extract entire thread discussions
- **Search messages**: Find specific messages across all channels using keywords and filters
- **Smart formatting**: Messages optimized for AI analysis with TOON format (40% fewer tokens)

### 🎯 Reactions & Reminders
- **Add reactions**: Respond with emoji to any message
- **Create reminders**: Set personal or team reminders
- **Manage reminders**: List, complete, or delete existing reminders

## Usage Examples

### Daily Standup Automation

**You:** "Fetch messages from #dev-team since yesterday and summarize key updates"  
**AI:** 
> Fetching messages from #dev-team...  
📊 Found 47 messages from the last 24 hours
>
> Analyzing discussions...  
✅ **PRs Merged**: 3 features shipped to production  
🚀 **Deployments**: Backend v2.4.1 deployed successfully  
🐛 **Bug Fixes**: Resolved 2 critical issues (login timeout, API rate limit)  
💬 **Active Discussions**: Performance optimization thread (12 replies)

**You:** "Send this summary to #daily-standup"  
**AI:**

> 📤 Posted to #daily-standup:
>
> "**Development Team Updates (Last 24h)**  
✅ 3 PRs merged and deployed  
🚀 Backend v2.4.1 live  
🐛 2 critical bugs resolved  
💡 Active: Performance optimization discussion"
>
> ✨ Team notified!

---

### End-to-End MR Workflow (Autonomous Chaining)

**You:** "Commit these changes, create an MR, send it to #team-devs for approval, and remind me to check back in 1 hour"  
**AI:**
> Step 1: Creating MR...  
✅ Created MR #1234: Add user authentication feature https://gitlab.com/project/merge_requests/1234
>
> Step 2: Notifying team...  
📤 Sent to #team-devs: "Hi team, mini MR review https://gitlab.com/project/merge_requests/1234"
>
> Step 3: Setting reminder...  
⏰ Reminder created for 11:25 AM to check MR #1234 status
>
> ✨ All done! I'll remind you in an hour to check for approvals.

*[1 hour later, reminder notification appears...]*

**You:** "Check the MR status and thank anyone who approved"  
**AI:**
> Checking MR thread...  
✅ Found approval from @sarah with 👍 reaction  
💬 One comment from @john: "Looks good, minor question about error handling"
>
> Adding thank you reaction...  
🙏 Reacted to @sarah's approval
>
> Replying to feedback...  
💬 Posted: "Thanks @sarah! @john good point - I'll address error handling in a follow-up MR"
>
> ✨ MR interaction complete! Ready to merge once pipeline passes.


**What happened**: One natural language request triggered the AI to autonomously:
1. 🔧 Create and push MR (via GitLab MCP)
2. 📣 Send approval request to team channel
3. ⏰ Set timed reminder for follow-up
4. 🔍 Check approval status when prompted
5. 🙏 Thank reviewers automatically
6. 💬 Respond to feedback appropriately

This demonstrates **true workflow automation**—describe what you want, and let AI handle the details.

## Available Tools

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `send_message` | Post to channels | channel, text, thread_ts |
| `send_direct_message` | Send DMs | user, text |
| `reply_to_thread` | Reply to threads | channel, thread_ts, text |
| `edit_message` | Modify your messages | channel, timestamp, text |
| `delete_message` | Remove messages | channel, timestamp |
| `schedule_message` | Schedule posts* | channel, text, post_at |
| `fetch_channel_messages` | Get channel history | channel, limit |
| `fetch_thread_messages` | Read thread replies | channel, thread_ts |
| `search_messages` | Search across workspace | query, count, page, sort |
| `add_reaction` | React with emoji | channel, timestamp, reaction |
| `create_reminder` | Set reminders | text, time, user |
| `list_reminders` | View all reminders | - |
| `complete_reminder` | Mark done | reminder_id |
| `delete_reminder` | Remove reminder | reminder_id |
| `search_users` | Search users by name | query, limit |

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
- `SLACK_USER_CACHE_FILE`: User list cache path (default: `/tmp/slack-mcp-users-cache.json`)

## Performance: TOON Format

**Token efficiency**: This MCP server uses [TOON (Token-Oriented Object Notation)](https://github.com/toon-format/toon) by default for responses containing arrays (messages, users, reminders, search results).

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
- Verify workspace URL matches your Slack domain
- Restart MCP client after updating

**Channel Not Found**: Access or ID issue
- Verify you're a member of the channel
- Use channel ID (starts with `C`) or name (e.g., `general`)

**Rate Limited**: Too many requests
- Wait a few seconds between operations
- Server auto-retries with exponential backoff

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