# JS Transformer Node

## Purpose
Transforms data from upstream nodes using JavaScript. The most flexible node type for custom logic.

## Available APIs
- `fetch(url, options)` - standard fetch API for HTTP requests
- `workflow.getVariable(name)` - access workflow variables
- `workflow.getSecret(name)` - access secrets (resolved at runtime)
- `node.log(message)` - emit logs visible in execution history

## Input Contract
Receives the output from the previous node as `input`. The structure depends on the upstream node.

## Output Contract
Must return a value that will be passed to downstream nodes. Can be any JSON-serializable value.

## Examples

### Basic transformation
```javascript
async function execute(input) {
  return {
    ...input,
    transformed: true,
    timestamp: new Date().toISOString()
  };
}
```

### Filter and map
```javascript
async function execute(input) {
  const filtered = input.items.filter(item => item.active);
  return {
    items: filtered.map(item => ({
      id: item.id,
      name: item.name.toUpperCase()
    })),
    count: filtered.length
  };
}
```

### Using workflow variables
```javascript
async function execute(input) {
  const apiKey = workflow.getVariable('API_KEY');
  const baseUrl = workflow.getVariable('BASE_URL');

  node.log(`Processing ${input.items.length} items`);

  return {
    ...input,
    config: { apiKey: '***', baseUrl }
  };
}
```

## Constraints
- Timeout: 30s max
- Memory: Limited JavaScript heap
- No access to file system or OS-level APIs
