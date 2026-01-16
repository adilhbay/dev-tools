# Slack API

Send messages, manage channels, and interact with Slack workspaces.

## Base URL

https://slack.com/api

## Authentication

- Type: Bearer Token
- Location: Header
- Name: Authorization
- Format: Bearer {token}

Get your token from https://api.slack.com/apps (Bot User OAuth Token).

## Endpoints

### chat.postMessage

Send a message to a channel or user.

**POST** `/chat.postMessage`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| channel | string | Yes | Channel ID, channel name (#general), or user ID |
| text | string | Yes* | Message text (*or blocks required) |
| blocks | array | No | Block Kit layout blocks |
| thread_ts | string | No | Timestamp of parent message for threading |
| mrkdwn | boolean | No | Enable markdown formatting (default: true) |
| unfurl_links | boolean | No | Unfurl URLs in the message |

```javascript
async function execute(input) {
  const token = workflow.getSecret('SLACK_BOT_TOKEN');
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: input.channel,
      text: input.message,
    }),
  });
  return response.json();
}
```

### conversations.list

List channels in the workspace.

**GET** `/conversations.list`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| types | string | No | Channel types: public_channel, private_channel, mpim, im |
| limit | number | No | Max results per page (default: 100, max: 1000) |
| cursor | string | No | Pagination cursor |
| exclude_archived | boolean | No | Exclude archived channels (default: false) |

```javascript
async function execute(input) {
  const token = workflow.getSecret('SLACK_BOT_TOKEN');
  const params = new URLSearchParams({
    types: 'public_channel,private_channel',
    limit: '100',
  });
  const response = await fetch(`https://slack.com/api/conversations.list?${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return response.json();
}
```

### users.list

List all users in the workspace.

**GET** `/users.list`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| limit | number | No | Max results per page (default: 100) |
| cursor | string | No | Pagination cursor |

```javascript
async function execute(input) {
  const token = workflow.getSecret('SLACK_BOT_TOKEN');
  const response = await fetch('https://slack.com/api/users.list', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return response.json();
}
```

### files.upload

Upload a file to Slack.

**POST** `/files.upload`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| channels | string | Yes | Comma-separated channel IDs |
| content | string | Yes* | File content (*or file binary) |
| filename | string | No | Filename |
| title | string | No | Title of the file |
| initial_comment | string | No | Message to post with the file |

## Rate Limits

- Tier 1 methods: 1 request per second
- Tier 2 methods: 20 requests per minute
- Tier 3 methods: 50 requests per minute

Most common methods (chat.postMessage) are Tier 2.

## Error Codes

| Code | Description |
|------|-------------|
| channel_not_found | Channel does not exist or bot not in channel |
| not_authed | No valid token provided |
| invalid_auth | Invalid token |
| missing_scope | Token missing required scope |
| rate_limited | Too many requests |
| is_archived | Cannot post to archived channel |

## Examples

### Send a formatted message

```javascript
async function execute(input) {
  const token = workflow.getSecret('SLACK_BOT_TOKEN');
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: '#general',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*New Alert*\n${input.message}`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'View Details' },
              url: input.detailsUrl,
            },
          ],
        },
      ],
    }),
  });
  return response.json();
}
```
