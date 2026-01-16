# GitHub API

Manage repositories, issues, pull requests, and workflows on GitHub.

## Base URL

https://api.github.com

## Authentication

- Type: Bearer Token
- Location: Header
- Name: Authorization
- Format: Bearer {token}

Generate a Personal Access Token at https://github.com/settings/tokens

## Endpoints

### Create an Issue

Create a new issue in a repository.

**POST** `/repos/{owner}/{repo}/issues`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | Yes | Issue title |
| body | string | No | Issue body (Markdown supported) |
| labels | array | No | Array of label names |
| assignees | array | No | Array of usernames to assign |
| milestone | integer | No | Milestone number |

```javascript
async function execute(input) {
  const token = workflow.getSecret('GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      labels: input.labels || [],
    }),
  });
  return response.json();
}
```

### List Issues

List repository issues.

**GET** `/repos/{owner}/{repo}/issues`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| state | string | No | open, closed, or all (default: open) |
| labels | string | No | Comma-separated label names |
| sort | string | No | created, updated, comments (default: created) |
| direction | string | No | asc or desc (default: desc) |
| per_page | integer | No | Results per page (max: 100) |

```javascript
async function execute(input) {
  const token = workflow.getSecret('GITHUB_TOKEN');
  const params = new URLSearchParams({
    state: input.state || 'open',
    per_page: '30',
  });

  const response = await fetch(
    `https://api.github.com/repos/${input.owner}/${input.repo}/issues?${params}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
      },
    }
  );
  return response.json();
}
```

### Create a Comment

Add a comment to an issue or pull request.

**POST** `/repos/{owner}/{repo}/issues/{issue_number}/comments`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| body | string | Yes | Comment body (Markdown supported) |

```javascript
async function execute(input) {
  const token = workflow.getSecret('GITHUB_TOKEN');
  const response = await fetch(
    `https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: input.comment }),
    }
  );
  return response.json();
}
```

### Create a Pull Request

Create a new pull request.

**POST** `/repos/{owner}/{repo}/pulls`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | Yes | PR title |
| head | string | Yes | Branch with changes (e.g., "feature-branch") |
| base | string | Yes | Branch to merge into (e.g., "main") |
| body | string | No | PR description |
| draft | boolean | No | Create as draft PR |

```javascript
async function execute(input) {
  const token = workflow.getSecret('GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/pulls`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    }),
  });
  return response.json();
}
```

### Trigger a Workflow

Trigger a GitHub Actions workflow.

**POST** `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| ref | string | Yes | Branch or tag to run workflow on |
| inputs | object | No | Workflow input parameters |

```javascript
async function execute(input) {
  const token = workflow.getSecret('GITHUB_TOKEN');
  const response = await fetch(
    `https://api.github.com/repos/${input.owner}/${input.repo}/actions/workflows/${input.workflowId}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: input.ref || 'main',
        inputs: input.inputs || {},
      }),
    }
  );

  // Returns 204 No Content on success
  return { success: response.status === 204 };
}
```

### Get Repository

Get repository information.

**GET** `/repos/{owner}/{repo}`

```javascript
async function execute(input) {
  const token = workflow.getSecret('GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
    },
  });
  return response.json();
}
```

## Rate Limits

- Authenticated requests: 5,000 per hour
- Search API: 30 requests per minute
- GitHub Actions API: 1,000 requests per hour

Check `X-RateLimit-Remaining` header.

## Error Codes

| Code | Description |
|------|-------------|
| 401 | Bad credentials - invalid token |
| 403 | Forbidden - rate limited or no permission |
| 404 | Not Found - resource doesn't exist |
| 422 | Validation failed - invalid parameters |

## Examples

### Create issue from webhook data

```javascript
async function execute(input) {
  const token = workflow.getSecret('GITHUB_TOKEN');

  // Create issue with formatted body
  const body = `
## Bug Report

**Source:** ${input.source}
**Severity:** ${input.severity}

### Description
${input.description}

### Steps to Reproduce
${input.steps || 'N/A'}

---
*Created automatically by workflow*
  `.trim();

  const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `[${input.severity}] ${input.title}`,
      body,
      labels: ['bug', input.severity],
    }),
  });
  return response.json();
}
```
