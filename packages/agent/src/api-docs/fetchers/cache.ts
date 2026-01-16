/**
 * Documentation Cache
 *
 * In-memory cache for fetched API documentation with TTL expiration.
 */

import type { ApiDocumentation } from '../types.ts';

interface CacheEntry {
  documentation: ApiDocumentation;
  timestamp: number;
}

/**
 * Cache for API documentation with automatic TTL expiration
 */
export class DocCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxAgeMs: number;

  /**
   * Create a new cache instance
   * @param maxAgeMinutes - Cache TTL in minutes (default: 60)
   */
  constructor(maxAgeMinutes: number = 60) {
    this.maxAgeMs = maxAgeMinutes * 60 * 1000;
  }

  /**
   * Get cached documentation for an API
   * @returns Documentation if cached and not expired, null otherwise
   */
  get(apiId: string): ApiDocumentation | null {
    const entry = this.cache.get(apiId);
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > this.maxAgeMs) {
      this.cache.delete(apiId);
      return null;
    }

    return entry.documentation;
  }

  /**
   * Cache documentation for an API
   */
  set(apiId: string, documentation: ApiDocumentation): void {
    this.cache.set(apiId, {
      documentation,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if an API's documentation is cached (and not expired)
   */
  has(apiId: string): boolean {
    return this.get(apiId) !== null;
  }

  /**
   * Remove cached documentation for an API
   */
  invalidate(apiId: string): void {
    this.cache.delete(apiId);
  }

  /**
   * Clear all cached documentation
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached items
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Remove all expired entries
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [apiId, entry] of this.cache) {
      if (now - entry.timestamp > this.maxAgeMs) {
        this.cache.delete(apiId);
        pruned++;
      }
    }

    return pruned;
  }
}
