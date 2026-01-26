import { FormEvent, use, useRef, useState } from 'react';
import { FiSend, FiTrash2, FiX } from 'react-icons/fi';
import { twJoin } from 'tailwind-merge';
import { Button } from '@the-dev-tools/ui/button';
import { tw } from '@the-dev-tools/ui/tailwind-literal';
import { useAgentChat, type Message } from '~/features/agent';
import { FlowContext } from './context';

export const AgentSidebar = () => {
  const { flowId, setSidebar } = use(FlowContext);
  const { messages, isLoading, error, sendMessage, clearMessages } = useAgentChat({ flowId });

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    sendMessage(input.trim());
    setInput('');
  };

  return (
    <div className={tw`flex h-full flex-col`}>
      <div className={tw`flex items-center gap-2 border-b border-slate-200 px-3 py-2`}>
        <div className={tw`flex-1 leading-6 font-semibold tracking-tight text-slate-800`}>
          AI Agent
        </div>

        <Button
          className={tw`p-1`}
          onPress={clearMessages}
          variant='ghost'
          isDisabled={messages.length === 0}
        >
          <FiTrash2 className={tw`size-4 text-slate-500`} />
        </Button>

        <Button className={tw`p-1`} onPress={() => void setSidebar?.(null)} variant='ghost'>
          <FiX className={tw`size-5 text-slate-500`} />
        </Button>
      </div>

      <div className={tw`flex-1 overflow-y-auto p-3`}>
        {messages.length === 0 ? (
          <div className={tw`text-center text-sm text-slate-500 mt-8`}>
            <p>Ask me to create or modify workflow nodes.</p>
            <p className={tw`mt-2 text-xs`}>
              Examples:
              <br />
              "Create a JavaScript node that returns hello world"
              <br />
              "Connect the new node to the start node"
            </p>
          </div>
        ) : (
          <div className={tw`space-y-3`}>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {isLoading && (
              <div className={tw`flex items-center gap-2 text-sm text-slate-500`}>
                <div className={tw`animate-pulse`}>Thinking...</div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        {error && (
          <div className={tw`mt-2 rounded bg-red-50 p-2 text-sm text-red-600`}>{error}</div>
        )}
      </div>

      <form onSubmit={handleSubmit} className={tw`border-t border-slate-200 p-3`}>
        <div className={tw`flex gap-2`}>
          <input
            type='text'
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='Ask me anything...'
            disabled={isLoading}
            className={tw`flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none disabled:bg-slate-50`}
          />
          <Button
            type='submit'
            variant='primary'
            isDisabled={!input.trim() || isLoading}
            className={tw`px-3`}
          >
            <FiSend className={tw`size-4`} />
          </Button>
        </div>
      </form>
    </div>
  );
};

interface MessageBubbleProps {
  message: Message;
}

const MessageBubble = ({ message }: MessageBubbleProps) => {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isAssistantWithTools = message.role === 'assistant' && message.toolCalls;

  if (isTool) {
    return (
      <div className={tw`text-xs text-slate-500 pl-2 border-l-2 border-slate-200`}>
        <span className={tw`font-mono`}>Tool result</span>
      </div>
    );
  }

  if (isAssistantWithTools) {
    return (
      <div className={tw`space-y-1`}>
        {message.toolCalls?.map((tc) => (
          <div
            key={tc.id}
            className={tw`text-xs bg-slate-100 rounded px-2 py-1 text-slate-600`}
          >
            <span className={tw`font-semibold`}>{tc.name}</span>
          </div>
        ))}
      </div>
    );
  }

  if (!message.content) return null;

  return (
    <div className={twJoin(tw`flex`, isUser ? tw`justify-end` : tw`justify-start`)}>
      <div
        className={twJoin(
          tw`max-w-[85%] rounded-lg px-3 py-2 text-sm`,
          isUser
            ? tw`bg-blue-600 text-white`
            : tw`bg-slate-100 text-slate-800`,
        )}
      >
        {message.content}
      </div>
    </div>
  );
};
