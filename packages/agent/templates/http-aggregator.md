# HTTP Aggregator Node

## Purpose
Combines multiple HTTP responses into a single output. Useful for making parallel API calls and merging results.

## Available APIs
- `fetch(url, options)` - standard fetch API
- `workflow.getVariable(name)` - access workflow variables
- `node.log(message)` - emit logs

## Input Contract
Expects an array of URLs or request configs from upstream:
```json
{
  "urls": ["https://api.example.com/users", "https://api.example.com/orders"]
}
```

Or with full request configs:
```json
{
  "requests": [
    { "url": "https://api.example.com/users", "method": "GET", "headers": { "Authorization": "Bearer xxx" } },
    { "url": "https://api.example.com/orders", "method": "GET" }
  ]
}
```

## Output Contract
Returns aggregated/transformed data for downstream:
```json
{
  "data": [...],
  "successful": 2,
  "failed": 0
}
```

## Examples

### Basic parallel fetch
```javascript
async function execute(input) {
  const responses = await Promise.all(
    input.urls.map(url => fetch(url).then(r => r.json()))
  );
  return { data: responses };
}
```

### With error handling
```javascript
async function execute(input) {
  const results = await Promise.allSettled(
    input.urls.map(url => fetch(url).then(r => r.json()))
  );
  return {
    successful: results.filter(r => r.status === 'fulfilled').map(r => r.value),
    failed: results.filter(r => r.status === 'rejected').map(r => r.reason.message)
  };
}
```

### With request configs
```javascript
async function execute(input) {
  const requests = input.requests || input.urls.map(url => ({ url, method: 'GET' }));

  const results = await Promise.allSettled(
    requests.map(async (req) => {
      const response = await fetch(req.url, {
        method: req.method || 'GET',
        headers: req.headers || {}
      });
      return response.json();
    })
  );

  return {
    data: results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value),
    errors: results
      .filter(r => r.status === 'rejected')
      .map(r => r.reason.message),
    successful: results.filter(r => r.status === 'fulfilled').length,
    failed: results.filter(r => r.status === 'rejected').length
  };
}
```

## Constraints
- Timeout: 30s max
- Max concurrent requests: 10
- Each individual request has its own timeout
