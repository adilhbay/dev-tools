import OpenAI from 'openai';
import { useCallback, useRef, useState } from 'react';
import { allToolSchemas } from '@the-dev-tools/spec/tools/schemas';
import {
  EdgeCollectionSchema,
  FlowVariableCollectionSchema,
  NodeCollectionSchema,
  NodeConditionCollectionSchema,
  NodeExecutionCollectionSchema,
  NodeForCollectionSchema,
  NodeForEachCollectionSchema,
  NodeJsCollectionSchema,
} from '@the-dev-tools/spec/tanstack-db/v1/api/flow';
import { useApiCollection } from '~/shared/api';
import { routes } from '~/shared/routes';
import { buildSystemPrompt, useFlowContext } from './context-builder';
import { executeToolCall, type Collections, type ToolExecutorContext } from './tool-executor';
import {
  formatToolAsOpenAI,
  type AgentChatState,
  type Message,
  type OpenAIMessage,
  type ToolCall,
} from './types';

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: VITE_OPENROUTER_API_KEY,
  dangerouslyAllowBrowser: true,
});

const MODEL = 'minimax/minimax-m2.1';

const generateId = () => crypto.randomUUID();

interface UseAgentChatOptions {
  flowId: Uint8Array;
}

export const useAgentChat = ({ flowId }: UseAgentChatOptions) => {
  const [state, setState] = useState<AgentChatState>({
    messages: [],
    isLoading: false,
    error: null,
  });

  const { transport } = routes.root.useRouteContext();
  const flowContext = useFlowContext(flowId);

  // Use ref to always access latest flowContext in callbacks
  const flowContextRef = useRef(flowContext);
  flowContextRef.current = flowContext;

  const nodeCollection = useApiCollection(NodeCollectionSchema);
  const edgeCollection = useApiCollection(EdgeCollectionSchema);
  const variableCollection = useApiCollection(FlowVariableCollectionSchema);
  const jsCollection = useApiCollection(NodeJsCollectionSchema);
  const conditionCollection = useApiCollection(NodeConditionCollectionSchema);
  const forCollection = useApiCollection(NodeForCollectionSchema);
  const forEachCollection = useApiCollection(NodeForEachCollectionSchema);
  const executionCollection = useApiCollection(NodeExecutionCollectionSchema);

  const sendMessage = useCallback(
    async (content: string) => {
      // Use ref to get latest flowContext at execution time
      const currentFlowContext = flowContextRef.current;

      // Build context fresh at execution time to avoid stale closures
      const collections: Collections = {
        nodeCollection,
        edgeCollection,
        variableCollection,
        jsCollection,
        conditionCollection,
        forCollection,
        forEachCollection,
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
        const tools = allToolSchemas.map(formatToolAsOpenAI);

        const openAIMessages: OpenAIMessage[] = [
          { role: 'system', content: systemPrompt },
          ...state.messages.map(messageToOpenAI),
          { role: 'user', content },
        ];

        let response = await openai.chat.completions.create({
          model: MODEL,
          messages: openAIMessages,
          tools,
          tool_choice: 'auto',
        });

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

          const toolResultMessages: Message[] = toolResults.map((tr) => ({
            id: generateId(),
            role: 'tool' as const,
            content: tr.error ?? JSON.stringify(tr.result),
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
              content: tr.error ?? JSON.stringify(tr.result),
            });
          }

          response = await openai.chat.completions.create({
            model: MODEL,
            messages: openAIMessages,
            tools,
            tool_choice: 'auto',
          });

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
        const errorMessage = error instanceof Error ? error.message : 'An error occurred';
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }));
      }
    },
    [flowId, transport, nodeCollection, edgeCollection, variableCollection, jsCollection, conditionCollection, forCollection, forEachCollection, executionCollection, state.messages],
  );

  const clearMessages = useCallback(() => {
    setState({
      messages: [],
      isLoading: false,
      error: null,
    });
  }, []);

  return {
    messages: state.messages,
    isLoading: state.isLoading,
    error: state.error,
    sendMessage,
    clearMessages,
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
