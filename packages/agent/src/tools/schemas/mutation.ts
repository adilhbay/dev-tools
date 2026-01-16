/**
 * JSON Schema definitions for mutation tools
 */

export const createJsNodeSchema = {
  name: 'createJsNode',
  description:
    'Create a new JavaScript node in the workflow. JS nodes can transform data, make calculations, or perform custom logic.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow to add the node to',
      },
      name: {
        type: 'string',
        description: 'Display name for the node',
      },
      code: {
        type: 'string',
        description:
          'The function body only. Write code directly - do NOT define inner functions. Use ctx for input. MUST have a return statement. The tool auto-wraps with "export default function(ctx) { ... }". Example: "const result = ctx.value * 2; return { result };"',
      },
      position: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        description: 'Position on the canvas (optional)',
      },
    },
    required: ['flowId', 'name', 'code'],
  },
};

export const createHttpNodeSchema = {
  name: 'createHttpNode',
  description: 'Create a new HTTP request node that makes an API call.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow to add the node to',
      },
      name: {
        type: 'string',
        description: 'Display name for the node',
      },
      httpId: {
        type: 'string',
        description: 'The ULID of the HTTP request definition to use',
      },
      position: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        description: 'Position on the canvas (optional)',
      },
    },
    required: ['flowId', 'name', 'httpId'],
  },
};

export const createConditionNodeSchema = {
  name: 'createConditionNode',
  description:
    'Create a condition node that routes flow based on a boolean expression. Has THEN and ELSE output handles.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow to add the node to',
      },
      name: {
        type: 'string',
        description: 'Display name for the node',
      },
      condition: {
        type: 'string',
        description: 'Boolean expression to evaluate (e.g., "input.status === 200")',
      },
      position: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        description: 'Position on the canvas (optional)',
      },
    },
    required: ['flowId', 'name', 'condition'],
  },
};

export const createForNodeSchema = {
  name: 'createForNode',
  description: 'Create a for-loop node that iterates a fixed number of times.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow to add the node to',
      },
      name: {
        type: 'string',
        description: 'Display name for the node',
      },
      iterations: {
        type: 'number',
        description: 'Number of iterations to perform',
      },
      condition: {
        type: 'string',
        description: 'Optional condition to continue loop (evaluated each iteration)',
      },
      errorHandling: {
        type: 'string',
        enum: ['ignore', 'break'],
        description: 'How to handle errors: "ignore" continues, "break" stops the loop',
      },
      position: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        description: 'Position on the canvas (optional)',
      },
    },
    required: ['flowId', 'name', 'iterations', 'condition', 'errorHandling'],
  },
};

export const createForEachNodeSchema = {
  name: 'createForEachNode',
  description: 'Create a forEach node that iterates over an array or object.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow to add the node to',
      },
      name: {
        type: 'string',
        description: 'Display name for the node',
      },
      path: {
        type: 'string',
        description: 'Path to the array/object to iterate (e.g., "input.items")',
      },
      condition: {
        type: 'string',
        description: 'Optional condition to continue iteration',
      },
      errorHandling: {
        type: 'string',
        enum: ['ignore', 'break'],
        description: 'How to handle errors: "ignore" continues, "break" stops iteration',
      },
      position: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        description: 'Position on the canvas (optional)',
      },
    },
    required: ['flowId', 'name', 'path', 'condition', 'errorHandling'],
  },
};

export const updateNodeCodeSchema = {
  name: 'updateNodeCode',
  description: 'Update the JavaScript code of a JS node.',
  parameters: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'The ULID of the JS node to update',
      },
      code: {
        type: 'string',
        description:
          'The function body only. Write code directly - do NOT define inner functions. Use ctx for input. MUST have a return statement. The tool auto-wraps with "export default function(ctx) { ... }". Example: "const result = ctx.value * 2; return { result };"',
      },
    },
    required: ['nodeId', 'code'],
  },
};

export const updateNodeConfigSchema = {
  name: 'updateNodeConfig',
  description: 'Update general node properties like name or position.',
  parameters: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'The ULID of the node to update',
      },
      name: {
        type: 'string',
        description: 'New display name (optional)',
      },
      position: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        description: 'New position on the canvas (optional)',
      },
    },
    required: ['nodeId'],
  },
};

export const connectNodesSchema = {
  name: 'connectNodes',
  description:
    'Create an edge connection between two nodes. IMPORTANT: For sequential flows (Manual Start, JS, HTTP nodes), do NOT specify sourceHandle - omit it entirely. Only use sourceHandle for Condition nodes (then/else) and Loop nodes (loop/then).',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow',
      },
      sourceId: {
        type: 'string',
        description: 'The ULID of the source node',
      },
      targetId: {
        type: 'string',
        description: 'The ULID of the target node',
      },
      sourceHandle: {
        type: 'string',
        enum: ['then', 'else', 'loop'],
        description:
          'Output handle for branching nodes ONLY. Use "then"/"else" for Condition nodes, "loop"/"then" for For/ForEach nodes. OMIT this parameter for Manual Start, JS, and HTTP nodes.',
      },
    },
    required: ['flowId', 'sourceId', 'targetId'],
  },
};

export const disconnectNodesSchema = {
  name: 'disconnectNodes',
  description: 'Remove an edge connection between nodes.',
  parameters: {
    type: 'object' as const,
    properties: {
      edgeId: {
        type: 'string',
        description: 'The ULID of the edge to remove',
      },
    },
    required: ['edgeId'],
  },
};

export const deleteNodeSchema = {
  name: 'deleteNode',
  description: 'Delete a node from the workflow. Also removes all connected edges.',
  parameters: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'The ULID of the node to delete',
      },
    },
    required: ['nodeId'],
  },
};

export const createVariableSchema = {
  name: 'createVariable',
  description: 'Create a new workflow variable that can be referenced in node expressions.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowId: {
        type: 'string',
        description: 'The ULID of the workflow',
      },
      key: {
        type: 'string',
        description: 'Variable name (used to reference it in expressions)',
      },
      value: {
        type: 'string',
        description: 'Variable value',
      },
      description: {
        type: 'string',
        description: 'Description of what the variable is for (optional)',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the variable is active (default: true)',
      },
    },
    required: ['flowId', 'key', 'value'],
  },
};

export const updateVariableSchema = {
  name: 'updateVariable',
  description: 'Update an existing workflow variable.',
  parameters: {
    type: 'object' as const,
    properties: {
      flowVariableId: {
        type: 'string',
        description: 'The ULID of the variable to update',
      },
      key: {
        type: 'string',
        description: 'New variable name (optional)',
      },
      value: {
        type: 'string',
        description: 'New variable value (optional)',
      },
      description: {
        type: 'string',
        description: 'New description (optional)',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the variable is active (optional)',
      },
    },
    required: ['flowVariableId'],
  },
};

export const mutationSchemas = [
  createJsNodeSchema,
  createHttpNodeSchema,
  createConditionNodeSchema,
  createForNodeSchema,
  createForEachNodeSchema,
  updateNodeCodeSchema,
  updateNodeConfigSchema,
  connectNodesSchema,
  disconnectNodesSchema,
  deleteNodeSchema,
  createVariableSchema,
  updateVariableSchema,
];
