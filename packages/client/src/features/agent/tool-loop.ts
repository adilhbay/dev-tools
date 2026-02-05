/**
 * Tool Execution Loop - Extracted from use-agent-chat.ts to avoid code duplication.
 *
 * Handles the iterative execution of tool calls from the LLM until the goal is complete
 * or the maximum iteration limit is reached.
 *
 * KEY CHANGE: Loop terminates based on completion oracle, not LLM behavior.
 * If the LLM stops calling tools but the goal isn't complete, we inject a correction
 * and force it to continue.
 */

import type OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionMessage,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { executeToolCall, type ToolExecutorContext } from './tool-executor';
import type {
  Message,
  OpenAIMessage,
  ToolCall,
  ToolResult,
  ExtractedGoal,
  CompletionResult,
  FlowContextData,
} from './types';
import { AgentTelemetry } from './telemetry';
import { checkCompletion, generateCorrectionMessage } from './completion-oracle';

/** JSON stringify with BigInt support */
const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

const formatToolCallSummary = (name: string, args: Record<string, unknown>): string => {
  const serialized = safeStringify(args);
  return `${name} ${serialized}`;
};

const generateId = () => crypto.randomUUID();

/** Default max iterations (reduced from 20 to 10 for tighter budgets) */
export const DEFAULT_MAX_ITERATIONS = 10;

export interface ToolLoopConfig {
  maxIterations: number;
  openai: OpenAI;
  model: string;
  flowId: Uint8Array;
  toolContext: ToolExecutorContext;
  signal?: AbortSignal;
  /** Goal for completion-based termination */
  goal?: ExtractedGoal;
  /** Callback to get fresh flow context (for completion checks) */
  getLatestFlowContext?: () => FlowContextData;
}

export interface ToolLoopCallbacks {
  onToolCalls: (message: Message) => void;
  onToolResults: (results: Message[]) => void;
  onLayoutApplied: () => Promise<void>;
  onIteration?: (iteration: number, toolNames: string[]) => void;
  /** Called when completion is checked */
  onCompletionCheck?: (result: CompletionResult) => void;
  /** Called when a correction is injected */
  onCorrection?: (message: Message) => void;
}

export interface ToolLoopResult {
  finalMessage: ChatCompletionMessage | null;
  messages: OpenAIMessage[];
  iterations: number;
  hitLimit: boolean;
  /** Completion result from the oracle */
  completionResult?: CompletionResult;
  /** All tool results collected during the loop */
  allToolResults: ToolResult[];
}

/**
 * Execute the tool loop - iteratively process tool calls until the goal is complete
 * or the maximum iteration limit is reached.
 *
 * KEY BEHAVIOR:
 * - If goal is provided, loop uses completion oracle to determine when to stop
 * - If LLM stops calling tools but goal isn't complete, injects correction and continues
 * - Without goal, falls back to legacy behavior (stop when LLM stops)
 */
