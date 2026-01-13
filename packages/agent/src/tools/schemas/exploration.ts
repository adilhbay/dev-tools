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
  description: 'Get detailed logs from a specific workflow execution.',
  parameters: {
    type: 'object' as const,
    properties: {
      executionId: {
        type: 'string',
        description: 'The ULID of the execution to get logs for',
      },
    },
    required: ['executionId'],
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
