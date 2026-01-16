/**
 * Search API Docs Tool
 *
 * Searches the API registry for relevant APIs based on query.
 * Returns lightweight metadata - use getApiDocs to load full documentation.
 *
 * This is the "discovery" step inspired by Anthropic's tool search pattern.
 */

import type { ToolResult } from '../../types.ts';
import type { SearchApiDocsResult, ApiCategory } from '../../api-docs/types.ts';
import { getRegistry, initializeApiDocs, isInitialized } from '../../api-docs/index.ts';

export interface SearchApiDocsParams {
  /** Search query (API name, description, or keywords) */
  query: string;
  /** Optional category filter */
  category?: ApiCategory;
  /** Maximum results to return (default: 5) */
  limit?: number;
}

/**
 * Search for API documentation by name, description, or keywords.
 * Returns lightweight metadata - use getApiDocs to load full documentation.
 */
export async function searchApiDocs(
  params: SearchApiDocsParams
): Promise<ToolResult<SearchApiDocsResult>> {
  try {
    // Ensure system is initialized
    if (!isInitialized()) {
      await initializeApiDocs();
    }

    const registry = getRegistry();

    const results = registry.search(params.query, {
      category: params.category,
      limit: params.limit ?? 5,
    });

    return {
      success: true,
      data: {
        apis: results,
        totalCount: results.length,
        query: params.query,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
