import type { Transport } from '@connectrpc/connect';

/**
 * Context passed to all tool implementations
 */
export interface ToolContext {
  /** gRPC transport for making service calls */
  transport: Transport;
}

/**
 * Position on the workflow canvas
 */
export interface Position {
  x: number;
  y: number;
}

/**
 * Error handling strategy for loop nodes
 */
export type ErrorHandlingStrategy = 'ignore' | 'break';

/**
 * Handle kind for edge connections
 */
export type HandleKindType = 'then' | 'else' | 'loop';

/**
 * Node kinds supported by the workflow system
 */
export type NodeKindType = 'manual_start' | 'http' | 'condition' | 'for' | 'for_each' | 'js';

/**
 * Execution state of a node or edge
 */
export type FlowItemStateType = 'running' | 'success' | 'failure' | 'canceled';

/**
 * Base result type for tools
 */
export interface ToolResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Workflow graph representation
 */
export interface WorkflowGraph {
  flow: {
    flowId: string;
    name: string;
    running: boolean;
  };
  nodes: Array<{
    nodeId: string;
    kind: NodeKindType | 'unspecified';
    name: string;
    position?: Position;
    state: FlowItemStateType | 'unspecified';
  }>;
  edges: Array<{
    edgeId: string;
    sourceId: string;
    targetId: string;
    sourceHandle: HandleKindType | 'unspecified';
    state: FlowItemStateType | 'unspecified';
  }>;
}

/**
 * Node details with type-specific configuration
 */
export interface NodeDetails {
  nodeId: string;
  flowId: string;
  kind: NodeKindType | 'unspecified';
  name: string;
  position?: Position;
  state: FlowItemStateType | 'unspecified';
  config:
    | { type: 'js'; code: string }
    | { type: 'http'; httpId: string; deltaHttpId?: string }
    | { type: 'condition'; condition: string }
    | { type: 'for'; iterations: number; condition: string; errorHandling: ErrorHandlingStrategy }
    | { type: 'for_each'; path: string; condition: string; errorHandling: ErrorHandlingStrategy }
    | { type: 'manual_start' }
    | null;
  incomingEdges: Array<{ edgeId: string; sourceId: string; sourceHandle: HandleKindType | 'unspecified' }>;
  outgoingEdges: Array<{ edgeId: string; targetId: string; sourceHandle: HandleKindType | 'unspecified' }>;
}

/**
 * Template metadata
 */
export interface TemplateInfo {
  name: string;
  description: string;
  path: string;
}

/**
 * Flow variable
 */
export interface FlowVariable {
  flowVariableId: string;
  flowId: string;
  key: string;
  value: string;
  description: string;
  enabled: boolean;
  order: number;
}
