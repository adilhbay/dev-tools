/**
 * Curated Documentation Fetcher
 *
 * Loads and parses curated markdown documentation files.
 * These are hand-written docs optimized for workflow building.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ApiMetadata,
  ApiDocumentation,
  DocSource,
  AuthDetails,
  ApiEndpoint,
  ApiExample,
  ParameterInfo,
  AuthType,
  ErrorCodeInfo,
} from '../types.ts';

// Default directory for curated docs (relative to this file)
let curatedDocsDir = path.join(import.meta.dirname ?? __dirname, '..', 'curated');

/**
 * Set the directory containing curated documentation files
 */
export function setCuratedDocsDir(dir: string): void {
  curatedDocsDir = dir;
}

/**
 * Get the current curated docs directory
 */
export function getCuratedDocsDir(): string {
  return curatedDocsDir;
}

/**
 * Fetch documentation from a curated markdown file
 */
export async function fetchCuratedDocs(
  api: ApiMetadata,
  source: DocSource
): Promise<ApiDocumentation> {
  // Sanitize filename to prevent directory traversal
  const safeName = source.location.replace(/[^a-zA-Z0-9-_.]/g, '');
  const filePath = path.join(curatedDocsDir, safeName);

  const content = await fs.readFile(filePath, 'utf-8');
  return parseMarkdown(api, content);
}

/**
 * Check if a curated doc file exists
 */
