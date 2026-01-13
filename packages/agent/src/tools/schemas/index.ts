/**
 * JSON Schema definitions for all workflow agent tools
 */

export * from './exploration.ts';
export * from './mutation.ts';
export * from './execution.ts';

import { explorationSchemas } from './exploration.ts';
import { mutationSchemas } from './mutation.ts';
import { executionSchemas } from './execution.ts';

/**
 * All tool schemas combined
 */
export const allToolSchemas = [...explorationSchemas, ...mutationSchemas, ...executionSchemas];
