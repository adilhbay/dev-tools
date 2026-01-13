/**
 * Template system for workflow agent
 *
 * Templates are Markdown files that provide guidance on implementing
 * common node patterns. They are stored in the templates/ directory
 * relative to this package.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTemplatesDir } from '../tools/exploration/get-node-template.ts';

// Get the directory of this file
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set the default templates directory to the package's templates folder
const defaultTemplatesDir = path.resolve(__dirname, '../../templates');
setTemplatesDir(defaultTemplatesDir);

/**
 * List of built-in templates
 */
export const builtInTemplates = [
  {
    name: 'js-transformer',
    description: 'Transforms data from upstream nodes using JavaScript',
  },
  {
    name: 'http-aggregator',
    description: 'Combines multiple HTTP responses into a single output',
  },
  {
    name: 'error-handler',
    description: 'Handles errors from upstream nodes gracefully',
  },
  {
    name: 'data-validator',
    description: 'Validates input data against expected schema or rules',
  },
];

export { setTemplatesDir, getTemplatesDir } from '../tools/exploration/get-node-template.ts';
