import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolResult } from '../../types.ts';

export interface GetNodeTemplateParams {
  templateName: string;
}

export interface TemplateContent {
  name: string;
  content: string;
}

// Default templates directory - can be configured
let templatesDir = path.join(process.cwd(), 'templates');

/**
 * Set the templates directory path
 */
export function setTemplatesDir(dir: string): void {
  templatesDir = dir;
}

/**
 * Get the current templates directory path
 */
export function getTemplatesDir(): string {
  return templatesDir;
}

/**
 * Read a markdown template that provides guidance on implementing
 * a specific type of node or pattern.
 */
export async function getNodeTemplate(params: GetNodeTemplateParams): Promise<ToolResult<TemplateContent>> {
  try {
    // Sanitize template name to prevent directory traversal
    const safeName = params.templateName.replace(/[^a-zA-Z0-9-_]/g, '');
    const templatePath = path.join(templatesDir, `${safeName}.md`);

    // Check if file exists
    try {
      await fs.access(templatePath);
    } catch {
      return {
        success: false,
        error: `Template not found: ${params.templateName}`,
      };
    }

    const content = await fs.readFile(templatePath, 'utf-8');

    return {
      success: true,
      data: {
        name: params.templateName,
        content,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
