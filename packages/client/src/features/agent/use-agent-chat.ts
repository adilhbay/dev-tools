import { eq } from '@tanstack/react-db';
import { Ulid } from 'id128';
import OpenAI from 'openai';
import { useCallback, useRef, useState } from 'react';
import { NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import {
  type AgentPhase,
  getToolsForPhase,
  PHASE_CONFIGS,
  PHASE_TRANSITION_TOOL_NAME,
  requiresUserConfirmation,
  validatePhaseTransition,
} from './agent-phases';
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
import { AgentTelemetry } from './telemetry';
import { executeToolLoop, DEFAULT_MAX_ITERATIONS } from './tool-loop';
import { executeToolCall, type Collections, type ToolExecutorContext, type PhaseTransitionResult } from './tool-executor';
import { useAgentPhase } from './use-agent-phase';
import {
  formatToolAsOpenAI,
  type AgentChatState,
  type FlowContextData,
  type Message,
  type OpenAIMessage,
  type ToolSchema,
  type CompletionResult,
} from './types';
import { extractGoal, buildGoalPrompt } from './completion-oracle';
import { planMutationToolSchema } from './plan-mutation-tool';

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

const formatToolCallSummary = (name: string, args: Record<string, unknown>): string => {
  const serialized = safeStringify(args);
  return `${name} ${serialized}`;
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
  // planMutation is added from plan-mutation-tool.ts
  planMutationToolSchema,
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
    name: 'applyWorkflowPatch',
    description:
      'Apply a structured set of edits to the workflow graph as a single patch.',
    parameters: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  op: { const: 'insertBefore' },
                  targetId: { type: 'string' },
                  sourceId: { type: 'string' },
                  node: {
                    oneOf: [
                      {
                        type: 'object',
                        properties: {
                          kind: { const: 'HTTP' },
                          name: { type: 'string' },
                          clientId: { type: 'string' },
                          method: {
                            type: 'string',
                            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
                          },
                          url: { type: 'string' },
                          httpId: { type: 'string' },
                        },
                        required: ['kind', 'name'],
                        additionalProperties: false,
                      },
                      {
                        type: 'object',
                        properties: {
                          kind: { const: 'JavaScript' },
                          name: { type: 'string' },
                          clientId: { type: 'string' },
                          code: { type: 'string' },
                        },
                        required: ['kind', 'name', 'code'],
                        additionalProperties: false,
                      },
                      {
                        type: 'object',
                        properties: {
                          kind: { const: 'Condition' },
                          name: { type: 'string' },
                          clientId: { type: 'string' },
                          condition: { type: 'string' },
                        },
                        required: ['kind', 'name', 'condition'],
                        additionalProperties: false,
                      },
                      {
                        type: 'object',
                        properties: {
                          kind: { const: 'For' },
                          name: { type: 'string' },
                          clientId: { type: 'string' },
                          iterations: { type: 'number' },
                          condition: { type: 'string' },
                          errorHandling: { type: 'string', enum: ['break', 'continue'] },
                        },
                        required: ['kind', 'name', 'iterations', 'condition', 'errorHandling'],
                        additionalProperties: false,
                      },
                      {
                        type: 'object',
                        properties: {
                          kind: { const: 'ForEach' },
                          name: { type: 'string' },
                          clientId: { type: 'string' },
                          path: { type: 'string' },
                          condition: { type: 'string' },
                          errorHandling: { type: 'string', enum: ['break', 'continue'] },
                        },
                        required: ['kind', 'name', 'path', 'condition', 'errorHandling'],
                        additionalProperties: false,
                      },
                    ],
                  },
                },
                required: ['op', 'targetId', 'node'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  op: { const: 'insertAfter' },
                  sourceId: { type: 'string' },
                  targetId: { type: 'string' },
                  node: {
                    oneOf: [
                      {
                        type: 'object',
                        properties: {
                          kind: { const: 'HTTP' },
                          name: { type: 'string' },
                          clientId: { type: 'string' },
                          method: {
                            type: 'string',
                            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
                          },
                          url: { type: 'string' },
                          httpId: { type: 'string' },
                        },
                        required: ['kind', 'name'],
                        additionalProperties: false,
                      },
                      {
                        type: 'object',
                        properties: {
                          kind: { const: 'JavaScript' },
                          name: { type: 'string' },
                          clientId: { type: 'string' },
                          code: { type: 'string' },
                        },
                        required: ['kind', 'name', 'code'],
                        additionalProperties: false,
                      },
                      {
                        type: 'object',
                        properties: {
                          kind: { const: 'Condition' },
                          name: { type: 'string' },
                          clientId: { type: 'string' },
                          condition: { type: 'string' },
                        },
                        required: ['kind', 'name', 'condition'],
                        additionalProperties: false,
                      },
                      {
                        type: 'object',
                        properties: {
                          kind: { const: 'For' },
                          name: { type: 'string' },
                          clientId: { type: 'string' },
                          iterations: { type: 'number' },
                          condition: { type: 'string' },
                          errorHandling: { type: 'string', enum: ['break', 'continue'] },
                        },
                        required: ['kind', 'name', 'iterations', 'condition', 'errorHandling'],
                        additionalProperties: false,
                      },
                      {
                        type: 'object',
                        properties: {
                          kind: { const: 'ForEach' },
                          name: { type: 'string' },
                          clientId: { type: 'string' },
                          path: { type: 'string' },
                          condition: { type: 'string' },
                          errorHandling: { type: 'string', enum: ['break', 'continue'] },
                        },
                        required: ['kind', 'name', 'path', 'condition', 'errorHandling'],
                        additionalProperties: false,
                      },
                    ],
                  },
                },
                required: ['op', 'sourceId', 'node'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  op: { const: 'connect' },
                  sourceId: { type: 'string' },
                  targetId: { type: 'string' },
                  sourceHandle: { type: 'string', enum: ['then', 'else', 'loop'] },
                },
                required: ['op', 'sourceId', 'targetId'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  op: { const: 'disconnect' },
                  edgeId: { type: 'string' },
                },
                required: ['op', 'edgeId'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  op: { const: 'deleteNode' },
                  nodeId: { type: 'string' },
                },
                required: ['op', 'nodeId'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  op: { const: 'updateNodeConfig' },
                  nodeId: { type: 'string' },
                  name: { type: 'string' },
                  position: {
                    type: 'object',
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' },
                    },
                    required: ['x', 'y'],
                    additionalProperties: false,
                  },
                },
                required: ['op', 'nodeId'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  op: { const: 'updateNodeCode' },
                  nodeId: { type: 'string' },
                  code: { type: 'string' },
                },
                required: ['op', 'nodeId', 'code'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  op: { const: 'updateHttpMethod' },
                  httpId: { type: 'string' },
                  method: {
                    type: 'string',
                    enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
                  },
                },
                required: ['op', 'httpId', 'method'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['ops'],
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

  // Use the extracted phase management hook
  const sessionId = Ulid.construct(flowId).toCanonical();
  const {
    currentPhase,
    currentPhaseRef,
    pendingTransition,
    transitionTo,
    requestTransition,
    confirmTransition: confirmPhaseTransition,
    cancelTransition,
    reset: resetPhase,
  } = useAgentPhase({
    sessionId,
    persist: true,
    flowId,
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

  // Ref for pending phase transition request (set by tool executor callback)
  const pendingPhaseTransitionRef = useRef<{ targetPhase: AgentPhase; reason: string } | null>(null);

  const sendMessage = useCallback(
    async (content: string) => {
      // Cancel any existing request
      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      // Clear any pending transition when user sends a new message
      cancelTransition();

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

      // Handler for phase transition tool
      const handlePhaseTransitionRequest = (
        targetPhase: AgentPhase,
        reason: string,
      ): PhaseTransitionResult => {
        const currentPhaseValue = currentPhaseRef.current;

        // Compute orphan count for validation
        const ctx = flowContextRef.current;
        const startNode = ctx.nodes.find((n) => n.kind === 'ManualStart');
        let orphanCount = 0;
        if (startNode) {
          const outgoing = new Map<string, string[]>();
          for (const e of ctx.edges) {
            const list = outgoing.get(e.sourceId) ?? [];
            list.push(e.targetId);
            outgoing.set(e.sourceId, list);
          }
          const reachable = new Set<string>();
          const queue = [startNode.id];
          while (queue.length > 0) {
            const nodeId = queue.shift()!;
            if (reachable.has(nodeId)) continue;
            reachable.add(nodeId);
            queue.push(...(outgoing.get(nodeId) ?? []));
          }
          orphanCount = ctx.nodes.filter(
            (n) => n.kind !== 'ManualStart' && !reachable.has(n.id),
          ).length;

          // Log orphan detection if any
          if (orphanCount > 0) {
            const orphanIds = ctx.nodes
              .filter((n) => n.kind !== 'ManualStart' && !reachable.has(n.id))
              .map((n) => n.id);
            AgentTelemetry.orphanDetected(flowId, orphanCount, orphanIds);
          }
        }

        // Validate the transition
        const validationResult = validatePhaseTransition(currentPhaseValue, targetPhase, {
          lastMessage: '',
          hasToolCalls: false,
          orphanCount,
        });

        if (!validationResult.valid) {
          return {
            approved: false,
            blockedReason: validationResult.reason,
          };
        }

        // Check if user confirmation is required
        const needsConfirmation = requiresUserConfirmation(currentPhaseValue, targetPhase);

        if (needsConfirmation) {
          // Store the request for later handling
          pendingPhaseTransitionRef.current = { targetPhase, reason };
          return {
            approved: false,
            requiresUserConfirmation: true,
          };
        }

        // Auto-approve the transition
        pendingPhaseTransitionRef.current = { targetPhase, reason };
        return {
          approved: true,
        };
      };

      const toolContext: ToolExecutorContext = {
        collections,
        flowContext: currentFlowContext,
        transport,
        currentPhase: currentPhaseRef.current,
        onPhaseTransitionRequest: handlePhaseTransitionRequest,
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
        // Extract goal from user message for completion-based termination
        const extractedGoal = extractGoal(content, currentFlowContext);
        AgentTelemetry.goalExtracted(flowId, extractedGoal);

        // Build system prompt with phase-specific additions and goal context
        const activePhase = currentPhaseRef.current;
        const baseSystemPrompt = buildSystemPrompt(currentFlowContext);
        const phaseConfig = PHASE_CONFIGS[activePhase];
        const goalPrompt = buildGoalPrompt(extractedGoal);
        const systemPrompt = baseSystemPrompt + phaseConfig.systemPromptAddition + goalPrompt;

        // Filter tools by current phase
        const allTools = [...allToolSchemas, ...clientToolSchemas];
        const phaseTools = getToolsForPhase(activePhase, allTools);
        const tools = phaseTools.map(formatToolAsOpenAI);

        const openAIMessages: OpenAIMessage[] = [
          { role: 'system', content: systemPrompt },
          ...state.messages.map(messageToOpenAI),
          { role: 'user', content },
        ];

        // Helper to determine tool_choice based on phase and state
        const getToolChoice = (): 'auto' | 'required' | 'none' => {
          if (tools.length === 0) return 'none';
          // In execute phase, force tool calls while there's work to do
          if (activePhase === 'execute') {
            const ctx = flowContextRef.current;
            const startNode = ctx.nodes.find((n) => n.kind === 'ManualStart');
            if (startNode) {
              // Quick orphan check
              const outgoing = new Map<string, string[]>();
              for (const e of ctx.edges) {
                const list = outgoing.get(e.sourceId) ?? [];
                list.push(e.targetId);
                outgoing.set(e.sourceId, list);
              }
              const reachable = new Set<string>();
              const queue = [startNode.id];
              while (queue.length > 0) {
                const nodeId = queue.shift()!;
                if (reachable.has(nodeId)) continue;
                reachable.add(nodeId);
                queue.push(...(outgoing.get(nodeId) ?? []));
              }
              const hasOrphans = ctx.nodes.some((n) => n.kind !== 'ManualStart' && !reachable.has(n.id));
              // Force tool calls if there are orphans (work to do)
              if (hasOrphans) return 'required';
            }
          }
          return 'auto';
        };

        // Initial API call
        const response = await openai.chat.completions.create(
          {
            model: MODEL,
            messages: openAIMessages,
            ...(tools.length > 0 ? { tools, tool_choice: getToolChoice() } : {}),
          },
          { signal: abortController.signal },
        );

        // Use the extracted tool loop with completion oracle
        const loopResult = await executeToolLoop(
          response,
          openAIMessages,
          tools,
          getToolChoice,
          {
            maxIterations: DEFAULT_MAX_ITERATIONS,
            openai,
            model: MODEL,
            flowId,
            toolContext,
            signal: abortController.signal,
            goal: extractedGoal,
            getLatestFlowContext: () => ({
              ...flowContextRef.current,
              selectedNodeIds: selectedNodeIdsRef.current,
            }),
          },
          {
            onToolCalls: (message) => {
              setState((prev) => ({
                ...prev,
                messages: [...prev.messages, message],
              }));
            },
            onToolResults: (results) => {
              setState((prev) => ({
                ...prev,
                messages: [...prev.messages, ...results],
              }));
            },
            onLayoutApplied: async () => {
              await applyLayoutToFlow(flowId, nodeCollection, edgeCollection);
            },
            onCorrection: (message) => {
              setState((prev) => ({
                ...prev,
                messages: [...prev.messages, message],
              }));
            },
          },
        );

        const { finalMessage, completionResult: loopCompletionResult } = loopResult;

        // Log completion status for debugging
        if (loopCompletionResult) {
          console.log('[Agent] Loop completed with status:', {
            complete: loopCompletionResult.complete,
            progress: Math.round(loopCompletionResult.progress * 100) + '%',
            reason: loopCompletionResult.reason,
          });
        }

        // Handle incomplete tasks - the completion oracle now handles corrections internally,
        // but we can show status to the user if the loop hit its limit
        if (loopResult.hitLimit && loopCompletionResult && !loopCompletionResult.complete) {
          console.warn('[Agent] Task incomplete after max iterations:', loopCompletionResult.missingCriteria);
        }

        // Handle pending phase transition
        if (pendingPhaseTransitionRef.current) {
          const { targetPhase } = pendingPhaseTransitionRef.current;
          const needsConfirmation = requiresUserConfirmation(currentPhaseRef.current, targetPhase);

          if (needsConfirmation) {
            requestTransition(currentPhaseRef.current, targetPhase);
          } else {
            transitionTo(targetPhase, 'tool_request');
          }

          pendingPhaseTransitionRef.current = null;
        }

        const finalMessageContent = finalMessage?.content ?? '';
        if (finalMessageContent) {
          const assistantFinalMessage: Message = {
            id: generateId(),
            role: 'assistant',
            content: finalMessageContent,
            timestamp: Date.now(),
          };

          setState((prev) => ({
            ...prev,
            messages: [...prev.messages, assistantFinalMessage],
            isLoading: false,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            isLoading: false,
          }));
        }
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
    [flowId, transport, nodeCollection, edgeCollection, variableCollection, jsCollection, conditionCollection, forCollection, forEachCollection, nodeHttpCollection, httpCollection, executionCollection, state.messages, cancelTransition, requestTransition, transitionTo],
  );

  const confirmTransition = useCallback((targetPhase: AgentPhase) => {
    confirmPhaseTransition(targetPhase);

    // If transitioning to execute, trigger the agent to continue
    if (targetPhase === 'execute') {
      void sendMessage('Proceed with execution.');
    }
  }, [confirmPhaseTransition, sendMessage]);

  const clearMessages = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setState({
      messages: [],
      isLoading: false,
      error: null,
    });
    // Reset phase
    resetPhase();
  }, [resetPhase]);

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setState((prev) => ({ ...prev, isLoading: false }));
  }, []);

  return {
    messages: state.messages,
    isLoading: state.isLoading,
    error: state.error,
    currentPhase,
    pendingTransition,
    confirmTransition,
    cancelTransition,
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

  // Handle correction messages as system messages for OpenAI
  if (message.role === 'correction') {
    return {
      role: 'system',
      content: message.content,
    };
  }

  return {
    role: message.role as 'user' | 'assistant' | 'system',
    content: message.content,
  };
};