export async function executeToolLoop(
  initialResponse: ChatCompletion,
  openAIMessages: OpenAIMessage[],
  tools: ChatCompletionTool[],
  getToolChoice: () => 'auto' | 'required' | 'none',
  config: ToolLoopConfig,
  callbacks: ToolLoopCallbacks,
): Promise<ToolLoopResult> {
  const {
    maxIterations,
    openai,
    model,
    flowId,
    toolContext,
    signal,
    goal,
    getLatestFlowContext,
  } = config;
  const {
    onToolCalls,
    onToolResults,
    onLayoutApplied,
    onIteration,
    onCompletionCheck,
    onCorrection,
  } = callbacks;

  let response = initialResponse;
  let assistantMessage = response.choices[0]?.message ?? null;
  let iterations = 0;
  const allToolResults: ToolResult[] = [];
  let completionResult: CompletionResult | undefined;
  let consecutiveCorrectionCount = 0;
  const MAX_CONSECUTIVE_CORRECTIONS = 3;

  // Main loop: continue while not complete and within budget
  while (iterations <= maxIterations) {
    // Check completion if we have a goal
    if (goal && getLatestFlowContext) {
      const freshContext = getLatestFlowContext();
      completionResult = checkCompletion(goal, freshContext, allToolResults);
      onCompletionCheck?.(completionResult);
      AgentTelemetry.completionCheck(flowId, completionResult);

      // Exit if goal is complete
      if (completionResult.complete) {
        return {
          finalMessage: assistantMessage,
          messages: openAIMessages,
          iterations,
          hitLimit: false,
          completionResult,
          allToolResults,
        };
      }
    }

    // Check if LLM stopped calling tools
    const hasToolCalls = assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0;

    if (!hasToolCalls) {
      // LLM stopped but goal not complete
      if (goal && completionResult && !completionResult.complete) {
        consecutiveCorrectionCount++;

        // Safety: prevent infinite correction loops
        if (consecutiveCorrectionCount >= MAX_CONSECUTIVE_CORRECTIONS) {
          console.warn('Max consecutive corrections reached, exiting loop');
          AgentTelemetry.loopCorrection(flowId, iterations, 'max_corrections_reached');
          return {
            finalMessage: assistantMessage,
            messages: openAIMessages,
            iterations,
            hitLimit: false,
            completionResult,
            allToolResults,
          };
        }

        // Inject correction message
        const correctionText = generateCorrectionMessage(goal, completionResult);
        AgentTelemetry.loopCorrection(flowId, iterations, completionResult.reason);

        const correctionMessage: Message = {
          id: generateId(),
          role: 'correction',
          content: correctionText,
          timestamp: Date.now(),
        };
        onCorrection?.(correctionMessage);

        // Add to OpenAI messages as system message
        openAIMessages.push({
          role: 'system',
          content: correctionText,
        });

        // Force another API call with required tool_choice
        response = await openai.chat.completions.create(
          {
            model,
            messages: openAIMessages,
            ...(tools.length > 0 ? { tools, tool_choice: 'required' } : {}),
          },
          { signal },
        );

        assistantMessage = response.choices[0]?.message ?? null;
        iterations++;
        continue;
      }

      // No goal or legacy mode: stop when LLM stops
      return {
        finalMessage: assistantMessage,
        messages: openAIMessages,
        iterations,
        hitLimit: false,
        completionResult,
        allToolResults,
      };
    }

    // Reset correction counter when LLM makes tool calls
    consecutiveCorrectionCount = 0;

    iterations++;
    const iterationStart = performance.now();

    // Check iteration limit
    if (iterations > maxIterations) {
      AgentTelemetry.toolIteration(
        flowId,
        iterations,
        ['MAX_ITERATIONS_EXCEEDED'],
        0,
      );
      console.warn('Agent reached maximum tool iterations, breaking loop');
      return {
        finalMessage: assistantMessage,
        messages: openAIMessages,
        iterations,
        hitLimit: true,
        completionResult,
        allToolResults,
      };
    }

    const toolCalls: ToolCall[] = assistantMessage.tool_calls!.map((tc) => {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: args,
        summary: formatToolCallSummary(tc.function.name, args),
      };
    });

    const toolNames = toolCalls.map((tc) => tc.name);
    onIteration?.(iterations, toolNames);

    const toolMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: assistantMessage.content ?? '',
      toolCalls,
      timestamp: Date.now(),
    };

    onToolCalls(toolMessage);

    // Execute tool calls with fresh context
    const currentToolContext = getLatestFlowContext
      ? { ...toolContext, flowContext: getLatestFlowContext() }
      : toolContext;

    const toolResults = await Promise.all(
      toolCalls.map((tc) => executeToolCall(tc, flowId, currentToolContext)),
    );

    // Collect all results for completion checking
    allToolResults.push(...toolResults);

    // Log any tool errors
    for (const tr of toolResults) {
      if (tr.error) {
        const toolCall = toolCalls.find((tc) => tc.id === tr.toolCallId);
        AgentTelemetry.toolError(flowId, toolCall?.name ?? 'unknown', tr.error);
      }
    }

    // Apply layout after mutations
    const hadMutations = toolResults.some((tr: ToolResult) => tr.isMutation && !tr.error);
    if (hadMutations) {
      await onLayoutApplied();
    }

    const toolResultMessages: Message[] = toolResults.map((tr) => ({
      id: generateId(),
      role: 'tool' as const,
      content: tr.error ?? safeStringify(tr.result),
      toolCallId: tr.toolCallId,
      timestamp: Date.now(),
    }));

    onToolResults(toolResultMessages);

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

    const iterationDuration = performance.now() - iterationStart;
    AgentTelemetry.toolIteration(flowId, iterations, toolNames, iterationDuration);

    // Re-evaluate tool_choice after each tool execution (orphan state may have changed)
    const toolChoice = getToolChoice();
    response = await openai.chat.completions.create(
      {
        model,
        messages: openAIMessages,
        ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
      },
      { signal },
    );

    assistantMessage = response.choices[0]?.message ?? null;
  }

  // Should not reach here normally
  return {
    finalMessage: assistantMessage,
    messages: openAIMessages,
    iterations,
    hitLimit: true,
    completionResult,
    allToolResults,
  };
}
