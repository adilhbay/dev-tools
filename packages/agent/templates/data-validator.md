# Data Validator Node

## Purpose
Validates input data against expected schema or rules. Often used before condition nodes to check data quality.

## Available APIs
- `workflow.getVariable(name)` - access workflow variables
- `node.log(message)` - emit logs

## Input Contract
Any data structure to be validated.

## Output Contract
Returns validation result:
```json
{
  "valid": true,
  "data": { ... },
  "errors": []
}
```

Or on failure:
```json
{
  "valid": false,
  "data": { ... },
  "errors": ["Field 'email' is required", "Field 'age' must be a number"]
}
```

## Examples

### Required fields check
```javascript
async function execute(input) {
  const errors = [];
  const required = ['name', 'email', 'userId'];

  for (const field of required) {
    if (!input[field]) {
      errors.push(`Field '${field}' is required`);
    }
  }

  return {
    valid: errors.length === 0,
    data: input,
    errors
  };
}
```

### Type validation
```javascript
async function execute(input) {
  const errors = [];

  if (typeof input.email !== 'string' || !input.email.includes('@')) {
    errors.push('Invalid email format');
  }

  if (typeof input.age !== 'number' || input.age < 0) {
    errors.push('Age must be a positive number');
  }

  if (!Array.isArray(input.tags)) {
    errors.push('Tags must be an array');
  }

  return {
    valid: errors.length === 0,
    data: input,
    errors
  };
}
```

### Schema-based validation
```javascript
async function execute(input) {
  const schema = {
    name: { type: 'string', required: true },
    email: { type: 'string', required: true, pattern: /@/ },
    age: { type: 'number', min: 0, max: 150 },
    active: { type: 'boolean' }
  };

  const errors = [];

  for (const [field, rules] of Object.entries(schema)) {
    const value = input[field];

    if (rules.required && (value === undefined || value === null)) {
      errors.push(`Field '${field}' is required`);
      continue;
    }

    if (value !== undefined && value !== null) {
      if (rules.type && typeof value !== rules.type) {
        errors.push(`Field '${field}' must be of type ${rules.type}`);
      }
      if (rules.pattern && !rules.pattern.test(value)) {
        errors.push(`Field '${field}' has invalid format`);
      }
      if (rules.min !== undefined && value < rules.min) {
        errors.push(`Field '${field}' must be >= ${rules.min}`);
      }
      if (rules.max !== undefined && value > rules.max) {
        errors.push(`Field '${field}' must be <= ${rules.max}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    data: input,
    errors
  };
}
```

## Constraints
- Keep validation logic deterministic
- Log validation failures for debugging
- Return original data along with validation results
