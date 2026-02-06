/** JSON stringify with BigInt support */
const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/** Truncate a string to maxLen, appending '...[truncated]' if needed */
const truncate = (s: string, maxLen = 2048): string =>
  s.length <= maxLen ? s : s.slice(0, maxLen) + '...[truncated]';

interface AgentLogIpc {
  write: (fileName: string, jsonLine: string) => void;
  cleanup: () => void;
}

interface LogEntry {
  ts: string;
  event: string;
  sessionId: string;
  [key: string]: unknown;
}

/** Get the agentLog IPC bridge if running inside Electron, null otherwise */
const getAgentLogIpc = (): AgentLogIpc | null => {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const electron = (window as any).electron as { agentLog?: AgentLogIpc } | undefined;
  return electron?.agentLog ?? null;
};

/**
 * JSONL logger for agent conversations.
 * Writes to local files via Electron IPC. Silent no-op when running outside Electron.
 */
export class AgentLogger {
  private fileName: string;
  private sessionId: string;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionStart: number;
  private ipc: AgentLogIpc | null;

  constructor(flowId: string) {
    this.sessionId = crypto.randomUUID();
    this.sessionStart = performance.now();
    this.ipc = getAgentLogIpc();
    const shortFlowId = flowId.slice(0, 8);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.fileName = `agent-${shortFlowId}-${ts}-${this.sessionId.slice(0, 8)}.jsonl`;
  }

  private write(entry: LogEntry) {
    if (!this.ipc) return;
    this.buffer.push(safeStringify(entry));
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 100);
    }
  }

  private flush() {
    if (!this.ipc || this.buffer.length === 0) return;
    const batch = this.buffer.join('\n') + '\n';
    this.buffer = [];
    this.ipc.write(this.fileName, batch);
  }

  // --- Event methods ---

  logSessionStart(flowId: string, messageContent: string) {
    this.write({
      ts: new Date().toISOString(),
      event: 'session_start',
      sessionId: this.sessionId,
      flowId,
      userMessagePreview: truncate(messageContent, 500),
    });
  }

  logSessionEnd(success: boolean, aborted: boolean) {
    this.write({
      ts: new Date().toISOString(),
      event: 'session_end',
      sessionId: this.sessionId,
      success,
      aborted,
      durationMs: Math.round(performance.now() - this.sessionStart),
    });
    // Flush synchronously on close
    this.close();
  }

  logSystemPrompt(prompt: string, contextStats: { nodes: number; edges: number; variables: number }) {
    this.write({
      ts: new Date().toISOString(),
      event: 'system_prompt',
      sessionId: this.sessionId,
      promptLength: prompt.length,
      contextStats,
    });
  }

  logUserMessage(content: string) {
    this.write({
      ts: new Date().toISOString(),
      event: 'user_message',
      sessionId: this.sessionId,
      content: truncate(content),
    });
  }

  logAssistantMessage(content: string) {
    this.write({
      ts: new Date().toISOString(),
      event: 'assistant_message',
      sessionId: this.sessionId,
      content: truncate(content),
    });
  }

  logApiRequest(model: string, messageCount: number, hasTools: boolean) {
    this.write({
      ts: new Date().toISOString(),
      event: 'api_request',
      sessionId: this.sessionId,
      model,
      messageCount,
      hasTools,
    });
  }

  logApiResponse(
    latencyMs: number,
    finishReason: string | null | undefined,
    usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined,
  ) {
    this.write({
      ts: new Date().toISOString(),
      event: 'api_response',
      sessionId: this.sessionId,
      latencyMs: Math.round(latencyMs),
      finishReason: finishReason ?? 'unknown',
      usage: usage ?? null,
    });
  }

  logToolCallStart(toolCallId: string, toolName: string, args: Record<string, unknown>) {
    this.write({
      ts: new Date().toISOString(),
      event: 'tool_call_start',
      sessionId: this.sessionId,
      toolCallId,
      toolName,
      args: truncate(safeStringify(args)),
    });
  }

  logToolCallEnd(toolCallId: string, toolName: string, durationMs: number, result: string, error?: string) {
    this.write({
      ts: new Date().toISOString(),
      event: 'tool_call_end',
      sessionId: this.sessionId,
      toolCallId,
      toolName,
      durationMs: Math.round(durationMs),
      result: truncate(result),
      error: error ?? undefined,
    });
  }

  logValidation(orphanCount: number, orphanNames: string[]) {
    this.write({
      ts: new Date().toISOString(),
      event: 'validation',
      sessionId: this.sessionId,
      orphanCount,
      orphanNames,
    });
  }

  logError(error: unknown, phase: string) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    this.write({
      ts: new Date().toISOString(),
      event: 'error',
      sessionId: this.sessionId,
      message,
      stack,
      phase,
    });
  }

  /** Flush remaining buffer immediately */
  close() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
