import { eq } from '@tanstack/react-db';
import { Ulid } from 'id128';
import OpenAI from 'openai';
import { useCallback, useRef, useState } from 'react';
import { NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import { allToolSchemas } from './tool-schemas';
import {
  EdgeCollectionSchema,
  FlowVariableCollectionSchema,
  NodeCollectionSchema,
  NodeConditionCollectionSchema,
  NodeExecutionCollectionSchema,
  NodeForCollectionSchema,
  NodeForEachCollectionSchema,
  NodeHttpCollectionSchema,
  NodeJsCollectionSchema,
} from '@the-dev-tools/spec/tanstack-db/v1/api/flow';
import { HttpCollectionSchema } from '@the-dev-tools/spec/tanstack-db/v1/api/http';
import { useApiCollection } from '~/shared/api';
import { queryCollection } from '~/shared/lib';
import { routes } from '~/shared/routes';
import { buildSystemPrompt, useFlowContext } from './context-builder';
import { defaultHorizontalConfig, layoutNodes } from './layout';
import { executeToolCall, type Collections, type ToolExecutorContext } from './tool-executor';
import {
  formatToolAsOpenAI,
  type AgentChatState,
  type FlowContextData,
  type Message,
  type OpenAIMessage,
  type ToolCall,
  type ToolResult,
  type ToolSchema,
} from './types';

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: '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',
  dangerouslyAllowBrowser: true,
});

const MODEL = 'minimax/minimax-m2.1';

const generateId = () => crypto.randomUUID();

/** JSON stringify with BigInt support */
const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

type NodeCollection = ReturnType<typeof useApiCollection<typeof NodeCollectionSchema>>;
type EdgeCollection = ReturnType<typeof useApiCollection<typeof EdgeCollectionSchema>>;

const NODE_KIND_NAMES: Record<number, string> = {
  [NodeKind.UNSPECIFIED]: 'Unknown',
  [NodeKind.MANUAL_START]: 'ManualStart',
  [NodeKind.HTTP]: 'HTTP',
  [NodeKind.CONDITION]: 'Condition',
  [NodeKind.FOR]: 'For',
  [NodeKind.FOR_EACH]: 'ForEach',
  [NodeKind.JS]: 'JavaScript',
};

/**
 * Query fresh nodes and edges directly from collections, then apply layout.
 * This avoids stale context issues when mutations haven't propagated to React state yet.
 */
const applyLayoutToFlow = async (
  flowId: Uint8Array,
  nodeCollection: NodeCollection,
  edgeCollection: EdgeCollection,
): Promise<void> => {
  // Query fresh nodes directly from the collection
  const freshNodes = await queryCollection((_) =>
    _.from({ node: nodeCollection }).where((_) => eq(_.node.flowId, flowId)),
  );

  // Query fresh edges directly from the collection
  const freshEdges = await queryCollection((_) =>
    _.from({ edge: edgeCollection }).where((_) => eq(_.edge.flowId, flowId)),
  );

  // Build node info for layout
  const nodes = freshNodes
    .filter((n) => n.nodeId != null)
    .map((n) => ({
      id: Ulid.construct(n.nodeId).toCanonical(),
      name: n.name,
      kind: NODE_KIND_NAMES[n.kind] ?? 'Unknown',
      position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
      state: 'Idle',
    }));

  // Build a set of valid node IDs for filtering
  const validNodeIds = new Set(nodes.map((n) => n.id));

  // Build edge info for layout - only include edges where both source and target exist
  const edges = freshEdges
    .filter((e) => e.edgeId != null && e.sourceId != null && e.targetId != null)
    .map((e) => ({
      id: Ulid.construct(e.edgeId).toCanonical(),
      sourceId: Ulid.construct(e.sourceId).toCanonical(),
      targetId: Ulid.construct(e.targetId).toCanonical(),
      sourceHandle: e.sourceHandle !== undefined ? String(e.sourceHandle) : undefined,
    }))
    .filter((e) => validNodeIds.has(e.sourceId) && validNodeIds.has(e.targetId));

  const result = layoutNodes(nodes, edges, defaultHorizontalConfig());
  if (!result) return;

  for (const [nodeId, position] of result.positions) {
    nodeCollection.utils.update({
      nodeId: Ulid.fromCanonical(nodeId).bytes,
      position: { x: position.x, y: position.y },
    });
  }
};

const clientToolSchemas: ToolSchema[] = [
  {
    name: 'getSelectedNodes',
    description: 'Get details of the nodes currently selected by the user on the canvas.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'updateHttpMethod',
    description: 'Update the HTTP method of an existing HTTP request.',
    parameters: {
      type: 'object',
      properties: {
        httpId: {
          type: 'string',
          description: 'The ID of the HTTP request to update (from the node\'s httpId field)',
        },
        method: {
          type: 'string',
          description: 'The new HTTP method',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        },
      },
      required: ['httpId', 'method'],
      additionalProperties: false,
    },
  },
];

interface UseAgentChatOptions {
  flowId: Uint8Array;
  selectedNodeIds?: string[];
}

