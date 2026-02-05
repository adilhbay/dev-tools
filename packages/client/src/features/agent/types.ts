import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

// Re-export AgentPhase and transition types for external consumers
export type { AgentPhase, PendingTransition, TransitionAction } from './agent-phases';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'correction';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  summary?: string;
}

export interface ToolResult {
  toolCallId: string;
  result: unknown;
  error?: string;
  isMutation?: boolean;
}

export interface AgentChatState {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
}

export interface FlowContextData {
  flowId: string;
  nodes: NodeInfo[];
  edges: EdgeInfo[];
  variables: VariableInfo[];
  executions: NodeExecutionInfo[];
  selectedNodeIds?: string[];
}

export interface NodeInfo {
  id: string;
  name: string;
  kind: string;
  position: { x: number; y: number };
  state: string;
  info?: string;
  httpId?: string;
  httpMethod?: string;
}

export interface NodeExecutionInfo {
  id: string;
  nodeId: string;
  name: string;
  state: string;
  error?: string;
  input?: unknown;
  output?: unknown;
  completedAt?: string;
}

export interface EdgeInfo {
  id: string;
  sourceId: string;
  targetId: string;
  sourceHandle?: string;
}

export interface VariableInfo {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export const formatToolAsOpenAI = (schema: ToolSchema): ChatCompletionTool => ({
  type: 'function',
  function: {
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
  },
});

export type OpenAIMessage = ChatCompletionMessageParam;

// =============================================================================
// Completion Oracle Types
// =============================================================================

/** Intent extracted from user message for goal tracking */
export type GoalIntent =
  | 'create'
  | 'modify'
  | 'delete'
  | 'connect'
  | 'run'
  | 'debug'
  | 'query';

/** Extracted goal from user message */
export interface ExtractedGoal {
  /** The primary intent of the user's request */
  intent: GoalIntent;
  /** Target node names/IDs if applicable */
  targetNodes?: string[];
  /** Expected outcome description */
  expectedOutcome?: string;
  /** Original user message */
  originalMessage: string;
  /** Confidence in goal extraction (0-1) */
  confidence: number;
}

/** Result of completion check */
export interface CompletionResult {
  /** Whether the goal is complete */
  complete: boolean;
  /** Reason for completion/incompletion */
  reason: string;
  /** Progress toward goal (0-1) */
  progress: number;
  /** Criteria that haven't been met yet */
  missingCriteria?: string[];
}

/** Plan mutation action types */
export type PlanMutationAction = 'create' | 'modify' | 'delete' | 'connect';

/** Arguments for planMutation tool */
export interface PlanMutationArgs {
  /** Node IDs the agent claims to know about */
  existingNodesRelevant: string[];
  /** The intended mutation action */
  intendedAction: PlanMutationAction;
  /** Name of the target node (for creates) or ID (for modify/delete) */
  targetName: string;
  /** Why this mutation is needed */
  rationale: string;
}

/** Result of plan mutation validation */
export interface PlanMutationResult {
  /** Whether the mutation is approved */
  approved: boolean;
  /** Error message if not approved */
  error?: string;
  /** Suggestions for fixing the issue */
  suggestion?: string;
}
