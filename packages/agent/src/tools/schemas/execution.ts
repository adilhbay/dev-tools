/**
 * JSON Schema definitions for execution tools
 */

export const runWorkflowSchema = {
  name: 'runWorkflow',
  description: 'Execute the workflow from the start node. Returns execution status.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow to run',
      },
    },
    required: ['flowId'],
  },
};

export const stopWorkflowSchema = {
  name: 'stopWorkflow',
  description: 'Stop a running workflow execution.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow to stop',
      },
    },
    required: ['flowId'],
  },
};

export const validateWorkflowSchema = {
  name: 'validateWorkflow',
  description:
    'Validate the workflow for errors, missing connections, or configuration issues. Use this before running to catch problems.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow to validate',
      },
    },
    required: ['flowId'],
  },
};

export const executionSchemas = [runWorkflowSchema, stopWorkflowSchema, validateWorkflowSchema];
