# Stripe API

Payment processing platform for creating charges, managing subscriptions, and handling webhooks.

## Base URL

https://api.stripe.com/v1

## Authentication

- Type: Bearer Token
- Location: Header
- Name: Authorization
- Format: Bearer {secret_key}

Use your Secret Key from https://dashboard.stripe.com/apikeys

## Endpoints

### Create a Charge

Create a new charge to a customer's card.

**POST** `/charges`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| amount | integer | Yes | Amount in cents (e.g., 1000 = $10.00) |
| currency | string | Yes | Three-letter ISO currency code (e.g., "usd") |
| source | string | Yes* | Payment source token (*or customer) |
| customer | string | No | Customer ID to charge |
| description | string | No | Description for the charge |
| metadata | object | No | Key-value metadata |

```javascript
async function execute(input) {
  const secretKey = workflow.getSecret('STRIPE_SECRET_KEY');
  const response = await fetch('https://api.stripe.com/v1/charges', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      amount: String(input.amount),
      currency: 'usd',
      source: input.token,
      description: input.description || '',
    }),
  });
  return response.json();
}
```

### Create a Customer

Create a new customer in Stripe.

**POST** `/customers`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| email | string | No | Customer email |
| name | string | No | Customer name |
| source | string | No | Default payment source token |
| metadata | object | No | Key-value metadata |

```javascript
async function execute(input) {
  const secretKey = workflow.getSecret('STRIPE_SECRET_KEY');
  const response = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      email: input.email,
      name: input.name,
    }),
  });
  return response.json();
}
```

### Create a Payment Intent

Create a PaymentIntent for handling complex payment flows.

**POST** `/payment_intents`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| amount | integer | Yes | Amount in cents |
| currency | string | Yes | Three-letter ISO currency code |
| payment_method_types[] | array | No | Allowed payment methods (default: ["card"]) |
| customer | string | No | Customer ID |
| metadata | object | No | Key-value metadata |

```javascript
async function execute(input) {
  const secretKey = workflow.getSecret('STRIPE_SECRET_KEY');
  const response = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      amount: String(input.amount),
      currency: 'usd',
      'payment_method_types[]': 'card',
    }),
  });
  return response.json();
}
```

### List Charges

List all charges, optionally filtered.

**GET** `/charges`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| limit | integer | No | Max results (default: 10, max: 100) |
| customer | string | No | Filter by customer ID |
| created[gte] | timestamp | No | Filter by created after timestamp |

```javascript
async function execute(input) {
  const secretKey = workflow.getSecret('STRIPE_SECRET_KEY');
  const params = new URLSearchParams({ limit: '10' });
  if (input.customerId) params.set('customer', input.customerId);

  const response = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
    headers: { 'Authorization': `Bearer ${secretKey}` },
  });
  return response.json();
}
```

### Create a Refund

Refund a charge.

**POST** `/refunds`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| charge | string | Yes | Charge ID to refund |
| amount | integer | No | Partial refund amount (default: full) |
| reason | string | No | duplicate, fraudulent, or requested_by_customer |

```javascript
async function execute(input) {
  const secretKey = workflow.getSecret('STRIPE_SECRET_KEY');
  const response = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      charge: input.chargeId,
    }),
  });
  return response.json();
}
```

## Rate Limits

- 100 requests per second in live mode
- 25 requests per second in test mode

## Error Codes

| Code | Description |
|------|-------------|
| card_declined | The card was declined |
| expired_card | The card has expired |
| incorrect_cvc | The CVC is incorrect |
| processing_error | Processing error occurred |
| invalid_request_error | Invalid parameters |
| authentication_required | 3D Secure authentication required |

## Examples

### Complete payment flow

```javascript
async function execute(input) {
  const secretKey = workflow.getSecret('STRIPE_SECRET_KEY');

  // 1. Create or get customer
  let customerId = input.customerId;
  if (!customerId) {
    const customerResp = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ email: input.email }),
    });
    const customer = await customerResp.json();
    customerId = customer.id;
  }

  // 2. Create payment intent
  const paymentResp = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      amount: String(input.amount),
      currency: 'usd',
      customer: customerId,
    }),
  });

  return paymentResp.json();
}
```
