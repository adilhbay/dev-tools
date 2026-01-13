# HTTP Aggregator Node

## Purpose

Combines multiple HTTP responses into a single output. Use this pattern when you need to:
- Fetch data from multiple API endpoints in parallel
- Aggregate results from paginated APIs
- Combine data from different sources

## Available APIs

- `fetch(url, options)` - Standard Fetch API for HTTP requests
- `workflow.getVariable(name)` - Access workflow variables
- `workflow.getSecret(name)` - Access secrets (resolved at runtime)
- `node.log(message)` - Emit logs visible in execution history

## Input Contract

Expects one of:
- An array of URLs: `{ urls: string[] }`
- An array of request configs: `{ requests: { url: string, options?: RequestInit }[] }`
- A base URL with IDs: `{ baseUrl: string, ids: string[] }`

## Output Contract

Returns aggregated data:
```typescript
{
  data: any[];           // Array of successful responses
  errors?: string[];     // Optional: any error messages
  count: number;         // Total number of results
}
```

## Examples

### Basic Parallel Fetch

Fetch multiple URLs and return all results.

```javascript
async function execute(input) {
  const responses = await Promise.all(
    input.urls.map(url => fetch(url).then(r => r.json()))
  );

  return {
    data: responses,
    count: responses.length
  };
}
```

### With Error Handling

Handle partial failures gracefully.

```javascript
async function execute(input) {
  const results = await Promise.allSettled(
    input.urls.map(url => fetch(url).then(r => r.json()))
  );

  const successful = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  const failed = results
    .filter(r => r.status === 'rejected')
    .map(r => r.reason.message);

  if (failed.length > 0) {
    node.log(`Warning: ${failed.length} requests failed`);
  }

  return {
    data: successful,
    errors: failed.length > 0 ? failed : undefined,
    count: successful.length
  };
}
```

### With Pagination

Fetch paginated API responses.

```javascript
async function execute(input) {
  const { baseUrl, totalPages } = input;
  const allData = [];

  for (let page = 1; page <= totalPages; page++) {
    const response = await fetch(`${baseUrl}?page=${page}`);
    const data = await response.json();
    allData.push(...data.items);

    node.log(`Fetched page ${page}/${totalPages}`);
  }

  return {
    data: allData,
    count: allData.length
  };
}
```

### With Rate Limiting

Respect API rate limits by adding delays.

```javascript
async function execute(input) {
  const { urls, delayMs = 100 } = input;
  const results = [];

  for (const url of urls) {
    const response = await fetch(url);
    const data = await response.json();
    results.push(data);

    // Rate limit: wait between requests
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  return {
    data: results,
    count: results.length
  };
}
```

### With Authentication

Include auth headers from workflow secrets.

```javascript
async function execute(input) {
  const apiKey = workflow.getSecret('API_KEY');

  const responses = await Promise.all(
    input.urls.map(url =>
      fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }).then(r => r.json())
    )
  );

  return {
    data: responses,
    count: responses.length
  };
}
```

## Constraints

- **Timeout**: 30s max per node execution
- **Max concurrent requests**: 10 (consider batching for larger sets)
- **Memory**: Large responses may consume significant memory
- **Rate limits**: Respect API rate limits; use delays if needed
