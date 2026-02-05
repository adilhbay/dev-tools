/**
 * Agent Telemetry - Centralized logging for agent events.
 *
 * Provides structured logging for:
 * - Phase transitions
 * - Tool iterations
 * - Tool errors
 * - Orphan node detection
 */

import type { AgentPhase } from './agent-phases';

export type PhaseTransitionTrigger = 'user_confirm' | 'auto' | 'tool_request' | 'reset';

export interface PhaseTransitionEvent {
  type: 'phase';
  flowId: string;
  from: AgentPhase;
  to: AgentPhase;
  trigger: PhaseTransitionTrigger;
  timestamp: number;
}

export interface ToolIterationEvent {
  type: 'iteration';
  flowId: string;
  iteration: number;
  tools: string[];
  durationMs: number;
  timestamp: number;
}

export interface ToolErrorEvent {
  type: 'error';
  flowId: string;
  toolName: string;
  error: string;
  timestamp: number;
}

export interface OrphanDetectedEvent {
  type: 'orphan';
  flowId: string;
  count: number;
  nodeIds: string[];
  timestamp: number;
}

export type AgentEvent =
  | PhaseTransitionEvent
  | ToolIterationEvent
  | ToolErrorEvent
  | OrphanDetectedEvent;

const formatFlowId = (flowId: Uint8Array): string => {
  // Convert first 8 bytes to hex for a readable identifier
  const hex = Array.from(flowId.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
};

/**
 * Agent telemetry utilities for logging agent events.
 *
 * Currently logs to console with structured data.
 * Can be extended to send to analytics services.
 */
export const AgentTelemetry = {
  /**
   * Log a phase transition event.
   */
  phaseTransition: (
    flowId: Uint8Array,
    from: AgentPhase,
    to: AgentPhase,
    trigger: PhaseTransitionTrigger,
  ): void => {
    const event: PhaseTransitionEvent = {
      type: 'phase',
      flowId: formatFlowId(flowId),
      from,
      to,
      trigger,
      timestamp: Date.now(),
    };
    console.log('[Agent]', event);
  },

  /**
   * Log a tool iteration event.
   */
  toolIteration: (
    flowId: Uint8Array,
    iteration: number,
    tools: string[],
    durationMs: number,
  ): void => {
    const event: ToolIterationEvent = {
      type: 'iteration',
      flowId: formatFlowId(flowId),
      iteration,
      tools,
      durationMs: Math.round(durationMs),
      timestamp: Date.now(),
    };
    console.log('[Agent]', event);
  },

  /**
   * Log a tool error event.
   */
  toolError: (flowId: Uint8Array, toolName: string, error: string): void => {
    const event: ToolErrorEvent = {
      type: 'error',
      flowId: formatFlowId(flowId),
      toolName,
      error,
      timestamp: Date.now(),
    };
    console.error('[Agent]', event);
  },

  /**
   * Log an orphan node detection event.
   */
  orphanDetected: (flowId: Uint8Array, count: number, nodeIds: string[]): void => {
    const event: OrphanDetectedEvent = {
      type: 'orphan',
      flowId: formatFlowId(flowId),
      count,
      nodeIds,
      timestamp: Date.now(),
    };
    console.warn('[Agent]', event);
  },
};
