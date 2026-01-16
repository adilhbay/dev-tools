/**
 * API Registry with BM25 Search
 *
 * Manages an index of available APIs with lightweight metadata.
 * Provides fast keyword search for discovering relevant APIs.
 */

import type { ApiMetadata, ApiSearchResult, SearchOptions, ApiCategory } from './types.ts';

// ============================================================================
// Search Document for Indexing
// ============================================================================

interface SearchDocument {
  id: string;
  tokens: string[];
  length: number;
  fieldTokens: {
    name: string[];
    description: string[];
    keywords: string[];
    category: string[];
  };
}

// ============================================================================
// BM25 Search Index
// ============================================================================

class SearchIndex {
  private documents: Map<string, SearchDocument> = new Map();
  private invertedIndex: Map<string, Set<string>> = new Map();
  private documentCount: number = 0;

  // BM25 parameters
  private k1 = 1.5;
  private b = 0.75;
  private avgDocLength = 0;

  /**
   * Add an API to the search index
   */
  add(api: ApiMetadata): void {
    const tokens = this.tokenize(api);
    const doc: SearchDocument = {
      id: api.id,
      tokens,
      length: tokens.length,
      fieldTokens: {
        name: this.tokenizeField(api.name),
        description: this.tokenizeField(api.description),
        keywords: api.keywords.map((k) => k.toLowerCase()),
        category: [api.category],
      },
    };

    this.documents.set(api.id, doc);
    this.documentCount++;

    // Update inverted index
    for (const token of new Set(tokens)) {
      if (!this.invertedIndex.has(token)) {
        this.invertedIndex.set(token, new Set());
      }
      this.invertedIndex.get(token)!.add(api.id);
    }

    // Recalculate average document length
    this.avgDocLength =
      Array.from(this.documents.values()).reduce((sum, d) => sum + d.length, 0) / this.documentCount;
  }

  /**
   * Remove an API from the search index
   */
  remove(apiId: string): void {
    const doc = this.documents.get(apiId);
    if (!doc) return;

    // Remove from inverted index
    for (const token of new Set(doc.tokens)) {
      const docSet = this.invertedIndex.get(token);
      if (docSet) {
        docSet.delete(apiId);
        if (docSet.size === 0) {
          this.invertedIndex.delete(token);
        }
      }
    }

    this.documents.delete(apiId);
    this.documentCount--;

    // Recalculate average document length
    if (this.documentCount > 0) {
      this.avgDocLength =
        Array.from(this.documents.values()).reduce((sum, d) => sum + d.length, 0) /
        this.documentCount;
    } else {
      this.avgDocLength = 0;
    }
  }

  /**
   * Search for APIs matching the query
   */
  search(
    query: string,
    options: SearchOptions = {},
    getApi: (id: string) => ApiMetadata | undefined
  ): ApiSearchResult[] {
    const queryTokens = this.tokenizeField(query);
    const scores: Map<string, { score: number; matchedFields: Set<string> }> = new Map();

    for (const token of queryTokens) {
      const matchingDocs = this.invertedIndex.get(token);
      if (!matchingDocs) continue;

      const idf = this.calculateIDF(matchingDocs.size);

      for (const docId of matchingDocs) {
        const doc = this.documents.get(docId)!;

        // Apply category filter if specified
        if (options.category && !doc.fieldTokens.category.includes(options.category)) {
          continue;
        }

        const tf = this.calculateTF(token, doc.tokens);
        const score = this.calculateBM25Score(tf, idf, doc.length);

        if (!scores.has(docId)) {
          scores.set(docId, { score: 0, matchedFields: new Set() });
        }

        const entry = scores.get(docId)!;
        entry.score += score;

        // Track which fields matched
        for (const [field, tokens] of Object.entries(doc.fieldTokens)) {
          if (tokens.includes(token)) {
            entry.matchedFields.add(field);
          }
        }
      }
    }

    // Convert to results and sort by score
    const results: ApiSearchResult[] = [];
    for (const [docId, { score, matchedFields }] of scores) {
      const api = getApi(docId);
      if (api) {
        results.push({
          api,
          score,
          matchedFields: Array.from(matchedFields),
        });
      }
    }

    results.sort((a, b) => b.score - a.score);

    // Apply limit
    const limit = options.limit ?? 10;
    return results.slice(0, limit);
  }

  private tokenize(api: ApiMetadata): string[] {
    return [
      ...this.tokenizeField(api.name),
      ...this.tokenizeField(api.description),
      ...api.keywords.map((k) => k.toLowerCase()),
      api.category,
    ];
  }

  private tokenizeField(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 1);
  }

  private calculateIDF(docFreq: number): number {
    return Math.log((this.documentCount - docFreq + 0.5) / (docFreq + 0.5) + 1);
  }

  private calculateTF(token: string, docTokens: string[]): number {
    return docTokens.filter((t) => t === token).length;
  }

  private calculateBM25Score(tf: number, idf: number, docLength: number): number {
    const numerator = tf * (this.k1 + 1);
    const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength));
    return idf * (numerator / denominator);
  }
}

// ============================================================================
// API Registry
// ============================================================================

/**
 * API Registry - manages the index of available APIs
 *
 * Follows the "deferred loading" pattern from Anthropic's tool search.
 * Only lightweight metadata is loaded upfront; full docs are fetched on demand.
 */
export class ApiRegistry {
  private apis: Map<string, ApiMetadata> = new Map();
  private searchIndex: SearchIndex;

  constructor() {
    this.searchIndex = new SearchIndex();
  }

  /**
   * Register a new API in the registry
   */
  register(api: ApiMetadata): void {
    // Remove old entry if exists (for updates)
    if (this.apis.has(api.id)) {
      this.searchIndex.remove(api.id);
    }

    this.apis.set(api.id, api);
    this.searchIndex.add(api);
  }

  /**
   * Register multiple APIs at once
   */
  registerAll(apis: ApiMetadata[]): void {
    for (const api of apis) {
      this.register(api);
    }
  }

  /**
   * Search for APIs by query
   */
  search(query: string, options?: SearchOptions): ApiSearchResult[] {
    return this.searchIndex.search(query, options, (id) => this.apis.get(id));
  }

  /**
   * Get API metadata by ID
   */
  get(id: string): ApiMetadata | undefined {
    return this.apis.get(id);
  }

  /**
   * Check if an API exists in the registry
   */
  has(id: string): boolean {
    return this.apis.has(id);
  }

  /**
   * List all APIs, optionally filtered by category
   */
  list(category?: ApiCategory): ApiMetadata[] {
    const all = Array.from(this.apis.values());
    if (category) {
      return all.filter((api) => api.category === category);
    }
    return all;
  }

  /**
   * Get total count of registered APIs
   */
  get count(): number {
    return this.apis.size;
  }

  /**
   * Clear all registered APIs
   */
  clear(): void {
    this.apis.clear();
    this.searchIndex = new SearchIndex();
  }
}
