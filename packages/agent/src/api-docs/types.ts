/**
 * API Documentation Types
 *
 * Follows the "deferred loading" pattern from Anthropic's tool search.
 * Only lightweight metadata is loaded upfront; full docs are fetched on demand.
 */

// ============================================================================
// API Categories and Auth Types
// ============================================================================

export type ApiCategory =
  | 'messaging' // Slack, Telegram, Discord
  | 'payments' // Stripe, PayPal
  | 'project-management' // Jira, Linear, Asana
  | 'storage' // S3, GCS, Dropbox
  | 'database' // Supabase, Firebase, Airtable
  | 'email' // SendGrid, Mailgun
  | 'calendar' // Google Calendar, Outlook
  | 'crm' // Salesforce, HubSpot
  | 'social' // Twitter, LinkedIn
  | 'analytics' // Mixpanel, Amplitude
  | 'developer' // GitHub, GitLab
  | 'other';

export type AuthType = 'api-key' | 'oauth2' | 'bearer-token' | 'basic-auth' | 'custom' | 'none';

// ============================================================================
// Documentation Sources
// ============================================================================

export interface DocSource {
  /** Source type */
  type: 'openapi' | 'curated' | 'web';

  /** URL for openapi specs, filename for curated, or search query for web */
  location: string;

  /** Priority (lower = higher priority) */
  priority: number;
}

// ============================================================================
// Lightweight Metadata (Loaded Upfront)
// ============================================================================

/**
 * Lightweight API metadata for the registry index.
 * Only this data is loaded upfront - actual docs are deferred.
 */
export interface ApiMetadata {
  /** Unique identifier for the API (e.g., "slack", "stripe", "jira") */
  id: string;

  /** Human-readable name */
  name: string;

  /** Short description for search/display */
  description: string;

  /** Category for filtering */
  category: ApiCategory;

  /** Authentication type */
  authType: AuthType;

  /** Keywords for search relevance */
  keywords: string[];

  /** Available documentation sources, ordered by preference */
  sources: DocSource[];

  /** When this entry was last updated */
  lastUpdated: string;
}

// ============================================================================
// Full Documentation (Loaded On Demand)
// ============================================================================

export interface AuthDetails {
  type: AuthType;

  /** Where to put the auth (header, query, etc.) */
  location: 'header' | 'query' | 'body' | 'cookie';

  /** Header/param name */
  name: string;

  /** Format (e.g., "Bearer {token}", "{api_key}") */
  format?: string;

  /** Link to OAuth authorization endpoint */
  oauthUrl?: string;

  /** Required scopes for OAuth */
  scopes?: string[];
}

export interface ParameterInfo {
  name: string;
  type: string;
  required: boolean;
  description: string;
  default?: unknown;
  enum?: unknown[];
}

export interface SchemaInfo {
  type: string;
  properties?: Record<string, ParameterInfo>;
  example?: unknown;
}

export interface ApiEndpoint {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

  /** Path (e.g., "/users/{id}") */
  path: string;

  /** What this endpoint does */
  description: string;

  /** Path parameters */
  pathParams?: ParameterInfo[] | undefined;

  /** Query parameters */
  queryParams?: ParameterInfo[] | undefined;

  /** Request body schema */
  requestBody?: SchemaInfo | undefined;

  /** Response schema */
  response?: SchemaInfo | undefined;

  /** Code example */
  example?: string | undefined;
}

export interface ApiExample {
  title: string;
  description?: string;
  code: string;
  language: 'javascript' | 'curl' | 'json';
}

export interface RateLimitInfo {
  requests: number;
  period: string;
  headers?: string[];
}

export interface ErrorCodeInfo {
  code: string | number;
  message: string;
  description?: string | undefined;
}

/**
 * Full API documentation - loaded on demand
 */
export interface ApiDocumentation {
  /** Reference to the API metadata */
  apiId: string;

  /** Source that provided this documentation */
  source: DocSource['type'];

  /** Base URL for the API */
  baseUrl: string;

  /** Authentication details */
  auth: AuthDetails;

  /** Available endpoints */
  endpoints: ApiEndpoint[];

  /** Common headers/parameters */
  commonParams?: Record<string, ParameterInfo> | undefined;

  /** Usage examples */
  examples: ApiExample[];

  /** Rate limiting information */
  rateLimits?: RateLimitInfo | undefined;

  /** Error codes and their meanings */
  errorCodes?: ErrorCodeInfo[] | undefined;

  /** Raw content (for curated markdown docs) */
  rawContent?: string | undefined;
}

// ============================================================================
// Search Types
// ============================================================================

export interface SearchOptions {
  /** Filter by category */
  category?: ApiCategory | undefined;

  /** Maximum results to return */
  limit?: number | undefined;
}

export interface ApiSearchResult {
  api: ApiMetadata;
  score: number;
  matchedFields: string[];
}

// ============================================================================
// Tool Result Types
// ============================================================================

export interface SearchApiDocsResult {
  apis: ApiSearchResult[];
  totalCount: number;
  query: string;
}

export interface GetApiDocsResult {
  documentation: ApiDocumentation;
  fromCache: boolean;
}
