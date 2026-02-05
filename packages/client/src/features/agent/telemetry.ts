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
import type { GoalIntent, CompletionResult, ExtractedGoal } from './types';

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

export interface GoalExtractedEvent {
  type: 'goal';
  flowId: string;
  intent: GoalIntent;
  confidence: number;
  targets?: string[];
  timestamp: number;
}

export interface CompletionCheckEvent {
  type: 'completion';
  flowId: string;
  complete: boolean;
  progress: number;
  reason: string;
  missingCriteria?: string[];
  timestamp: number;
}

export interface LoopCorrectionEvent {
  type: 'correction';
  flowId: string;
  iteration: number;
  reason: string;
  timestamp: number;
}

export interface PlanMutationEvent {
  type: 'planMutation';
  flowId: string;
  action: string;
  targetName: string;
  approved: boolean;
  error?: string;
  timestamp: number;
}

export type AgentEvent =
  | PhaseTransitionEvent
  | ToolIterationEvent
  | ToolErrorEvent
  | OrphanDetectedEvent
  | GoalExtractedEvent
  | CompletionCheckEvent
  | LoopCorrectionEvent
  | PlanMutationEvent;

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

  /**
   * Log a goal extraction event.
   */
  goalExtracted: (flowId: Uint8Array, goal: ExtractedGoal): void => {
    const event: GoalExtractedEvent = {
      type: 'goal',
      flowId: formatFlowId(flowId),
      intent: goal.intent,
      confidence: goal.confidence,
      targets: goal.targetNodes,
      timestamp: Date.now(),
    };
    console.log('[Agent]', event);
  },

  /**
   * Log a completion check event.
   */
  completionCheck: (flowId: Uint8Array, result: CompletionResult): void => {
    const event: CompletionCheckEvent = {
      type: 'completion',
      flowId: formatFlowId(flowId),
      complete: result.complete,
      progress: result.progress,
      reason: result.reason,
      missingCriteria: result.missingCriteria,
      timestamp: Date.now(),
    };
    if (result.complete) {
      console.log('[Agent]', event);
    } else {
      console.warn('[Agent]', event);
    }
  },

  /**
   * Log a loop correction event (when agent stopped early).
   */
  loopCorrection: (flowId: Uint8Array, iteration: number, reason: string): void => {
    const event: LoopCorrectionEvent = {
      type: 'correction',
      flowId: formatFlowId(flowId),
      iteration,
      reason,
      timestamp: Date.now(),
    };
    console.warn('[Agent]', event);
  },

  /**
   * Log a plan mutation validation event.
   */
  planMutation: (
    flowId: Uint8Array,
    action: string,
    targetName: string,
    approved: boolean,
    error?: string,
  ): void => {
    const event: PlanMutationEvent = {
      type: 'planMutation',
      flowId: formatFlowId(flowId),
      action,
      targetName,
      approved,
      error,
      timestamp: Date.now(),
    };
    if (approved) {
      console.log('[Agent]', event);
    } else {
      console.warn('[Agent]', event);
    }
  },
};
