/**
 * Built-in API Metadata
 *
 * Pre-defined metadata for common workflow integrations.
 * Phase 1: 5 APIs to prove the pattern (Slack, Stripe, Telegram, GitHub, SendGrid)
 */

import type { ApiMetadata } from './types.ts';

export const builtInApis: ApiMetadata[] = [
  // =========================================================================
  // Messaging
  // =========================================================================
  {
    id: 'slack',
    name: 'Slack',
    description: 'Team messaging and collaboration platform. Send messages, manage channels, and build bots.',
    category: 'messaging',
    authType: 'oauth2',
    keywords: [
      'chat',
      'message',
      'channel',
      'workspace',
      'bot',
      'notification',
      'team',
      'dm',
      'direct message',
      'thread',
      'mention',
      'webhook',
    ],
    sources: [
      { type: 'curated', location: 'slack.md', priority: 1 },
      { type: 'web', location: 'Slack API documentation', priority: 2 },
    ],
    lastUpdated: '2025-01-16',
  },
  {
    id: 'telegram',
    name: 'Telegram Bot API',
    description: 'Bot API for Telegram messaging platform. Send messages, photos, files, and handle updates.',
    category: 'messaging',
    authType: 'bearer-token',
    keywords: [
      'bot',
      'message',
      'chat',
      'group',
      'channel',
      'webhook',
      'inline',
      'keyboard',
      'photo',
      'document',
      'sticker',
    ],
    sources: [
      { type: 'curated', location: 'telegram.md', priority: 1 },
      { type: 'web', location: 'Telegram Bot API documentation', priority: 2 },
    ],
    lastUpdated: '2025-01-16',
  },

  // =========================================================================
  // Payments
  // =========================================================================
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Payment processing platform. Create charges, manage subscriptions, and handle webhooks.',
    category: 'payments',
    authType: 'api-key',
    keywords: [
      'payment',
      'charge',
      'subscription',
      'invoice',
      'customer',
      'billing',
      'checkout',
      'refund',
      'payout',
      'card',
      'bank',
      'webhook',
    ],
    sources: [
      { type: 'curated', location: 'stripe.md', priority: 1 },
      {
        type: 'openapi',
        location: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
        priority: 2,
      },
      { type: 'web', location: 'Stripe API documentation', priority: 3 },
    ],
    lastUpdated: '2025-01-16',
  },

  // =========================================================================
  // Developer Tools
  // =========================================================================
  {
    id: 'github',
    name: 'GitHub',
    description: 'Code hosting and collaboration platform. Manage repos, issues, PRs, and actions.',
    category: 'developer',
    authType: 'bearer-token',
    keywords: [
      'git',
      'repository',
      'repo',
      'issue',
      'pull request',
      'pr',
      'commit',
      'branch',
      'action',
      'workflow',
      'webhook',
      'release',
      'gist',
    ],
    sources: [
      { type: 'curated', location: 'github.md', priority: 1 },
      { type: 'web', location: 'GitHub REST API documentation', priority: 2 },
    ],
    lastUpdated: '2025-01-16',
  },

  // =========================================================================
  // Email
  // =========================================================================
  {
    id: 'sendgrid',
    name: 'SendGrid',
    description: 'Email delivery service. Send transactional and marketing emails at scale.',
    category: 'email',
    authType: 'api-key',
    keywords: [
      'email',
      'mail',
      'send',
      'template',
      'transactional',
      'marketing',
      'newsletter',
      'smtp',
      'delivery',
      'bounce',
      'open',
      'click',
    ],
    sources: [
      { type: 'curated', location: 'sendgrid.md', priority: 1 },
      { type: 'web', location: 'SendGrid API documentation', priority: 2 },
    ],
    lastUpdated: '2025-01-16',
  },
];

/**
 * Load all built-in APIs
 */
export function loadBuiltInApis(): ApiMetadata[] {
  return builtInApis;
}
