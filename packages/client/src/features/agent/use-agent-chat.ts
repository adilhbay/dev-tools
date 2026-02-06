import { eq } from '@tanstack/react-db';
import { Ulid } from 'id128';
import OpenAI from 'openai';
import { useCallback, useRef, useState } from 'react';
import { FlowItemState, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import { allToolSchemas } from './tool-schemas';
import {
  EdgeCollectionSchema,
  FlowCollectionSchema,
  FlowVariableCollectionSchema,
  NodeCollectionSchema,
  NodeConditionCollectionSchema,
  NodeExecutionCollectionSchema,
  NodeForCollectionSchema,
  NodeForEachCollectionSchema,
  NodeHttpCollectionSchema,
  NodeJsCollectionSchema,
} from '@the-dev-tools/spec/tanstack-db/v1/api/flow';
import {
  HttpAssertCollectionSchema,
  HttpBodyRawCollectionSchema,
  HttpCollectionSchema,
  HttpHeaderCollectionSchema,
  HttpSearchParamCollectionSchema,
} from '@the-dev-tools/spec/tanstack-db/v1/api/http';
import { useApiCollection } from '~/shared/api';
import { queryCollection } from '~/shared/lib';
import { routes } from '~/shared/routes';
import { buildSystemPrompt, detectOrphanNodes, refreshFlowContext, useFlowContext } from './context-builder';
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
import { AgentLogger } from './agent-logger';

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: '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',
  dangerouslyAllowBrowser: true,
});

const MODEL = 'moonshotai/kimi-k2.5';

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

