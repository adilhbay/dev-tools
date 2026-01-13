import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TemplateInfo, ToolResult } from '../../types.ts';
import { getTemplatesDir } from './get-node-template.ts';

export interface SearchTemplatesParams {
  query: string;
}

export interface SearchTemplatesResult {
  templates: TemplateInfo[];
}

/**
 * Extract description from template markdown content.
 * Looks for the first paragraph after the title.
 */
function extractDescription(content: string): string {
  const lines = content.split('\n');
  let foundTitle = false;
  let description = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines before title
    if (!foundTitle && trimmed === '') continue;

    // Skip the title line
    if (!foundTitle && trimmed.startsWith('#')) {
      foundTitle = true;
      continue;
    }

    // Skip empty lines after title
    if (foundTitle && trimmed === '') continue;

    // Found first content line
    if (foundTitle) {
      description = trimmed;
      break;
    }
  }

  // Truncate if too long
  if (description.length > 200) {
    description = description.substring(0, 197) + '...';
  }

  return description;
}

/**
 * Search for available templates by keyword or pattern.
 */
export async function searchTemplates(params: SearchTemplatesParams): Promise<ToolResult<SearchTemplatesResult>> {
  try {
    const templatesDir = getTemplatesDir();

    // Check if templates directory exists
    try {
      await fs.access(templatesDir);
    } catch {
      return {
        success: true,
        data: { templates: [] },
      };
    }

    // Read all .md files in templates directory
    const files = await fs.readdir(templatesDir);
    const mdFiles = files.filter((f) => f.endsWith('.md'));

    const query = params.query.toLowerCase();
    const templates: TemplateInfo[] = [];

    for (const file of mdFiles) {
      const filePath = path.join(templatesDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const name = file.replace('.md', '');

      // Check if query matches filename or content
      const matchesName = name.toLowerCase().includes(query);
      const matchesContent = content.toLowerCase().includes(query);

      if (matchesName || matchesContent) {
        templates.push({
          name,
          description: extractDescription(content),
          path: filePath,
        });
      }
    }

    return {
      success: true,
      data: { templates },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
