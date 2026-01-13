# Data Transformer Node

## Purpose

Transform, reshape, or filter data between workflow steps. Use this pattern when you need to:
- Map data from one structure to another
- Filter arrays based on conditions
- Extract specific fields from complex objects
- Merge or flatten nested data

## Available APIs

- `workflow.getVariable(name)` - Access workflow variables
- `node.log(message)` - Emit logs visible in execution history

## Input Contract

Accepts any data structure from the previous node:
```typescript
{
  data: any;           // The data to transform
  [key: string]: any;  // Additional context if needed
}
```

## Output Contract

Returns transformed data in the structure needed by the next node.

## Examples

### Map Array to New Structure

Transform an array of objects to a different shape.

```javascript
async function execute(input) {
  const transformed = input.data.map(item => ({
    id: item.userId,
    fullName: `${item.firstName} ${item.lastName}`,
    email: item.contactEmail,
    active: item.status === 'active'
  }));

  return { data: transformed };
}
```

### Filter and Sort

Filter array by condition and sort results.

```javascript
async function execute(input) {
  const filtered = input.data
    .filter(item => item.status === 'active' && item.score > 50)
    .sort((a, b) => b.score - a.score);

  node.log(`Filtered ${input.data.length} items to ${filtered.length}`);

  return { data: filtered };
}
```

### Flatten Nested Structure

Flatten deeply nested data.

```javascript
async function execute(input) {
  const flattened = input.data.flatMap(category =>
    category.items.map(item => ({
      categoryId: category.id,
      categoryName: category.name,
      ...item
    }))
  );

  return { data: flattened };
}
```

### Group By Key

Group array items by a specific field.

```javascript
async function execute(input) {
  const grouped = input.data.reduce((acc, item) => {
    const key = item.department;
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(item);
    return acc;
  }, {});

  return {
    data: grouped,
    departments: Object.keys(grouped)
  };
}
```

### Extract and Compute

Extract specific fields and compute derived values.

```javascript
async function execute(input) {
  const items = input.data;

  const summary = {
    total: items.length,
    totalValue: items.reduce((sum, item) => sum + item.value, 0),
    averageValue: items.length > 0
      ? items.reduce((sum, item) => sum + item.value, 0) / items.length
      : 0,
    maxValue: Math.max(...items.map(item => item.value)),
    minValue: Math.min(...items.map(item => item.value))
  };

  return {
    items: items,
    summary: summary
  };
}
```

### Merge Multiple Sources

Merge data from multiple sources (passed as separate keys).

```javascript
async function execute(input) {
  const { users, orders, products } = input;

  // Create lookup maps for efficiency
  const productMap = new Map(products.map(p => [p.id, p]));

  // Enrich orders with user and product data
  const enrichedOrders = orders.map(order => {
    const user = users.find(u => u.id === order.userId);
    const product = productMap.get(order.productId);

    return {
      ...order,
      userName: user?.name || 'Unknown',
      userEmail: user?.email,
      productName: product?.name || 'Unknown',
      productPrice: product?.price
    };
  });

  return { data: enrichedOrders };
}
```

### Handle Missing Data

Transform with safe handling of missing/null values.

```javascript
async function execute(input) {
  const transformed = input.data.map(item => ({
    id: item.id,
    name: item.name || 'Unnamed',
    email: item.email?.toLowerCase() || null,
    tags: item.tags || [],
    metadata: {
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || null,
      version: item.version ?? 1
    }
  }));

  return { data: transformed };
}
```

## Constraints

- **Memory**: Transformations happen in memory; be mindful with large datasets
- **Timeout**: 30s max per node execution
- **Immutability**: Avoid mutating input data; create new objects instead
