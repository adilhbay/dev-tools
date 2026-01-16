/**
 * API Documentation System
 *
 * Provides dynamic API documentation retrieval for workflow building.
 * Inspired by Anthropic's "tool search" pattern - deferred loading of docs.
 */

import { ApiRegistry } from './registry.ts';
import { DocCache, fetchDocumentation, setCuratedDocsDir } from './fetchers/index.ts';
import { loadBuiltInApis } from './built-in-apis.ts';

// Re-export types
export * from './types.ts';

// Re-export registry class
export { ApiRegistry } from './registry.ts';

// Re-export fetcher utilities
export { DocCache, setCuratedDocsDir, getCuratedDocsDir } from './fetchers/index.ts';

// ============================================================================
// Singleton Instances
// ============================================================================

let registry: ApiRegistry | null = null;
let cache: DocCache | null = null;
let initialized = false;

/**
 * Get the global API registry instance
 */
export function getRegistry(): ApiRegistry {
  if (!registry) {
    registry = new ApiRegistry();
  }
  return registry;
}

/**
 * Get the global documentation cache instance
 */
export function getCache(): DocCache {
  if (!cache) {
    cache = new DocCache(60); // 1 hour TTL
  }
  return cache;
}

/**
 * Initialize the API documentation system with built-in APIs
 */
export async function initializeApiDocs(options?: { curatedDocsDir?: string }): Promise<void> {
  if (initialized) return;

  const reg = getRegistry();

  // Set custom curated docs directory if provided
  if (options?.curatedDocsDir) {
    setCuratedDocsDir(options.curatedDocsDir);
  }

  // Load built-in APIs
  const builtInApis = loadBuiltInApis();
  reg.registerAll(builtInApis);

  initialized = true;
}

/**
 * Check if the API docs system is initialized
 */
export function isInitialized(): boolean {
  return initialized;
}

/**
 * Reset the system (mainly for testing)
 */
export function resetApiDocs(): void {
  registry?.clear();
  cache?.clear();
  initialized = false;
}

// ============================================================================
// High-Level API
// ============================================================================

export { fetchDocumentation };
