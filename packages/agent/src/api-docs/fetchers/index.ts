/**
 * Documentation Fetcher Coordinator
 *
 * Tries multiple sources in priority order to fetch API documentation.
 */

import type { ApiMetadata, ApiDocumentation, DocSource } from '../types.ts';
import { fetchCuratedDocs, curatedDocExists } from './curated-fetcher.ts';

export { DocCache } from './cache.ts';
export { setCuratedDocsDir, getCuratedDocsDir } from './curated-fetcher.ts';

/**
 * Fetch documentation for an API, trying sources in priority order
 */
export async function fetchDocumentation(api: ApiMetadata): Promise<ApiDocumentation> {
  // Sort sources by priority
  const sortedSources = [...api.sources].sort((a, b) => a.priority - b.priority);

  let lastError: Error | null = null;

  for (const source of sortedSources) {
    try {
      const docs = await fetchFromSource(api, source);
      if (docs) return docs;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Continue to next source
    }
  }

  throw lastError ?? new Error(`No documentation sources available for ${api.id}`);
}

/**
 * Fetch from a specific source
 */
async function fetchFromSource(api: ApiMetadata, source: DocSource): Promise<ApiDocumentation | null> {
  switch (source.type) {
    case 'curated':
      // Check if file exists before trying to read
      if (await curatedDocExists(source)) {
        return fetchCuratedDocs(api, source);
      }
      return null;

    case 'openapi':
      // OpenAPI fetcher - not implemented in phase 1
      // Would fetch and parse OpenAPI spec from source.location
      throw new Error('OpenAPI fetcher not yet implemented');

    case 'web':
      // Web fallback - not implemented in phase 1
      // Would perform web search and extract structured data
      throw new Error('Web fetcher not yet implemented');

    default:
      return null;
  }
}

/**
 * Check if documentation can be fetched for an API
 */
export async function canFetchDocs(api: ApiMetadata): Promise<boolean> {
  for (const source of api.sources) {
    if (source.type === 'curated' && (await curatedDocExists(source))) {
      return true;
    }
    // Add checks for other source types as they're implemented
  }
  return false;
}
