# Telegram Bot API

Bot API for sending messages, photos, files, and handling updates on Telegram.

## Base URL

https://api.telegram.org/bot{token}

Replace `{token}` with your bot token from @BotFather.

## Authentication

- Type: Bearer Token (in URL path)
- Location: URL
- Format: https://api.telegram.org/bot{token}/{method}

Get your bot token from https://t.me/BotFather

## Endpoints

### sendMessage

Send a text message to a chat.

**POST** `/sendMessage`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| chat_id | string/integer | Yes | Chat ID or @username |
| text | string | Yes | Message text (1-4096 characters) |
| parse_mode | string | No | HTML, Markdown, or MarkdownV2 |
| reply_markup | object | No | Inline keyboard or custom reply keyboard |
| disable_notification | boolean | No | Send silently |
| reply_to_message_id | integer | No | Reply to specific message |

```javascript
async function execute(input) {
  const token = workflow.getSecret('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: input.chatId,
      text: input.message,
      parse_mode: 'HTML',
    }),
  });
  return response.json();
}
```

### sendPhoto

Send a photo to a chat.

**POST** `/sendPhoto`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| chat_id | string/integer | Yes | Chat ID or @username |
| photo | string | Yes | Photo URL or file_id |
| caption | string | No | Photo caption (0-1024 characters) |
| parse_mode | string | No | Caption parse mode |

```javascript
async function execute(input) {
  const token = workflow.getSecret('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: input.chatId,
      photo: input.photoUrl,
      caption: input.caption,
    }),
  });
  return response.json();
}
```

### sendDocument

Send a document/file to a chat.

**POST** `/sendDocument`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| chat_id | string/integer | Yes | Chat ID or @username |
| document | string | Yes | Document URL or file_id |
| caption | string | No | Document caption |
| filename | string | No | Custom filename |

```javascript
async function execute(input) {
  const token = workflow.getSecret('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: input.chatId,
      document: input.documentUrl,
      caption: input.caption,
    }),
  });
  return response.json();
}
```

### getUpdates

Get new incoming updates (long polling).

**GET** `/getUpdates`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| offset | integer | No | Identifier of first update to return |
| limit | integer | No | Number of updates (1-100, default: 100) |
| timeout | integer | No | Long polling timeout in seconds |
| allowed_updates | array | No | Update types to receive |

```javascript
async function execute(input) {
  const token = workflow.getSecret('TELEGRAM_BOT_TOKEN');
  const params = new URLSearchParams({
    timeout: '30',
    limit: '10',
  });
  if (input.offset) params.set('offset', String(input.offset));

  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?${params}`);
  return response.json();
}
```

### setWebhook

Set a webhook URL for receiving updates.

**POST** `/setWebhook`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| url | string | Yes | HTTPS URL for webhook |
| max_connections | integer | No | Max simultaneous connections (1-100) |
| allowed_updates | array | No | Update types to receive |
| secret_token | string | No | Secret token for verification |

```javascript
async function execute(input) {
  const token = workflow.getSecret('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: input.webhookUrl,
      secret_token: input.secretToken,
    }),
  });
  return response.json();
}
```

### getMe

Get information about the bot.

**GET** `/getMe`

```javascript
async function execute(input) {
  const token = workflow.getSecret('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  return response.json();
}
```

## Rate Limits

- 30 messages per second to different chats
- 1 message per second to the same chat
- 20 messages per minute to the same group

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - invalid parameters |
| 401 | Unauthorized - invalid bot token |
| 403 | Forbidden - bot blocked by user |
| 429 | Too Many Requests - rate limited |
| 409 | Conflict - webhook already set |

## Examples

### Send message with inline keyboard

```javascript
async function execute(input) {
  const token = workflow.getSecret('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: input.chatId,
      text: 'Choose an option:',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Option 1', callback_data: 'opt1' },
            { text: 'Option 2', callback_data: 'opt2' },
          ],
          [
            { text: 'Visit Website', url: 'https://example.com' },
          ],
        ],
      },
    }),
  });
  return response.json();
}
```

### Send formatted message

```javascript
async function execute(input) {
  const token = workflow.getSecret('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: input.chatId,
      text: `<b>Alert</b>\n\n<i>${input.message}</i>\n\n<a href="${input.link}">View Details</a>`,
      parse_mode: 'HTML',
    }),
  });
  return response.json();
}
```
