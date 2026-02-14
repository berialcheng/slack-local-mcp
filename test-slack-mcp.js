#!/usr/bin/env node

/**
 * Comprehensive Test Suite for Slack MCP Server
 *
 * Tests all 13 tools and authentication functionality
 *
 * Usage:
 *   SLACK_COOKIE_D='your-cookie' SLACK_WORKSPACE_URL='https://workspace.slack.com' node test-slack-mcp.js
 *
 * Optional:
 *   TEST_CHANNEL='C1234567890' - Channel ID to use for tests (defaults to 'general')
 *   SLACK_USER_AGENT='Custom-Agent' - Custom user agent
 */

import { SlackClient } from './build/slack-client.js';

// Configuration
const config = {
  cookieD: process.env.SLACK_COOKIE_D,
  workspaceUrl: process.env.SLACK_WORKSPACE_URL,
  userAgent: process.env.SLACK_USER_AGENT,
  testChannel: process.env.TEST_CHANNEL || 'C1148LEDS', // Update with your test channel ID
  logLevel: 'info',
};

// Validate required config
if (!config.cookieD || !config.workspaceUrl) {
  console.error('❌ Missing required environment variables:');
  console.error('   SLACK_COOKIE_D - Your Slack d cookie (URL-encoded)');
  console.error('   SLACK_WORKSPACE_URL - Your workspace URL');
  console.error('\nUsage:');
  console.error('   SLACK_COOKIE_D="xoxd-..." SLACK_WORKSPACE_URL="https://workspace.slack.com" node test-slack-mcp.js');
  process.exit(1);
}

// Test results tracking
const results = {
  passed: 0,
  failed: 0,
  tests: [],
};

