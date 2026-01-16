# SendGrid API

Email delivery service for sending transactional and marketing emails.

## Base URL

https://api.sendgrid.com/v3

## Authentication

- Type: Bearer Token
- Location: Header
- Name: Authorization
- Format: Bearer {api_key}

Create an API key at https://app.sendgrid.com/settings/api_keys

## Endpoints

### Send Email

Send a single email or batch of emails.

**POST** `/mail/send`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| personalizations | array | Yes | Array of recipients and personalization data |
| from | object | Yes | Sender email { email, name } |
| subject | string | Yes | Email subject line |
| content | array | Yes | Email content [{ type, value }] |
| template_id | string | No | Dynamic template ID |
| dynamic_template_data | object | No | Template variables |
| attachments | array | No | File attachments |

```javascript
async function execute(input) {
  const apiKey = workflow.getSecret('SENDGRID_API_KEY');
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: input.to, name: input.toName }],
        },
      ],
      from: { email: input.from, name: input.fromName },
      subject: input.subject,
      content: [
        { type: 'text/plain', value: input.textBody },
        { type: 'text/html', value: input.htmlBody },
      ],
    }),
  });

  // Returns 202 Accepted on success (no body)
  return {
    success: response.status === 202,
    status: response.status,
  };
}
```

### Send with Template

Send email using a dynamic template.

**POST** `/mail/send`

```javascript
async function execute(input) {
  const apiKey = workflow.getSecret('SENDGRID_API_KEY');
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: input.to }],
          dynamic_template_data: {
            name: input.recipientName,
            orderNumber: input.orderNumber,
            items: input.items,
            total: input.total,
          },
        },
      ],
      from: { email: input.from, name: input.fromName },
      template_id: input.templateId,
    }),
  });

  return { success: response.status === 202 };
}
```

### List Templates

Get all dynamic templates.

**GET** `/templates`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| generations | string | No | legacy or dynamic (default: legacy) |
| page_size | integer | No | Number of templates per page |

```javascript
async function execute(input) {
  const apiKey = workflow.getSecret('SENDGRID_API_KEY');
  const params = new URLSearchParams({
    generations: 'dynamic',
    page_size: '100',
  });

  const response = await fetch(`https://api.sendgrid.com/v3/templates?${params}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  return response.json();
}
```

### Get Email Statistics

Get email activity statistics.

**GET** `/stats`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| start_date | string | Yes | Start date (YYYY-MM-DD) |
| end_date | string | No | End date (YYYY-MM-DD) |
| aggregated_by | string | No | day, week, or month |

```javascript
async function execute(input) {
  const apiKey = workflow.getSecret('SENDGRID_API_KEY');
  const params = new URLSearchParams({
    start_date: input.startDate,
    end_date: input.endDate || input.startDate,
  });

  const response = await fetch(`https://api.sendgrid.com/v3/stats?${params}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  return response.json();
}
```

### Add Contact

Add a contact to your marketing list.

**PUT** `/marketing/contacts`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| list_ids | array | No | Marketing list IDs to add contact to |
| contacts | array | Yes | Array of contact objects |

```javascript
async function execute(input) {
  const apiKey = workflow.getSecret('SENDGRID_API_KEY');
  const response = await fetch('https://api.sendgrid.com/v3/marketing/contacts', {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      list_ids: input.listIds || [],
      contacts: [
        {
          email: input.email,
          first_name: input.firstName,
          last_name: input.lastName,
          custom_fields: input.customFields || {},
        },
      ],
    }),
  });
  return response.json();
}
```

## Rate Limits

- Free tier: 100 emails/day
- Essentials: 40,000 emails/month
- API rate: varies by plan

Check `X-RateLimit-Remaining` header.

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - invalid parameters |
| 401 | Unauthorized - invalid API key |
| 403 | Forbidden - no permission |
| 413 | Payload too large (max 30MB) |
| 429 | Too many requests - rate limited |

## Examples

### Send welcome email

```javascript
async function execute(input) {
  const apiKey = workflow.getSecret('SENDGRID_API_KEY');

  const htmlContent = `
    <h1>Welcome, ${input.name}!</h1>
    <p>Thanks for signing up. Here's what you can do next:</p>
    <ul>
      <li><a href="${input.dashboardUrl}">Visit your dashboard</a></li>
      <li><a href="${input.docsUrl}">Read the docs</a></li>
    </ul>
    <p>If you have questions, just reply to this email.</p>
  `;

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: input.email, name: input.name }] }],
      from: { email: 'welcome@example.com', name: 'Example Team' },
      subject: `Welcome to Example, ${input.name}!`,
      content: [{ type: 'text/html', value: htmlContent }],
    }),
  });

  return { success: response.status === 202 };
}
```

### Send batch emails

```javascript
async function execute(input) {
  const apiKey = workflow.getSecret('SENDGRID_API_KEY');

  // Build personalizations for each recipient
  const personalizations = input.recipients.map(recipient => ({
    to: [{ email: recipient.email, name: recipient.name }],
    dynamic_template_data: {
      name: recipient.name,
      ...recipient.data,
    },
  }));

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations,
      from: { email: input.from, name: input.fromName },
      template_id: input.templateId,
    }),
  });

  return {
    success: response.status === 202,
    recipientCount: personalizations.length,
  };
}
```
