import { FormEvent, KeyboardEvent, use, useEffect, useMemo, useRef, useState } from 'react';
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = el.scrollHeight + 'px';
  };

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage(input.trim());
    setInput('');
    // Reset textarea height after clearing
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = '';
      }
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className={tw`flex h-full flex-col overflow-hidden bg-[var(--surface-1)] text-sm text-[var(--text-primary)]`}>
      {/* Header */}
      <div className={tw`mx-2 mt-2 flex items-center gap-2 rounded-[4px] border border-[var(--border)] bg-[var(--surface-4)] px-3 py-1.5`}>
        <div className={tw`flex flex-1 items-center gap-2 truncate text-sm font-medium tracking-[0.28px] text-[var(--text-primary)]`}>
          Agent
          {selectedNodeIds.length > 0 && (
            <span className={tw`rounded-[40px] border border-[var(--border)] bg-[var(--surface-5)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]`}>
              ● {selectedNodeIds.length} node{selectedNodeIds.length !== 1 ? 's' : ''} selected
            </span>
          )}
        </div>

        <Button
          className={tw`p-1 text-[var(--text-secondary)] hover:bg-[var(--surface-5)]`}
          onPress={clearMessages}
          variant='ghost'
          isDisabled={messages.length === 0}
        >
          <FiTrash2 className={tw`size-3.5`} />
        </Button>

        <Button
          className={tw`p-1 text-[var(--text-secondary)] hover:bg-[var(--surface-5)]`}
          onPress={() => void setAgentPanelOpen?.(false)}
          variant='ghost'
        >
          <FiX className={tw`size-4`} />
        </Button>
      </div>

      {/* Messages */}
      <div className={tw`flex-1 overflow-y-auto px-2 pb-2 pt-1`}>
        {messages.length === 0 ? (
          <div className={tw`text-sm text-[var(--text-muted)]`}>
            <p>Ask me to create or modify workflow nodes.</p>
            <p className={tw`mt-1 text-[var(--text-subtle)]`}>
              e.g. "Create a JavaScript node that returns hello world"
            </p>
          </div>
        ) : (
          <div className={tw`space-y-2 py-2`}>
            {messages.map((message) => (
              <TerminalMessage key={message.id} message={message} />
            ))}
            {isLoading && (
              <div className={tw`flex items-center gap-2`}>
                <span className={tw`animate-pulse text-[var(--text-muted)]`}>... thinking</span>
                <button
                  type='button'
                  onClick={cancel}
                  className={tw`rounded-[5px] border border-[var(--border-1)] bg-[var(--surface-4)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-5)]`}
                >
                  cancel
                </button>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        {error && <div className={tw`mt-2 text-[var(--text-error)]`}>{error}</div>}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className={tw`m-2 mt-0 flex items-end gap-2 rounded-[4px] border border-[var(--border-1)] bg-[var(--surface-4)] px-2.5 py-1.5`}>
        <span className={tw`py-1 text-[var(--brand-tertiary-2)]`}>&gt;</span>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoResize();
          }}
          onKeyDown={handleKeyDown}
          placeholder='Type a message...'
          disabled={isLoading}
          rows={1}
          className={tw`min-h-[48px] max-h-[120px] flex-1 resize-none border-none bg-transparent text-sm font-medium text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none disabled:text-[var(--text-subtle)]`}
        />
      </form>
    </div>
  );
};

const TerminalMessage = ({ message }: { message: Message }) => {
  if (message.role === 'user') {
    return (
      <div className={tw`flex gap-2`}>
        <span className={tw`text-[var(--brand-tertiary-2)]`}>&gt;</span>
        <span className={tw`rounded-[4px] border border-[var(--border-1)] bg-[var(--surface-4)] px-2 py-1 text-sm font-medium text-[var(--text-primary)]`}>
          {message.content}
        </span>
      </div>
    );
  }

  if (message.role === 'tool') {
    return <ToolResultMessage content={message.content} />;
  }

  if (message.role === 'assistant' && message.toolCalls) {
    return (
      <div className={tw`space-y-1 px-1`}>
        {message.toolCalls.map((tc) => (
          <div key={tc.id} className={tw`flex gap-2`}>
            <span className={tw`text-[var(--brand-400)]`}>$</span>
            <span className={tw`text-sm font-medium text-[var(--text-secondary)]`}>{tc.name}</span>
          </div>
        ))}
      </div>
    );
  }

  if (!message.content) return null;

  return (
    <div className={tw`space-y-1 px-1 text-[var(--text-secondary)]`}>
      <Markdown
        components={{
          code: ({ children, className }) => {
            const isBlock = className?.startsWith('language-');
            return isBlock ? (
              <pre className={tw`my-1 overflow-x-auto rounded-[4px] border border-[var(--border-1)] bg-[var(--surface-1)] p-2 text-xs text-[var(--text-secondary)]`}>
                <code>{children}</code>
              </pre>
            ) : (
              <code className={tw`rounded border border-[var(--border-1)] bg-[var(--surface-1)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--text-primary)]`}>{children}</code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          p: ({ children }) => <p className={tw`mb-1.5 text-sm leading-[1.4] text-[var(--text-primary)]`}>{children}</p>,
          ul: ({ children }) => <ul className={tw`my-1 list-disc space-y-0.5 pl-5`}>{children}</ul>,
          ol: ({ children }) => <ol className={tw`my-1 list-decimal space-y-0.5 pl-5`}>{children}</ol>,
          li: ({ children }) => <li className={tw`text-sm leading-[1.4] text-[var(--text-secondary)]`}>{children}</li>,
          h1: ({ children }) => <div className={tw`my-1 text-base font-semibold text-[var(--text-primary)]`}>{children}</div>,
          h2: ({ children }) => <div className={tw`my-1 text-[15px] font-semibold text-[var(--text-primary)]`}>{children}</div>,
          h3: ({ children }) => <div className={tw`my-1 text-sm font-semibold text-[var(--text-primary)]`}>{children}</div>,
          a: ({ children, href }) => (
            <a
              href={href}
              className={tw`text-[var(--brand-secondary)] underline hover:opacity-80`}
              target='_blank'
              rel='noreferrer'
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className={tw`font-semibold text-[var(--text-primary)]`}>{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className={tw`my-1 border-l-2 border-[var(--border-1)] bg-[var(--surface-4)] px-2 py-1 text-[var(--text-tertiary)]`}>
              {children}
            </blockquote>
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
    <div className={tw`rounded-[4px] border border-[var(--border-1)] bg-[var(--surface-4)] px-2 py-1 text-xs text-[var(--text-secondary)]`}>
      <button
        type='button'
        onClick={() => isLong && setExpanded(!expanded)}
        className={tw`flex items-center gap-1 text-left hover:text-[var(--text-muted)]`}
      >
        <span className={tw`text-[var(--text-muted)]`}>←</span>
        <span className={tw`font-mono text-xs text-[var(--text-secondary)]`}>
          {expanded ? content : preview}
        </span>
        {isLong && (
          <span className={tw`ml-1 text-[10px] text-[var(--text-muted)]`}>
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </button>
    </div>
  );
};