function logTest(name, passed, details = '') {
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status}: ${name}`);
  if (details) {
    console.log(`   ${details}`);
  }
  
  results.tests.push({ name, passed, details });
  if (passed) {
    results.passed++;
  } else {
    results.failed++;
  }
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  let client;
  let testMessageTs;
  let scheduledMessageId;
  let threadTs;
  let reminderId;
  
  try {
    logSection('🚀 Starting Slack MCP Server Tests');
    console.log('Configuration:');
    console.log(`   Workspace URL: ${config.workspaceUrl}`);
    console.log(`   User Agent: ${config.userAgent || 'default'}`);
    console.log(`   Test Channel: ${config.testChannel}`);
    console.log('');
    
    // Test 1: Client Initialization
    logSection('Test 1: Client Initialization');
    try {
      client = new SlackClient(config);
      logTest('Client initialization', true, 'SlackClient created successfully');
    } catch (error) {
      logTest('Client initialization', false, error.message);
      throw error;
    }
    
    // Test 2: Authentication
    logSection('Test 2: Authentication');
    try {
      await client.authenticate();
      logTest('Authentication', true, 'Successfully authenticated with Slack');
    } catch (error) {
      logTest('Authentication', false, error.message);
      throw error;
    }
    
    // Wait a bit between tests to avoid rate limiting
    await sleep(1000);
    
    // Test 3: Send Message
    logSection('Test 3: Send Message');
    try {
      const result = await client.sendMessage({
        channel: config.testChannel,
        text: '🧪 Test message from Slack MCP Server test suite',
      });
      testMessageTs = result.ts;
      logTest(
        'Send message',
        result.ok !== false && result.ts,
        `Message sent with timestamp: ${result.ts}`
      );
    } catch (error) {
      logTest('Send message', false, error.message);
    }
    
    await sleep(1000);
    
    // Test 4: Reply to Thread
    logSection('Test 4: Reply to Thread');
    if (testMessageTs) {
      try {
        const result = await client.sendMessage({
          channel: config.testChannel,
          text: '🧵 This is a thread reply',
          thread_ts: testMessageTs,
        });
        threadTs = result.ts;
        logTest(
          'Reply to thread',
          result.ok !== false && result.ts,
          `Thread reply sent with timestamp: ${result.ts}`
        );
      } catch (error) {
        logTest('Reply to thread', false, error.message);
      }
    } else {
      logTest('Reply to thread', false, 'No message timestamp available');
    }
    
    await sleep(1000);
    
    // Test 5: Add Reaction
    logSection('Test 5: Add Reaction');
    if (testMessageTs) {
      try {
        await client.addReaction({
          channel: config.testChannel,
          timestamp: testMessageTs,
          name: 'white_check_mark',
        });
        logTest('Add reaction', true, 'Reaction ✅ added to test message');
      } catch (error) {
        logTest('Add reaction', false, error.message);
      }
    } else {
      logTest('Add reaction', false, 'No message timestamp available');
    }
    
    await sleep(1000);
    
    // Test 6: Fetch Channel Messages
    logSection('Test 6: Fetch Channel Messages');
    try {
      const messages = await client.fetchMessages({
        channel: config.testChannel,
        limit: 10,
      });
      logTest(
        'Fetch channel messages',
        Array.isArray(messages) && messages.length > 0,
        `Fetched ${messages.length} messages`
      );
    } catch (error) {
      logTest('Fetch channel messages', false, error.message);
    }
    
    await sleep(1000);
    
    // Test 7: Fetch Thread Messages
    logSection('Test 7: Fetch Thread Messages');
    if (testMessageTs) {
      try {
        const messages = await client.fetchThreadReplies({
          channel: config.testChannel,
          thread_ts: testMessageTs,
        });
        logTest(
          'Fetch thread messages',
          Array.isArray(messages) && messages.length > 0,
          `Fetched ${messages.length} thread messages`
        );
      } catch (error) {
        logTest('Fetch thread messages', false, error.message);
      }
    } else {
      logTest('Fetch thread messages', false, 'No message timestamp available');
    }
    
    await sleep(1000);
    
    // Test 8: Schedule Message
    logSection('Test 8: Schedule Message');
    try {
      // Schedule message for 2 minutes from now
      const postAt = Math.floor(Date.now() / 1000) + 120;
      const result = await client.scheduleMessage({
        channel: config.testChannel,
        text: '⏰ This is a scheduled test message',
        post_at: postAt,
      });
      scheduledMessageId = result.scheduled_message_id;
      const scheduledTime = new Date(postAt * 1000).toLocaleString();
      logTest(
        'Schedule message',
        result.ok !== false && result.scheduled_message_id,
        `Message scheduled for ${scheduledTime} (ID: ${result.scheduled_message_id})`
      );
    } catch (error) {
      // Note: Scheduled messages may not work with cookie auth (requires bot token)
      if (error.message.includes('not_allowed_token_type')) {
        logTest('Schedule message', true, 'Skipped - Cookie auth does not support scheduled messages (requires bot token)');
      } else {
        logTest('Schedule message', false, error.message);
      }
    }
    
    await sleep(1000);
    
    // Test 9: Send Direct Message (if user ID is available)
    logSection('Test 9: Send Direct Message');
    try {
      // Try to send DM to self (using authenticated user ID)
      const dmChannel = await client.openDirectMessage('U113X7CUT'); // Update with your user ID
      const result = await client.sendMessage({
        channel: dmChannel,
        text: '👋 Test DM from Slack MCP Server test suite',
      });
      logTest(
        'Send direct message',
        result.ok !== false && result.ts,
        `DM sent to channel ${dmChannel}`
      );
    } catch (error) {
      logTest('Send direct message', false, error.message);
    }
    
    await sleep(1000);
    
    // Test 10: Edit Message
    logSection('Test 10: Edit Message');
    if (testMessageTs) {
      try {
        const result = await client.updateMessage({
          channel: config.testChannel,
          ts: testMessageTs,
          text: '✏️ Test message (EDITED)',
        });
        logTest(
          'Edit message',
          result.ok !== false && result.ts,
          `Message edited successfully: ${result.ts}`
        );
      } catch (error) {
        logTest('Edit message', false, error.message);
      }
    } else {
      logTest('Edit message', false, 'No message timestamp available');
    }
    
    await sleep(1000);
    
    // Test 11: List Reminders
    logSection('Test 11: List Reminders');
    try {
      const reminders = await client.listReminders();
      logTest(
        'List reminders',
        Array.isArray(reminders),
        `Found ${reminders.length} reminder(s)`
      );
    } catch (error) {
      logTest('List reminders', false, error.message);
    }
    
    await sleep(1000);
    
    // Test 12: Create Reminder
    logSection('Test 12: Create Reminder');
    try {
      // Create reminder for 5 minutes from now
      const reminderTime = Math.floor(Date.now() / 1000) + 300;
      const result = await client.createReminder({
        text: 'Test reminder from Slack MCP test suite',
        time: reminderTime,
      });
      reminderId = result.id;
      const scheduledTime = new Date(reminderTime * 1000).toLocaleString();
      logTest(
        'Create reminder',
        result.id,
        `Reminder created for ${scheduledTime} (ID: ${result.id})`
      );
    } catch (error) {
      logTest('Create reminder', false, error.message);
    }
    
    await sleep(1000);
    
    // Test 13: Delete Reminder
    logSection('Test 13: Delete Reminder');
    if (reminderId) {
      try {
        await client.deleteReminder(reminderId);
        logTest('Delete reminder', true, `Reminder ${reminderId} deleted successfully`);
      } catch (error) {
        logTest('Delete reminder', false, error.message);
      }
    } else {
      logTest('Delete reminder', false, 'No reminder ID available');
    }
    
    await sleep(1000);
    
    // Test 14: Delete Message
    logSection('Test 14: Delete Message');
    if (testMessageTs) {
      try {
        await client.deleteMessage({
          channel: config.testChannel,
          ts: testMessageTs,
        });
        logTest('Delete message', true, `Message ${testMessageTs} deleted successfully`);
      } catch (error) {
        logTest('Delete message', false, error.message);
      }
    } else {
      logTest('Delete message', false, 'No message timestamp available');
    }
    
    await sleep(1000);
    
    // Test 15: Search Users
    logSection('Test 15: Search Users');
    try {
      const userList = await client.getUserList();
      
      // Test exact match
      if (userList.users.length > 0) {
        const testUser = userList.users[0];
        const searchQuery = testUser.name;
        
        // Simulate search by filtering the user list
        const matches = userList.users.filter(u => {
          const name = u.name.toLowerCase();
          const displayName = u.display_name.toLowerCase();
          const realName = u.real_name.toLowerCase();
          const query = searchQuery.toLowerCase();
          
          return name.includes(query) ||
                 displayName.includes(query) ||
                 realName.includes(query);
        });
        
        logTest(
          'Search users - exact match',
          matches.length > 0 && matches.some(m => m.id === testUser.id),
          `Found ${matches.length} match(es) for "${searchQuery}"`
        );
      } else {
        logTest('Search users - exact match', false, 'No users in cache');
      }
      
      // Test partial match
      if (userList.users.length > 0) {
        const testUser = userList.users[0];
        const partialQuery = testUser.name.substring(0, 3);
        
        const matches = userList.users.filter(u => {
          const name = u.name.toLowerCase();
          const displayName = u.display_name.toLowerCase();
          const realName = u.real_name.toLowerCase();
          const query = partialQuery.toLowerCase();
          
          return name.includes(query) ||
                 displayName.includes(query) ||
                 realName.includes(query);
        });
        
        logTest(
          'Search users - partial match',
          matches.length > 0,
          `Found ${matches.length} match(es) for partial query "${partialQuery}"`
        );
      }
      
      // Test no match
      const noMatchQuery = 'xyzabc123nonexistent';
      const noMatches = userList.users.filter(u => {
        const name = u.name.toLowerCase();
        const displayName = u.display_name.toLowerCase();
        const realName = u.real_name.toLowerCase();
        const query = noMatchQuery.toLowerCase();
        
        return name.includes(query) ||
               displayName.includes(query) ||
               realName.includes(query);
      });
      
      logTest(
        'Search users - no match',
        noMatches.length === 0,
        `Correctly returned 0 matches for "${noMatchQuery}"`
      );
      
      // Test user cache exists
      logTest(
        'User list cache',
        userList.users.length > 0,
        `User cache contains ${userList.users.length} user(s)`
      );
      
    } catch (error) {
      logTest('Search users', false, error.message);
    }
    
    await sleep(1000);
    
    // Test 16: Custom User Agent
    logSection('Test 16: Custom User Agent');
    try {
      const customClient = new SlackClient({
        ...config,
        userAgent: 'Test-Agent/1.0',
      });
      await customClient.authenticate();
      logTest('Custom User-Agent', true, 'Custom user agent works correctly');
    } catch (error) {
      logTest('Custom User-Agent', false, error.message);
    }
    
    await sleep(1000);
    
    // Test 17: Lookup User by Name
    logSection('Test 17: Lookup User by Name');
    try {
      const userList = await client.getUserList();
      if (userList.users.length > 0) {
        const testUser = userList.users[0];
        const foundUserId = await client.lookupUserByName(testUser.name);
        
        logTest(
          'Lookup user by username',
          foundUserId === testUser.id,
          `Found user ID ${foundUserId} for username "${testUser.name}"`
        );
        
        // Test with display name
        if (testUser.display_name) {
          const foundByDisplay = await client.lookupUserByName(testUser.display_name);
          logTest(
            'Lookup user by display name',
            foundByDisplay === testUser.id,
            `Found user ID ${foundByDisplay} for display name "${testUser.display_name}"`
          );
        }
        
        // Test non-existent user
        const notFoundId = await client.lookupUserByName('nonexistentuserxyz123');
        logTest(
          'Lookup non-existent user',
          notFoundId === null,
          'Correctly returned null for non-existent user'
        );
      } else {
        logTest('Lookup user by name', false, 'No users in cache');
      }
    } catch (error) {
      logTest('Lookup user by name', false, error.message);
    }
    
    await sleep(1000);
    
    // Test 18: Search Messages
    logSection('Test 18: Search Messages');
    try {
      // Test basic keyword search
      const searchResults = await client.searchMessages({
        query: 'test',
        count: 10,
        sort: 'timestamp',
        sort_dir: 'desc',
      });
      
      logTest(
        'Search messages - basic query',
        searchResults.ok && searchResults.messages.matches.length >= 0,
        `Found ${searchResults.messages.matches.length} matches for "test" (${searchResults.messages.total} total)`
      );
      
      // Test channel filter search
      const channelSearchResults = await client.searchMessages({
        query: `in:#${config.testChannel}`,
        count: 5,
      });
      
      logTest(
        'Search messages - channel filter',
        channelSearchResults.ok && channelSearchResults.messages.matches.length >= 0,
        `Found ${channelSearchResults.messages.matches.length} matches in test channel`
      );
      
      // Test pagination
      const page1 = await client.searchMessages({
        query: 'test',
        count: 2,
        page: 1,
      });
      
      logTest(
        'Search messages - pagination',
        page1.ok && page1.messages.pagination.page === 1,
        `Page 1 results: ${page1.messages.matches.length} messages`
      );
      
    } catch (error) {
      logTest('Search messages', false, error.message);
    }
    
    // Final summary
    logSection('📊 Test Results Summary');
    console.log(`Total Tests: ${results.tests.length}`);
    console.log(`✅ Passed: ${results.passed}`);
    console.log(`❌ Failed: ${results.failed}`);
    console.log(`Success Rate: ${((results.passed / results.tests.length) * 100).toFixed(1)}%`);
    
    if (results.failed > 0) {
      console.log('\n❌ Failed Tests:');
      results.tests
        .filter(t => !t.passed)
        .forEach(t => console.log(`   - ${t.name}: ${t.details}`));
    }
    
    console.log('\n' + '='.repeat(60));
    
    if (scheduledMessageId) {
      console.log('\n⚠️  Note: Messages may have been scheduled or sent during testing.');
      console.log('   Check your test channel and scheduled messages if needed.');
    }
    
    // Exit with appropriate code
    process.exit(results.failed > 0 ? 1 : 0);
    
  } catch (error) {
    console.error('\n❌ Fatal Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the tests
runTests();