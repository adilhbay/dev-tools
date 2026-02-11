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
import { buildCompactStateSummary, buildSystemPrompt, buildXmlValidationMessage, detectDeadEndNodes, detectOrphanNodes, refreshFlowContext, useFlowContext } from './context-builder';
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

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

interface StreamedMessage {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface StreamMeta {
  finishReason: string | null | undefined;
  usage: unknown;
}

/**
 * Consumes an OpenAI streaming response, accumulating content and tool calls.
 * Calls `onContent` with the accumulated text after every content delta so the
 * UI can render tokens in real-time.
 */
const consumeStream = async (
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  onContent: (accumulated: string) => void,
): Promise<{ message: StreamedMessage; meta: StreamMeta }> => {
  let content = '';
  let hasContent = false;
  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: string | null | undefined = null;
  let usage: unknown = undefined;

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) {
      // Final chunk may carry only usage data
      if (chunk.usage) usage = chunk.usage;
      continue;
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;

    const delta = choice.delta;
    if (delta?.content) {
      content += delta.content;
      hasContent = true;
      onContent(content);
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const existing = toolCallsMap.get(tc.index);
        if (existing) {
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        } else {
          toolCallsMap.set(tc.index, {
            id: tc.id ?? '',
            name: tc.function?.name ?? '',
            arguments: tc.function?.arguments ?? '',
          });
        }
      }
    }
  }

  const toolCalls =
    toolCallsMap.size > 0
      ? Array.from(toolCallsMap.entries())
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          }))
      : undefined;

  return {
    message: {
      content: hasContent ? content : null,
      tool_calls: toolCalls,
    },
    meta: { finishReason, usage },
  };
};

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
    name: 'inspectNode',
    description:
      'Inspect a node\'s full config and execution state. Returns type-specific config (HTTP: url/method/headers/params/body/assertions, JS: code, Condition: expression, For: iterations/condition, ForEach: path/condition) plus execution state/error. ' +
      'Set includeOutput: true to also get execution input/output payloads (can be large).',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The node ID to inspect' },
        includeOutput: {
          type: 'boolean',
          description: 'Include execution input/output payloads (default: false). Only use when you need to see actual request/response data.',
        },
      },
      required: ['nodeId'],
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
    name: 'configureHttp',
    description:
      'Declaratively configure an HTTP node. Provide desired state — only include fields to change. ' +
      'Arrays (headers, searchParams, assertions) replace the entire existing set when provided. ' +
      'Set body to null to clear it.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The node ID (not httpId) of the HTTP node to configure' },
        method: {
          type: 'string',
          description: 'HTTP method',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        },
        url: { type: 'string', description: 'Request URL' },
        headers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              enabled: { type: 'boolean' },
            },
            required: ['key'],
          },
          description: 'Replaces all existing headers',
        },
        searchParams: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              enabled: { type: 'boolean' },
            },
            required: ['key'],
          },
          description: 'Replaces all existing query parameters',
        },
        body: {
          type: ['string', 'null'],
          description: 'Raw body content (JSON string). Set to null to clear.',
        },
        assertions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              enabled: { type: 'boolean' },
            },
            required: ['value'],
          },
          description: 'Replaces all existing assertions',
        },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'connectChain',
    description:
      'PREFERRED tool for ALL node connections. Connects nodes into a chain with optional parallel fan-out. ' +
      'Flat array: sequential chain. Nested array: parallel branches. ' +
      'Example: ["Start",["A","B"],"End"] creates Start→A, Start→B, A→End, B→End. ' +
      'Works for ALL node types. For branching nodes (Condition, For, ForEach), auto-applies "then" handle by default. ' +
      'Use sourceHandle "else" or "loop" to override for non-default branches.',
    parameters: {
      type: 'object',
      properties: {
        nodeIds: {
          type: 'array',
          items: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          description:
            'Ordered list of node IDs. Use nested arrays for fan-out/fan-in: ' +
            '["A","B","C"] chains A→B→C. ' +
            '["A",["B","C"],"D"] fans out A→B, A→C then fans in B→D, C→D. ' +
            'Minimum 2 elements. No consecutive nested arrays.',
        },
        sourceHandle: {
          type: 'string',
          enum: ['then', 'else', 'loop'],
          description:
            'Handle for branching source nodes. Defaults to "then". ' +
            'Use "else" for Condition false-branch, "loop" for For/ForEach loop-body.',
        },
      },
      required: ['nodeIds'],
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
    streamingContent: '',
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

        const updateStreamingContent = (content: string) => {
          setState((prev) => ({ ...prev, streamingContent: content }));
        };

        let stream = await openai.chat.completions.create(
          {
            model: MODEL,
            messages: openAIMessages,
            tools,
            tool_choice: 'auto',
            stream: true,
          },
          { signal: abortController.signal },
        );

        let { message: streamedMsg, meta } = await consumeStream(stream, updateStreamingContent);
        setState((prev) => ({ ...prev, streamingContent: '' }));

        logger.logApiResponse(performance.now() - apiStart, meta.finishReason, meta.usage);
        let assistantMessage = streamedMsg;

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

            const toolCallTimers: number[] = [];
            const toolResults: ToolResult[] = [];
            for (const tc of toolCalls) {
              toolCallTimers.push(performance.now());
              toolResults.push(await executeToolCall(tc, flowId, toolContext));
            }

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

              // Inject updated flow state so LLM sees current topology
              const stateSummary = buildCompactStateSummary(toolContext.flowContext);
              openAIMessages.push({ role: 'system', content: stateSummary });
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

            // Collapse identical error messages to reduce noise
            const errorGroups = new Map<string, { count: number; firstId: string }>();
            for (const tr of toolResults) {
              if (tr.error) {
                const existing = errorGroups.get(tr.error);
                if (existing) {
                  existing.count++;
                } else {
                  errorGroups.set(tr.error, { count: 1, firstId: tr.toolCallId });
                }
              }
            }

            for (const tr of toolResults) {
              const errorGroup = tr.error ? errorGroups.get(tr.error) : undefined;
              let content: string;
              if (tr.error && errorGroup && errorGroup.count > 1) {
                if (tr.toolCallId === errorGroup.firstId) {
                  content = `${tr.error} (this error occurred ${errorGroup.count} times in this batch)`;
                } else {
                  content = `Same error as ${errorGroup.firstId}`;
                }
              } else {
                content = tr.error ?? safeStringify(tr.result);
              }
              openAIMessages.push({
                role: 'tool',
                tool_call_id: tr.toolCallId,
                content,
              });
            }

            logger.logApiRequest(MODEL, openAIMessages.length, true);
            apiStart = performance.now();

            stream = await openai.chat.completions.create(
              {
                model: MODEL,
                messages: openAIMessages,
                tools,
                tool_choice: 'auto',
                stream: true,
              },
              { signal: abortController.signal },
            );

            ({ message: streamedMsg, meta } = await consumeStream(stream, updateStreamingContent));
            setState((prev) => ({ ...prev, streamingContent: '' }));

            logger.logApiResponse(performance.now() - apiStart, meta.finishReason, meta.usage);
            assistantMessage = streamedMsg;
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
          const deadEnds = orphans.length === 0 ? detectDeadEndNodes(nodeInfos, edgeInfos) : [];
          logger.logValidation(orphans.length, orphans.map((n) => n.name));
          if (orphans.length === 0 && deadEnds.length === 0) break;

          validationRetries++;

          const validationContent = buildXmlValidationMessage(orphans, deadEnds);

          // Add the assistant's text response to messages before injecting validation
          if (assistantMessage?.content) {
            openAIMessages.push({
              role: 'assistant',
              content: assistantMessage.content,
            });
          }

          openAIMessages.push({
            role: 'user',
            content: validationContent,
          });

          logger.logApiRequest(MODEL, openAIMessages.length, true);
          apiStart = performance.now();

          stream = await openai.chat.completions.create(
            { model: MODEL, messages: openAIMessages, tools, tool_choice: 'auto', stream: true },
            { signal: abortController.signal },
          );

          ({ message: streamedMsg, meta } = await consumeStream(stream, updateStreamingContent));
          setState((prev) => ({ ...prev, streamingContent: '' }));

          logger.logApiResponse(performance.now() - apiStart, meta.finishReason, meta.usage);
          assistantMessage = streamedMsg;
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
          setState((prev) => ({ ...prev, isLoading: false, streamingContent: '' }));
          return;
        }
        logger.logError(error, 'sendMessage');
        logger.logSessionEnd(false, false);
        const errorMessage = error instanceof Error ? error.message : 'An error occurred';
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
          streamingContent: '',
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
      streamingContent: '',
    });
  }, []);

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setState((prev) => ({ ...prev, isLoading: false, streamingContent: '' }));
  }, []);

  return {
    messages: state.messages,
    isLoading: state.isLoading,
    error: state.error,
    streamingContent: state.streamingContent,
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
