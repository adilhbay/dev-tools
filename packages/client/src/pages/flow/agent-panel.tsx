import { FormEvent, use, useEffect, useMemo, useRef, useState } from 'react';
import { FiTrash2, FiX } from 'react-icons/fi';
import * as XF from '@xyflow/react';
import Markdown from 'react-markdown';
import { Button } from '@the-dev-tools/ui/button';
import { tw } from '@the-dev-tools/ui/tailwind-literal';
import { useAgentChat, type Message } from '~/features/agent';
import { FlowContext } from './context';

export const AgentPanel = () => {
  const { flowId, setAgentPanelOpen } = use(FlowContext);
  const selectedNodeIds = XF.useStore((s) =>
    s.nodes.filter((n) => n.selected).map((n) => n.id),
  );
  const { messages, isLoading, error, sendMessage, clearMessages, cancel } = useAgentChat({ flowId, selectedNodeIds });

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage(input.trim());
    setInput('');
  };

  return (
    <div className={tw`flex h-full flex-col bg-slate-950 font-mono text-sm text-slate-200`}>
      {/* Header */}
      <div className={tw`flex items-center gap-2 border-b border-slate-800 px-3 py-1.5`}>
        <div className={tw`flex flex-1 items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-400`}>
          Agent
          {selectedNodeIds.length > 0 && (
            <span className={tw`rounded bg-blue-900/50 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-blue-300`}>
              ● {selectedNodeIds.length} node{selectedNodeIds.length !== 1 ? 's' : ''} selected
            </span>
          )}
        </div>

        <Button
          className={tw`p-1`}
          onPress={clearMessages}
          variant='ghost dark'
          isDisabled={messages.length === 0}
        >
          <FiTrash2 className={tw`size-3.5 text-slate-500`} />
        </Button>

        <Button className={tw`p-1`} onPress={() => void setAgentPanelOpen?.(false)} variant='ghost dark'>
          <FiX className={tw`size-4 text-slate-500`} />
        </Button>
      </div>

      {/* Messages */}
      <div className={tw`flex-1 overflow-y-auto px-4 py-3`}>
        {messages.length === 0 ? (
          <div className={tw`text-slate-600`}>
            <p>Ask me to create or modify workflow nodes.</p>
            <p className={tw`mt-1 text-slate-700`}>
              e.g. "Create a JavaScript node that returns hello world"
            </p>
          </div>
        ) : (
          <div className={tw`space-y-2`}>
            {messages.map((message) => (
              <TerminalMessage key={message.id} message={message} />
            ))}
            {isLoading && (
              <div className={tw`flex items-center gap-2`}>
                <span className={tw`animate-pulse text-slate-500`}>... thinking</span>
                <button
                  type='button'
                  onClick={cancel}
                  className={tw`rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-700 hover:text-slate-300`}
                >
                  cancel
                </button>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        {error && <div className={tw`mt-2 text-red-400`}>{error}</div>}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className={tw`flex items-center gap-2 border-t border-slate-800 px-4 py-2`}>
        <span className={tw`text-green-400`}>&gt;</span>
        <input
          type='text'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Type a message...'
          disabled={isLoading}
          className={tw`flex-1 border-none bg-transparent text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none disabled:text-slate-500`}
        />
      </form>
    </div>
  );
};

const TerminalMessage = ({ message }: { message: Message }) => {
  if (message.role === 'user') {
    return (
      <div className={tw`flex gap-2`}>
        <span className={tw`text-green-400`}>&gt;</span>
        <span className={tw`text-slate-200`}>{message.content}</span>
      </div>
    );
  }

  if (message.role === 'tool') {
    return <ToolResultMessage content={message.content} />;
  }

  if (message.role === 'assistant' && message.toolCalls) {
    return (
      <div className={tw`space-y-1`}>
        {message.toolCalls.map((tc) => (
          <div key={tc.id} className={tw`flex gap-2`}>
            <span className={tw`text-yellow-400`}>$</span>
            <span className={tw`text-slate-400`}>{tc.name}</span>
          </div>
        ))}
      </div>
    );
  }

  if (!message.content) return null;

  return (
    <div className={tw`border-l border-slate-700 pl-3 text-slate-300`}>
      <Markdown
        components={{
          code: ({ children, className }) => {
            const isBlock = className?.startsWith('language-');
            return isBlock ? (
              <pre className={tw`my-1 overflow-x-auto rounded bg-slate-900 p-2 text-xs`}>
                <code>{children}</code>
              </pre>
            ) : (
              <code className={tw`rounded bg-slate-800 px-1 py-0.5 text-xs`}>{children}</code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          p: ({ children }) => <p className={tw`my-1`}>{children}</p>,
          ul: ({ children }) => <ul className={tw`my-1 list-disc pl-4`}>{children}</ul>,
          ol: ({ children }) => <ol className={tw`my-1 list-decimal pl-4`}>{children}</ol>,
          li: ({ children }) => <li className={tw`my-0.5`}>{children}</li>,
          h1: ({ children }) => <div className={tw`my-1 font-bold text-slate-200`}>{children}</div>,
          h2: ({ children }) => <div className={tw`my-1 font-bold text-slate-200`}>{children}</div>,
          h3: ({ children }) => <div className={tw`my-1 font-semibold text-slate-200`}>{children}</div>,
          a: ({ children, href }) => (
            <a href={href} className={tw`text-blue-400 underline`} target='_blank' rel='noreferrer'>
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className={tw`font-bold text-slate-200`}>{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className={tw`my-1 border-l-2 border-slate-600 pl-2 text-slate-400`}>{children}</blockquote>
          ),
        }}
      >
        {message.content}
      </Markdown>
    </div>
  );
};

const ToolResultMessage = ({ content }: { content: string }) => {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => {
    const maxLen = 80;
    if (content.length <= maxLen) return content;
    return content.slice(0, maxLen) + '...';
  }, [content]);

  const isLong = content.length > 80;

  return (
    <div className={tw`text-slate-600`}>
      <button
        type='button'
        onClick={() => isLong && setExpanded(!expanded)}
        className={tw`flex items-center gap-1 text-left hover:text-slate-500`}
      >
        <span className={tw`text-slate-700`}>←</span>
        <span className={tw`font-mono text-xs`}>
          {expanded ? content : preview}
        </span>
        {isLong && (
          <span className={tw`ml-1 text-[10px] text-slate-700`}>
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </button>
    </div>
  );
};
