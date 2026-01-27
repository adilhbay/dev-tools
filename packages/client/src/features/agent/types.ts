import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

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
}

export interface ToolResult {
  toolCallId: string;
  result: unknown;
  error?: string;
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
}

export interface NodeInfo {
  id: string;
  name: string;
  kind: string;
  position: { x: number; y: number };
  state: string;
  info?: string;
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
