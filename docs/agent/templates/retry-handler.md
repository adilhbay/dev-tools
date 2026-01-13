# Retry Handler Node

## Purpose

Implement retry logic for unreliable operations. Use this pattern when you need to:
- Retry failed API calls with exponential backoff
- Handle transient errors gracefully
- Implement circuit breaker patterns
- Add resilience to external service calls

## Available APIs

- `fetch(url, options)` - Standard Fetch API for HTTP requests
- `workflow.getVariable(name)` - Access workflow variables
- `workflow.getSecret(name)` - Access secrets
- `node.log(message)` - Emit logs visible in execution history

## Input Contract

```typescript
{
  url: string;                    // URL to fetch
  options?: RequestInit;          // Fetch options
  maxRetries?: number;            // Max retry attempts (default: 3)
  initialDelayMs?: number;        // Initial delay (default: 1000)
  maxDelayMs?: number;            // Max delay cap (default: 10000)
  retryStatusCodes?: number[];    // Status codes to retry (default: [429, 500, 502, 503, 504])
}
```

## Output Contract

```typescript
{
  data: any;              // Response data on success
  attempts: number;       // Number of attempts made
  success: boolean;       // Whether the request succeeded
  error?: string;         // Error message if failed after all retries
}
```

## Examples

### Basic Exponential Backoff

Retry with exponential backoff for transient errors.

```javascript
async function execute(input) {
  const {
    url,
    options = {},
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    retryStatusCodes = [429, 500, 502, 503, 504]
  } = input;

  let lastError;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;

    try {
      const response = await fetch(url, options);

      if (response.ok) {
        const data = await response.json();
        node.log(`Success on attempt ${attempts}`);
        return { data, attempts, success: true };
      }

      if (retryStatusCodes.includes(response.status)) {
        lastError = `HTTP ${response.status}: ${response.statusText}`;
        node.log(`Attempt ${attempts} failed: ${lastError}`);

        if (attempt < maxRetries) {
          const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
          node.log(`Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } else {
        // Non-retryable error
        const error = `HTTP ${response.status}: ${response.statusText}`;
        return { data: null, attempts, success: false, error };
      }
    } catch (err) {
      lastError = err.message;
      node.log(`Attempt ${attempts} error: ${lastError}`);

      if (attempt < maxRetries) {
        const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  return {
    data: null,
    attempts,
    success: false,
    error: `Failed after ${maxRetries + 1} attempts: ${lastError}`
  };
}
```

### With Jitter

Add randomized jitter to prevent thundering herd.

```javascript
async function execute(input) {
  const {
    url,
    options = {},
    maxRetries = 3,
    initialDelayMs = 1000
  } = input;

  function getDelayWithJitter(attempt) {
    const baseDelay = initialDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * baseDelay * 0.5; // 0-50% jitter
    return Math.floor(baseDelay + jitter);
  }

  let lastError;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;

    try {
      const response = await fetch(url, options);

      if (response.ok) {
        return {
          data: await response.json(),
          attempts,
          success: true
        };
      }

      lastError = `HTTP ${response.status}`;

      if (attempt < maxRetries && response.status >= 500) {
        const delay = getDelayWithJitter(attempt);
        node.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (err) {
      lastError = err.message;

      if (attempt < maxRetries) {
        const delay = getDelayWithJitter(attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  return { data: null, attempts, success: false, error: lastError };
}
```

### Rate Limit Handler (429)

Special handling for rate limit responses with Retry-After header.

```javascript
async function execute(input) {
  const { url, options = {}, maxRetries = 5 } = input;

  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;

    const response = await fetch(url, options);

    if (response.ok) {
      return {
        data: await response.json(),
        attempts,
        success: true
      };
    }

    if (response.status === 429) {
      // Check for Retry-After header
      const retryAfter = response.headers.get('Retry-After');
      let delay;

      if (retryAfter) {
        // Could be seconds or HTTP date
        delay = isNaN(retryAfter)
          ? new Date(retryAfter) - Date.now()
          : parseInt(retryAfter) * 1000;
      } else {
        // Default exponential backoff
        delay = 1000 * Math.pow(2, attempt);
      }

      node.log(`Rate limited. Waiting ${delay}ms (attempt ${attempts})`);
      await new Promise(resolve => setTimeout(resolve, Math.max(delay, 1000)));
    } else {
      return {
        data: null,
        attempts,
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`
      };
    }
  }

  return {
    data: null,
    attempts,
    success: false,
    error: 'Rate limit exceeded after max retries'
  };
}
```

### Circuit Breaker Pattern

Stop retrying after consecutive failures (uses workflow variable to track state).

```javascript
async function execute(input) {
  const { url, options = {}, failureThreshold = 5 } = input;

  // Check circuit breaker state (stored in workflow variable)
  const circuitState = workflow.getVariable('CIRCUIT_STATE') || 'CLOSED';
  const failureCount = parseInt(workflow.getVariable('FAILURE_COUNT') || '0');

  if (circuitState === 'OPEN') {
    node.log('Circuit breaker is OPEN, skipping request');
    return {
      data: null,
      attempts: 0,
      success: false,
      error: 'Circuit breaker is open',
      circuitState: 'OPEN'
    };
  }

  try {
    const response = await fetch(url, options);

    if (response.ok) {
      // Reset failure count on success
      return {
        data: await response.json(),
        attempts: 1,
        success: true,
        circuitState: 'CLOSED',
        // Signal to update workflow variable
        updateVariables: { FAILURE_COUNT: '0', CIRCUIT_STATE: 'CLOSED' }
      };
    }

    throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    const newFailureCount = failureCount + 1;
    const newState = newFailureCount >= failureThreshold ? 'OPEN' : 'CLOSED';

    node.log(`Failure ${newFailureCount}/${failureThreshold}. Circuit: ${newState}`);

    return {
      data: null,
      attempts: 1,
      success: false,
      error: err.message,
      circuitState: newState,
      updateVariables: {
        FAILURE_COUNT: String(newFailureCount),
        CIRCUIT_STATE: newState
      }
    };
  }
}
```

## Constraints

- **Timeout**: 30s max per node - ensure total retry time fits within this
- **Idempotency**: Only retry idempotent operations (GET) or ensure POST/PUT are safe to retry
- **Backoff limits**: Cap maximum delay to avoid excessive waits
- **Logging**: Log each retry attempt for debugging