export async function curatedDocExists(source: DocSource): Promise<boolean> {
  try {
    const safeName = source.location.replace(/[^a-zA-Z0-9-_.]/g, '');
    const filePath = path.join(curatedDocsDir, safeName);
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Markdown Parser
// ============================================================================

interface ParsedSections {
  baseUrl?: string;
  auth?: string;
  endpoints?: string;
  examples?: string;
  rateLimits?: string;
  errors?: string;
}

/**
 * Parse a curated markdown document into structured ApiDocumentation
 */
function parseMarkdown(api: ApiMetadata, content: string): ApiDocumentation {
  const sections = extractSections(content);

  return {
    apiId: api.id,
    source: 'curated',
    baseUrl: parseBaseUrl(sections.baseUrl),
    auth: parseAuth(sections.auth, api.authType),
    endpoints: parseEndpoints(sections.endpoints),
    examples: parseExamples(sections.examples),
    rateLimits: parseRateLimits(sections.rateLimits),
    errorCodes: parseErrors(sections.errors),
    rawContent: content,
  };
}

/**
 * Extract sections from markdown by ## headers
 */
function extractSections(content: string): ParsedSections {
  const sections: ParsedSections = {};
  const lines = content.split('\n');

  let currentSection: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^## (.+)$/);
    if (headerMatch && headerMatch[1]) {
      // Save previous section
      if (currentSection) {
        const key = sectionNameToKey(currentSection);
        if (key) {
          sections[key] = currentContent.join('\n').trim();
        }
      }

      currentSection = headerMatch[1];
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    const key = sectionNameToKey(currentSection);
    if (key) {
      sections[key] = currentContent.join('\n').trim();
    }
  }

  return sections;
}

function sectionNameToKey(name: string): keyof ParsedSections | null {
  const normalized = name.toLowerCase().trim();
  if (normalized.includes('base url') || normalized === 'url') return 'baseUrl';
  if (normalized.includes('auth')) return 'auth';
  if (normalized.includes('endpoint')) return 'endpoints';
  if (normalized.includes('example')) return 'examples';
  if (normalized.includes('rate') || normalized.includes('limit')) return 'rateLimits';
  if (normalized.includes('error')) return 'errors';
  return null;
}

function parseBaseUrl(section?: string): string {
  if (!section) return '';
  // Extract URL from section (may be in a code block or plain text)
  const urlMatch = section.match(/https?:\/\/[^\s\n]+/);
  return urlMatch ? urlMatch[0] : section.trim();
}

function parseAuth(section?: string, defaultType?: AuthType): AuthDetails {
  const defaults: AuthDetails = {
    type: defaultType ?? 'api-key',
    location: 'header',
    name: 'Authorization',
  };

  if (!section) return defaults;

  // Parse type
  const typeMatch = section.match(/type:\s*(\S+)/i);
  if (typeMatch && typeMatch[1]) {
    const type = typeMatch[1].toLowerCase();
    if (type.includes('bearer')) defaults.type = 'bearer-token';
    else if (type.includes('oauth')) defaults.type = 'oauth2';
    else if (type.includes('api') || type.includes('key')) defaults.type = 'api-key';
    else if (type.includes('basic')) defaults.type = 'basic-auth';
  }

  // Parse location
  const locationMatch = section.match(/location:\s*(\S+)/i);
  if (locationMatch && locationMatch[1]) {
    const loc = locationMatch[1].toLowerCase();
    if (loc.includes('header')) defaults.location = 'header';
    else if (loc.includes('query')) defaults.location = 'query';
    else if (loc.includes('body')) defaults.location = 'body';
  }

  // Parse header/param name
  const headerMatch = section.match(/header:\s*(\S+)/i) || section.match(/name:\s*(\S+)/i);
  if (headerMatch && headerMatch[1]) {
    defaults.name = headerMatch[1];
  }

  // Parse format
  const formatMatch = section.match(/format:\s*(.+)/i);
  if (formatMatch && formatMatch[1]) {
    defaults.format = formatMatch[1].trim();
  }

  return defaults;
}

function parseEndpoints(section?: string): ApiEndpoint[] {
  if (!section) return [];

  const endpoints: ApiEndpoint[] = [];
  const endpointBlocks = section.split(/(?=^### )/m);

  for (const block of endpointBlocks) {
    if (!block.trim()) continue;

    // Parse endpoint header (### name)
    const nameMatch = block.match(/^### (.+)$/m);
    if (!nameMatch || !nameMatch[1]) continue;

    const name = nameMatch[1].trim();

    // Parse method and path (e.g., **POST** `/path`)
    const methodMatch = block.match(/\*\*(GET|POST|PUT|PATCH|DELETE)\*\*\s*`([^`]+)`/i);

    // Parse description (first paragraph after header)
    const descMatch = block.match(/^### .+\n+(.+?)(?:\n\n|\n\*\*|$)/s);

    // Parse parameters table
    const params = parseParameterTable(block);

    // Parse example code block
    const exampleMatch = block.match(/```(?:javascript|js|typescript|ts)\n([\s\S]*?)```/);

    const method = methodMatch?.[1]?.toUpperCase();
    const validMethod =
      method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
        ? method
        : 'GET';

    endpoints.push({
      method: validMethod,
      path: methodMatch?.[2] ?? `/${name.toLowerCase().replace(/\s+/g, '-')}`,
      description: descMatch?.[1]?.trim() ?? name,
      queryParams: params,
      example: exampleMatch?.[1]?.trim(),
    });
  }

  return endpoints;
}

function parseParameterTable(block: string): ParameterInfo[] {
  const params: ParameterInfo[] = [];

  // Match markdown table rows (| name | type | required | description |)
  const tableMatch = block.match(/\|[\s\S]*?\|[\s\S]*?\n((?:\|.*\|\n?)+)/);
  if (!tableMatch || !tableMatch[1]) return params;

  const rows = tableMatch[1].split('\n').filter((row) => row.includes('|'));

  for (const row of rows) {
    // Skip separator row
    if (row.match(/^\|[\s-:|]+\|$/)) continue;

    const cells = row
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length >= 2 && cells[0] && cells[1]) {
      params.push({
        name: cells[0],
        type: cells[1],
        required: cells[2]?.toLowerCase() === 'yes' || cells[2]?.toLowerCase() === 'true',
        description: cells[3] ?? '',
      });
    }
  }

  return params;
}

function parseExamples(section?: string): ApiExample[] {
  if (!section) return [];

  const examples: ApiExample[] = [];

  // Find all code blocks with titles
  const codeBlockRegex = /(?:###?\s*(.+?)\n)?```(javascript|js|typescript|ts|curl|json)\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(section)) !== null) {
    const title = match[1]?.trim() ?? 'Example';
    const lang = match[2];
    const codeContent = match[3];
    if (!codeContent) continue;
    const code = codeContent.trim();

    let language: ApiExample['language'] = 'javascript';
    if (lang === 'curl') language = 'curl';
    else if (lang === 'json') language = 'json';

    examples.push({ title, code, language });
  }

  return examples;
}

function parseRateLimits(section?: string): ApiDocumentation['rateLimits'] {
  if (!section) return undefined;

  // Try to extract rate limit info
  const requestsMatch = section.match(/(\d+)\s*requests?/i);
  const periodMatch = section.match(/per\s+(\w+)/i);

  if (requestsMatch && requestsMatch[1]) {
    return {
      requests: parseInt(requestsMatch[1], 10),
      period: periodMatch?.[1] ?? 'minute',
    };
  }

  return undefined;
}

function parseErrors(section?: string): ApiDocumentation['errorCodes'] {
  if (!section) return undefined;

  const errors: ErrorCodeInfo[] = [];

  // Match table rows for error codes
  const tableMatch = section.match(/\|[\s\S]*?\|[\s\S]*?\n((?:\|.*\|\n?)+)/);
  if (!tableMatch || !tableMatch[1]) return undefined;

  const rows = tableMatch[1].split('\n').filter((row) => row.includes('|'));

  for (const row of rows) {
    if (row.match(/^\|[\s-:|]+\|$/)) continue;

    const cells = row
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length >= 2 && cells[0] && cells[1]) {
      errors.push({
        code: cells[0],
        message: cells[1],
        description: cells[2],
      });
    }
  }

  return errors.length > 0 ? errors : undefined;
}