export const useAgentChat = ({ flowId, selectedNodeIds }: UseAgentChatOptions) => {
  const [state, setState] = useState<AgentChatState>({
    messages: [],
    isLoading: false,
    error: null,
  });

  const { transport } = routes.root.useRouteContext();
  const flowContext = useFlowContext(flowId);

  // Use refs to always access latest values in callbacks
  const flowContextRef = useRef(flowContext);
  flowContextRef.current = flowContext;

  const selectedNodeIdsRef = useRef(selectedNodeIds);
  selectedNodeIdsRef.current = selectedNodeIds;

  // Abort controller for cancelling requests
  const abortControllerRef = useRef<AbortController | null>(null);

  const nodeCollection = useApiCollection(NodeCollectionSchema);
  const edgeCollection = useApiCollection(EdgeCollectionSchema);
  const variableCollection = useApiCollection(FlowVariableCollectionSchema);
  const jsCollection = useApiCollection(NodeJsCollectionSchema);
  const conditionCollection = useApiCollection(NodeConditionCollectionSchema);
  const forCollection = useApiCollection(NodeForCollectionSchema);
  const forEachCollection = useApiCollection(NodeForEachCollectionSchema);
  const nodeHttpCollection = useApiCollection(NodeHttpCollectionSchema);
  const httpCollection = useApiCollection(HttpCollectionSchema);
  const executionCollection = useApiCollection(NodeExecutionCollectionSchema);

  const sendMessage = useCallback(
    async (content: string) => {
      // Cancel any existing request
      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      // Use ref to get latest flowContext at execution time
      const currentFlowContext = {
        ...flowContextRef.current,
        selectedNodeIds: selectedNodeIdsRef.current,
      };

      // Build context fresh at execution time to avoid stale closures
      const collections: Collections = {
        nodeCollection,
        edgeCollection,
        variableCollection,
        jsCollection,
        conditionCollection,
        forCollection,
        forEachCollection,
        nodeHttpCollection,
        httpCollection,
        executionCollection,
      };

      const toolContext: ToolExecutorContext = {
        collections,
        flowContext: currentFlowContext,
        transport,
      };

      const userMessage: Message = {
        id: generateId(),
        role: 'user',
        content,
        timestamp: Date.now(),
      };

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
        isLoading: true,
        error: null,
      }));

      try {
        const systemPrompt = buildSystemPrompt(currentFlowContext);
        const tools = [...allToolSchemas, ...clientToolSchemas].map(formatToolAsOpenAI);

        const openAIMessages: OpenAIMessage[] = [
          { role: 'system', content: systemPrompt },
          ...state.messages.map(messageToOpenAI),
          { role: 'user', content },
        ];

        let response = await openai.chat.completions.create(
          {
            model: MODEL,
            messages: openAIMessages,
            tools,
            tool_choice: 'auto',
          },
          { signal: abortController.signal },
        );

        let assistantMessage = response.choices[0]?.message;

        while (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
          const toolCalls: ToolCall[] = assistantMessage.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
          }));

          const toolMessage: Message = {
            id: generateId(),
            role: 'assistant',
            content: assistantMessage.content ?? '',
            toolCalls,
            timestamp: Date.now(),
          };

          setState((prev) => ({
            ...prev,
            messages: [...prev.messages, toolMessage],
          }));

          const toolResults = await Promise.all(
            toolCalls.map((tc) => executeToolCall(tc, flowId, toolContext)),
          );

          // Apply layout after mutations
          const hadMutations = toolResults.some((tr: ToolResult) => tr.isMutation && !tr.error);
          if (hadMutations) {
            // Query fresh data directly from collections to avoid stale React context
            await applyLayoutToFlow(flowId, nodeCollection, edgeCollection);
          }

          const toolResultMessages: Message[] = toolResults.map((tr) => ({
            id: generateId(),
            role: 'tool' as const,
            content: tr.error ?? safeStringify(tr.result),
            toolCallId: tr.toolCallId,
            timestamp: Date.now(),
          }));

          setState((prev) => ({
            ...prev,
            messages: [...prev.messages, ...toolResultMessages],
          }));

          openAIMessages.push({
            role: 'assistant',
            content: assistantMessage.content,
            tool_calls: assistantMessage.tool_calls,
          });

          for (const tr of toolResults) {
            openAIMessages.push({
              role: 'tool',
              tool_call_id: tr.toolCallId,
              content: tr.error ?? safeStringify(tr.result),
            });
          }

          response = await openai.chat.completions.create(
            {
              model: MODEL,
              messages: openAIMessages,
              tools,
              tool_choice: 'auto',
            },
            { signal: abortController.signal },
          );

          assistantMessage = response.choices[0]?.message;
        }

        const finalMessage: Message = {
          id: generateId(),
          role: 'assistant',
          content: assistantMessage?.content ?? '',
          timestamp: Date.now(),
        };

        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, finalMessage],
          isLoading: false,
        }));
      } catch (error) {
        // Ignore abort errors
        if (error instanceof Error && error.name === 'AbortError') {
          setState((prev) => ({ ...prev, isLoading: false }));
          return;
        }
        const errorMessage = error instanceof Error ? error.message : 'An error occurred';
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }));
      } finally {
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }
      }
    },
    [flowId, transport, nodeCollection, edgeCollection, variableCollection, jsCollection, conditionCollection, forCollection, forEachCollection, nodeHttpCollection, httpCollection, executionCollection, state.messages],
  );

  const clearMessages = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setState({
      messages: [],
      isLoading: false,
      error: null,
    });
  }, []);

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setState((prev) => ({ ...prev, isLoading: false }));
  }, []);

  return {
    messages: state.messages,
    isLoading: state.isLoading,
    error: state.error,
    sendMessage,
    clearMessages,
    cancel,
  };
};

const messageToOpenAI = (message: Message): OpenAIMessage => {
  if (message.role === 'tool' && message.toolCallId) {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  if (message.role === 'assistant' && message.toolCalls) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    };
  }

  return {
    role: message.role as 'user' | 'assistant' | 'system',
    content: message.content,
  };
};
