/**
 * Tool Execution Loop - Extracted from use-agent-chat.ts to avoid code duplication.
 *
 * Handles the iterative execution of tool calls from the LLM until no more tool calls
 * are returned or the maximum iteration limit is reached.
 */

import type OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionMessage,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { executeToolCall, type ToolExecutorContext } from './tool-executor';
import type { Message, OpenAIMessage, ToolCall, ToolResult } from './types';
import { AgentTelemetry } from './telemetry';

/** JSON stringify with BigInt support */
const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

const formatToolCallSummary = (name: string, args: Record<string, unknown>): string => {
  const serialized = safeStringify(args);
  return `${name} ${serialized}`;
};

const generateId = () => crypto.randomUUID();

export interface ToolLoopConfig {
  maxIterations: number;
  openai: OpenAI;
  model: string;
  flowId: Uint8Array;
  toolContext: ToolExecutorContext;
  signal?: AbortSignal;
}

export interface ToolLoopCallbacks {
  onToolCalls: (message: Message) => void;
  onToolResults: (results: Message[]) => void;
  onLayoutApplied: () => Promise<void>;
  onIteration?: (iteration: number, toolNames: string[]) => void;
}

export interface ToolLoopResult {
  finalMessage: ChatCompletionMessage | null;
  messages: OpenAIMessage[];
  iterations: number;
  hitLimit: boolean;
}

/**
 * Execute the tool loop - iteratively process tool calls until the LLM stops making them
 * or the maximum iteration limit is reached.
 */
export async function executeToolLoop(
  initialResponse: ChatCompletion,
  openAIMessages: OpenAIMessage[],
  tools: ChatCompletionTool[],
  getToolChoice: () => 'auto' | 'required' | 'none',
  config: ToolLoopConfig,
  callbacks: ToolLoopCallbacks,
): Promise<ToolLoopResult> {
  const { maxIterations, openai, model, flowId, toolContext, signal } = config;
  const { onToolCalls, onToolResults, onLayoutApplied, onIteration } = callbacks;

  let response = initialResponse;
  let assistantMessage = response.choices[0]?.message ?? null;
  let iterations = 0;

  while (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
    iterations++;
    const iterationStart = performance.now();

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
      };
    }

    const toolCalls: ToolCall[] = assistantMessage.tool_calls.map((tc) => {
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

    const toolResults = await Promise.all(
      toolCalls.map((tc) => executeToolCall(tc, flowId, toolContext)),
    );

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

  return {
    finalMessage: assistantMessage,
    messages: openAIMessages,
    iterations,
    hitLimit: false,
  };
}
