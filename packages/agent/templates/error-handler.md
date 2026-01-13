# Error Handler Node

## Purpose
Handles errors from upstream nodes gracefully. Use in a condition node's ELSE branch to catch and process errors.

## Available APIs
- `fetch(url, options)` - standard fetch API
- `workflow.getVariable(name)` - access workflow variables
- `node.log(message)` - emit logs

## Input Contract
When placed after a failed node, receives the error information:
```json
{
  "error": "Connection timeout",
  "originalInput": { ... },
  "nodeId": "01H..."
}
```

## Output Contract
Should return a standardized error response or recovered data:
```json
{
  "status": "error",
  "message": "User-friendly error message",
  "code": "TIMEOUT_ERROR",
  "recovered": false
}
```

## Examples

### Log and rethrow
```javascript
async function execute(input) {
  node.log(`Error occurred: ${input.error}`);

  return {
    status: 'error',
    message: input.error,
    timestamp: new Date().toISOString()
  };
}
```

### Retry logic (with counter)
```javascript
async function execute(input) {
  const maxRetries = 3;
  const currentRetry = input.retryCount || 0;

  if (currentRetry < maxRetries) {
    node.log(`Retry attempt ${currentRetry + 1} of ${maxRetries}`);
    return {
      ...input.originalInput,
      retryCount: currentRetry + 1,
      shouldRetry: true
    };
  }

  return {
    status: 'error',
    message: `Failed after ${maxRetries} retries: ${input.error}`,
    recovered: false
  };
}
```

### Fallback value
```javascript
async function execute(input) {
  node.log(`Using fallback due to error: ${input.error}`);

  return {
    status: 'fallback',
    data: workflow.getVariable('FALLBACK_DATA') || [],
    originalError: input.error
  };
}
```

## Constraints
- Keep error handling logic simple
- Always log errors for debugging
- Consider whether to fail the workflow or continue with defaults
