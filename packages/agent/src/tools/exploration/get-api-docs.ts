/**
 * Get API Docs Tool
 *
 * Loads full documentation for a specific API.
 * This is the "deferred loading" step - only call after finding the API via search.
 *
 * Inspired by Anthropic's tool search pattern where tools are discovered first,
 * then their full definitions are loaded on-demand.
 */

import type { ToolResult } from '../../types.ts';
import type { GetApiDocsResult, ApiDocumentation } from '../../api-docs/types.ts';
import {
  getRegistry,
  getCache,
  initializeApiDocs,
  isInitialized,
  fetchDocumentation,
} from '../../api-docs/index.ts';

export interface GetApiDocsParams {
  /** API identifier (from search results) */
  apiId: string;
  /** Force refresh from source (bypass cache) */
  forceRefresh?: boolean;
  /** Specific endpoint to focus on (optional filter) */
  endpoint?: string;
}

/**
 * Load full documentation for a specific API.
 * This is the "deferred loading" step - only call after finding the API via search.
 */
export async function getApiDocs(params: GetApiDocsParams): Promise<ToolResult<GetApiDocsResult>> {
  try {
    // Ensure system is initialized
    if (!isInitialized()) {
      await initializeApiDocs();
    }

    const registry = getRegistry();
    const cache = getCache();

    // Get API metadata
    const api = registry.get(params.apiId);
    if (!api) {
      return {
        success: false,
        error: `API not found: ${params.apiId}. Use searchApiDocs to find available APIs.`,
      };
    }

    // Check cache first (unless force refresh)
    if (!params.forceRefresh) {
      const cached = cache.get(params.apiId);
      if (cached) {
        return {
          success: true,
          data: {
            documentation: params.endpoint ? filterByEndpoint(cached, params.endpoint) : cached,
            fromCache: true,
          },
        };
      }
    }

    // Fetch documentation from sources
    const documentation = await fetchDocumentation(api);

    // Cache the result
    cache.set(params.apiId, documentation);

    return {
      success: true,
      data: {
        documentation: params.endpoint
          ? filterByEndpoint(documentation, params.endpoint)
          : documentation,
        fromCache: false,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Filter documentation to only include endpoints matching the filter
 */
function filterByEndpoint(doc: ApiDocumentation, filter: string): ApiDocumentation {
  const lowerFilter = filter.toLowerCase();

  const filtered = doc.endpoints.filter(
    (e) =>
      e.path.toLowerCase().includes(lowerFilter) ||
      e.description.toLowerCase().includes(lowerFilter)
  );

  return { ...doc, endpoints: filtered };
}