const FLOW_ITEM_STATE_NAMES: Record<number, string> = {
  [FlowItemState.UNSPECIFIED]: 'Idle',
  [FlowItemState.RUNNING]: 'Running',
  [FlowItemState.SUCCESS]: 'Success',
  [FlowItemState.FAILURE]: 'Failure',
  [FlowItemState.CANCELED]: 'Canceled',
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
    name: 'getFlowExecutionSummary',
    description: 'Get a summary of the latest flow execution showing which nodes ran and which were never reached.',
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
  {
    name: 'addHttpSearchParam',
    description: 'Add a query parameter to an HTTP request.',
    parameters: {
      type: 'object',
      properties: {
        httpId: { type: 'string', description: 'The HTTP request ID' },
        key: { type: 'string', description: 'Parameter name' },
        value: { type: 'string', description: 'Parameter value' },
        enabled: { type: 'boolean', description: 'Whether the parameter is active (default: true)' },
        description: { type: 'string', description: 'Description of the parameter' },
      },
      required: ['httpId', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'updateHttpSearchParam',
    description: 'Update an existing query parameter on an HTTP request.',
    parameters: {
      type: 'object',
      properties: {
        httpSearchParamId: { type: 'string', description: 'The search param ID to update' },
        key: { type: 'string', description: 'New parameter name' },
        value: { type: 'string', description: 'New parameter value' },
        enabled: { type: 'boolean', description: 'Whether the parameter is active' },
        description: { type: 'string', description: 'New description' },
      },
      required: ['httpSearchParamId'],
      additionalProperties: false,
    },
  },
  {
    name: 'deleteHttpSearchParam',
    description: 'Delete a query parameter from an HTTP request.',
    parameters: {
      type: 'object',
      properties: {
        httpSearchParamId: { type: 'string', description: 'The search param ID to delete' },
      },
      required: ['httpSearchParamId'],
      additionalProperties: false,
    },
  },
  {
    name: 'addHttpHeader',
    description: 'Add a header to an HTTP request.',
    parameters: {
      type: 'object',
      properties: {
        httpId: { type: 'string', description: 'The HTTP request ID' },
        key: { type: 'string', description: 'Header name (e.g. Content-Type, Authorization)' },
        value: { type: 'string', description: 'Header value' },
        enabled: { type: 'boolean', description: 'Whether the header is active (default: true)' },
        description: { type: 'string', description: 'Description of the header' },
      },
      required: ['httpId', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'updateHttpHeader',
    description: 'Update an existing header on an HTTP request.',
    parameters: {
      type: 'object',
      properties: {
        httpHeaderId: { type: 'string', description: 'The header ID to update' },
        key: { type: 'string', description: 'New header name' },
        value: { type: 'string', description: 'New header value' },
        enabled: { type: 'boolean', description: 'Whether the header is active' },
        description: { type: 'string', description: 'New description' },
      },
      required: ['httpHeaderId'],
      additionalProperties: false,
    },
  },
  {
    name: 'deleteHttpHeader',
    description: 'Delete a header from an HTTP request.',
    parameters: {
      type: 'object',
      properties: {
        httpHeaderId: { type: 'string', description: 'The header ID to delete' },
      },
      required: ['httpHeaderId'],
      additionalProperties: false,
    },
  },
  {
    name: 'setHttpBody',
    description: 'Set the raw body content of an HTTP request. The HTTP request must use POST, PUT, or PATCH method.',
    parameters: {
      type: 'object',
      properties: {
        httpId: { type: 'string', description: 'The HTTP request ID' },
        data: { type: 'string', description: 'The raw body content (e.g. JSON string)' },
      },
      required: ['httpId', 'data'],
      additionalProperties: false,
    },
  },
  {
    name: 'addHttpAssert',
    description: 'Add an assertion to an HTTP request. Assertions validate the response (e.g. status code, body content).',
    parameters: {
      type: 'object',
      properties: {
        httpId: { type: 'string', description: 'The HTTP request ID' },
        value: { type: 'string', description: 'Assertion expression (e.g. "response.status == 200")' },
        enabled: { type: 'boolean', description: 'Whether the assertion is active (default: true)' },
      },
      required: ['httpId', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'updateHttpAssert',
    description: 'Update an existing assertion on an HTTP request.',
    parameters: {
      type: 'object',
      properties: {
        httpAssertId: { type: 'string', description: 'The assertion ID to update' },
        value: { type: 'string', description: 'New assertion expression' },
        enabled: { type: 'boolean', description: 'Whether the assertion is active' },
      },
      required: ['httpAssertId'],
      additionalProperties: false,
    },
  },
  {
    name: 'deleteHttpAssert',
    description: 'Delete an assertion from an HTTP request.',
    parameters: {
      type: 'object',
      properties: {
        httpAssertId: { type: 'string', description: 'The assertion ID to delete' },
      },
      required: ['httpAssertId'],
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
  const httpSearchParamCollection = useApiCollection(HttpSearchParamCollectionSchema);
  const httpHeaderCollection = useApiCollection(HttpHeaderCollectionSchema);
  const httpBodyRawCollection = useApiCollection(HttpBodyRawCollectionSchema);
  const httpAssertCollection = useApiCollection(HttpAssertCollectionSchema);
  const executionCollection = useApiCollection(NodeExecutionCollectionSchema);
  const flowCollection = useApiCollection(FlowCollectionSchema);

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
        httpSearchParamCollection,
        httpHeaderCollection,
        httpBodyRawCollection,
        httpAssertCollection,
        executionCollection,
      };

      const waitForFlowCompletion = async (): Promise<void> => {
        const POLL_INTERVAL = 500;
        const MAX_WAIT = 30_000;
        const INITIAL_DELAY = 500;
        let elapsed = 0;

        await new Promise((r) => setTimeout(r, INITIAL_DELAY));
        elapsed += INITIAL_DELAY;

        while (elapsed < MAX_WAIT) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL));
          elapsed += POLL_INTERVAL;

          const [flow] = await queryCollection((_) =>
            _.from({ item: flowCollection })
              .where((_) => eq(_.item.flowId, flowId))
              .findOne(),
          );
          if (flow && !flow.running) break;
        }
      };

      const toolContext: ToolExecutorContext = {
        collections,
        flowContext: currentFlowContext,
        transport,
        waitForFlowCompletion,
      };

      const userMessage: Message = {
        id: generateId(),
        role: 'user',
        content,
        timestamp: Date.now(),
      };

      const logger = new AgentLogger(currentFlowContext.flowId);
      logger.logSessionStart(currentFlowContext.flowId, content);

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
        isLoading: true,
        error: null,
      }));

      try {
        const systemPrompt = buildSystemPrompt(currentFlowContext);
        const tools = [...allToolSchemas, ...clientToolSchemas].map(formatToolAsOpenAI);

        logger.logSystemPrompt(systemPrompt, {
          nodes: currentFlowContext.nodes.length,
          edges: currentFlowContext.edges.length,
          variables: currentFlowContext.variables.length,
        });
        logger.logUserMessage(content);

        const openAIMessages: OpenAIMessage[] = [
          { role: 'system', content: systemPrompt },
          ...state.messages.map(messageToOpenAI),
          { role: 'user', content },
        ];

        logger.logApiRequest(MODEL, openAIMessages.length, true);
        let apiStart = performance.now();

        let response = await openai.chat.completions.create(
          {
            model: MODEL,
            messages: openAIMessages,
            tools,
            tool_choice: 'auto',
          },
          { signal: abortController.signal },
        );

        logger.logApiResponse(performance.now() - apiStart, response.choices[0]?.finish_reason, response.usage);
        let assistantMessage = response.choices[0]?.message;

        let validationRetries = 0;
        const MAX_VALIDATION_RETRIES = 2;

        do {
          // === Existing tool call loop ===
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

            for (const tc of toolCalls) {
              logger.logToolCallStart(tc.id, tc.name, tc.arguments);
            }

            const toolCallTimers = toolCalls.map(() => performance.now());
            const toolResults = await Promise.all(
              toolCalls.map((tc) => executeToolCall(tc, flowId, toolContext)),
            );

            for (let i = 0; i < toolResults.length; i++) {
              const tr = toolResults[i]!;
              const tc = toolCalls[i]!;
              const elapsed = performance.now() - toolCallTimers[i]!;
              logger.logToolCallEnd(
                tc.id,
                tc.name,
                elapsed,
                tr.error ?? safeStringify(tr.result),
                tr.error,
              );
            }

            // Apply layout and refresh context after mutations
            const hadMutations = toolResults.some((tr: ToolResult) => tr.isMutation && !tr.error);
            if (hadMutations) {
              // Query fresh data directly from collections to avoid stale React context
              await applyLayoutToFlow(flowId, nodeCollection, edgeCollection);

              // Refresh flow context so subsequent tool calls see newly created nodes
              toolContext.flowContext = {
                ...(await refreshFlowContext(flowId, {
                  nodeCollection,
                  edgeCollection,
                  variableCollection,
                  executionCollection,
                  nodeHttpCollection,
                  httpCollection,
                })),
                selectedNodeIds: selectedNodeIdsRef.current,
              };
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

            logger.logApiRequest(MODEL, openAIMessages.length, true);
            apiStart = performance.now();

            response = await openai.chat.completions.create(
              {
                model: MODEL,
                messages: openAIMessages,
                tools,
                tool_choice: 'auto',
              },
              { signal: abortController.signal },
            );

            logger.logApiResponse(performance.now() - apiStart, response.choices[0]?.finish_reason, response.usage);
            assistantMessage = response.choices[0]?.message;
          }

          // === Post-execution validation: check for orphan nodes ===
          if (validationRetries >= MAX_VALIDATION_RETRIES) break;

          const freshNodes = await queryCollection((_) =>
            _.from({ node: nodeCollection }).where((_) => eq(_.node.flowId, flowId)),
          );
          const freshEdges = await queryCollection((_) =>
            _.from({ edge: edgeCollection }).where((_) => eq(_.edge.flowId, flowId)),
          );

          const nodeInfos = freshNodes
            .filter((n) => n.nodeId != null)
            .map((n) => ({
              id: Ulid.construct(n.nodeId).toCanonical(),
              kind: NODE_KIND_NAMES[n.kind] ?? 'Unknown',
              name: n.name,
            }));
          const edgeInfos = freshEdges
            .filter((e) => e.edgeId != null)
            .map((e) => ({
              sourceId: Ulid.construct(e.sourceId).toCanonical(),
              targetId: Ulid.construct(e.targetId).toCanonical(),
            }));

          const orphans = detectOrphanNodes(nodeInfos, edgeInfos);
          logger.logValidation(orphans.length, orphans.map((n) => n.name));
          if (orphans.length === 0) break;

          validationRetries++;

          const orphanList = orphans
            .map((n) => `  - ${n.name} (ID: ${n.id}, Type: ${n.kind})`)
            .join('\n');

          // Add the assistant's text response to messages before injecting validation
          if (assistantMessage?.content) {
            openAIMessages.push({
              role: 'assistant',
              content: assistantMessage.content,
            });
          }

          openAIMessages.push({
            role: 'user',
            content:
              `FLOW VALIDATION FAILED: The following nodes are not reachable from ManualStart:\n${orphanList}\n\n` +
              `You MUST connect these nodes before responding. Use connectSequentialNodes or connectBranchingNodes.`,
          });

          logger.logApiRequest(MODEL, openAIMessages.length, true);
          apiStart = performance.now();

          response = await openai.chat.completions.create(
            { model: MODEL, messages: openAIMessages, tools, tool_choice: 'auto' },
            { signal: abortController.signal },
          );

          logger.logApiResponse(performance.now() - apiStart, response.choices[0]?.finish_reason, response.usage);
          assistantMessage = response.choices[0]?.message;
        } while (true);

        const finalMessage: Message = {
          id: generateId(),
          role: 'assistant',
          content: assistantMessage?.content ?? '',
          timestamp: Date.now(),
        };

        logger.logAssistantMessage(finalMessage.content);
        logger.logSessionEnd(true, false);

        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, finalMessage],
          isLoading: false,
        }));
      } catch (error) {
        // Ignore abort errors
        if (error instanceof Error && error.name === 'AbortError') {
          logger.logSessionEnd(false, true);
          setState((prev) => ({ ...prev, isLoading: false }));
          return;
        }
        logger.logError(error, 'sendMessage');
        logger.logSessionEnd(false, false);
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
    [flowId, transport, nodeCollection, edgeCollection, variableCollection, jsCollection, conditionCollection, forCollection, forEachCollection, nodeHttpCollection, httpCollection, httpSearchParamCollection, httpHeaderCollection, httpBodyRawCollection, httpAssertCollection, executionCollection, flowCollection, state.messages],
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
