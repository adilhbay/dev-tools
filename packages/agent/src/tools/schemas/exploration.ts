/**
 * JSON Schema definitions for exploration (read-only) tools
 */

export const getWorkflowGraphSchema = {
  name: 'getWorkflowGraph',
  description:
    'Get the complete workflow graph including all nodes and edges. Use this to understand the current structure of the workflow.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow to retrieve',
      },
    },
    required: ['flowId'],
  },
};

export const getNodeDetailsSchema = {
  name: 'getNodeDetails',
  description:
    'Get detailed information about a specific node including its configuration, code (for JS nodes), and connections.',
  parameters: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'The ULID of the node to inspect',
      },
    },
    required: ['nodeId'],
  },
};

export const getNodeTemplateSchema = {
  name: 'getNodeTemplate',
  description:
    'Read a markdown template that provides guidance on implementing a specific type of node or pattern.',
  parameters: {
    type: 'object' as const,
    properties: {
      templateName: {
        type: 'string',
        description: 'The name of the template to retrieve (e.g., "http-aggregator", "js-transformer")',
      },
    },
    required: ['templateName'],
  },
};

export const searchTemplatesSchema = {
  name: 'searchTemplates',
  description: 'Search for available templates by keyword or pattern.',
  parameters: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search query to find relevant templates',
      },
    },
    required: ['query'],
  },
};

export const getExecutionHistorySchema = {
  name: 'getExecutionHistory',
  description: 'Get the history of past workflow executions.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of executions to return (default: 10)',
      },
    },
    required: ['flowId'],
  },
};

export const getExecutionLogsSchema = {
  name: 'getExecutionLogs',
  description:
    'Get the latest execution logs. Returns only the most recent execution per node to avoid showing full history.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'Filter to only show executions for nodes in this workflow',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of node executions to return (default: 10)',
      },
      executionId: {
        type: 'string',
        description: 'Optional: specific execution ID to get logs for',
      },
    },
    required: [],
  },
};

export const explorationSchemas = [
  getWorkflowGraphSchema,
  getNodeDetailsSchema,
  getNodeTemplateSchema,
  searchTemplatesSchema,
  getExecutionHistorySchema,
  getExecutionLogsSchema,
];
