/**
 * Agent Phase Management Hook - Centralized phase state management.
 *
 * Handles:
 * - Current phase state
 * - Pending transition state
 * - Session persistence (optional)
 * - Phase transition logic
 */

import { useCallback, useRef, useState, useEffect } from 'react';
import type { AgentPhase, PendingTransition } from './agent-phases';
import { getInitialPhase } from './agent-phases';
import { AgentTelemetry, type PhaseTransitionTrigger } from './telemetry';

export interface UseAgentPhaseOptions {
  /** Session ID for persistence (typically flowId as string) */
  sessionId?: string;
  /** Enable sessionStorage persistence */
  persist?: boolean;
  /** Flow ID for telemetry */
  flowId?: Uint8Array;
}

export interface AgentPhaseState {
  currentPhase: AgentPhase;
  pendingTransition: PendingTransition | null;
}

export interface UseAgentPhaseResult {
  /** Current active phase */
  currentPhase: AgentPhase;
  /** Ref to current phase for use in closures */
  currentPhaseRef: React.MutableRefObject<AgentPhase>;
  /** Pending transition awaiting user confirmation */
  pendingTransition: PendingTransition | null;
  /** Directly transition to a new phase */
  transitionTo: (phase: AgentPhase, trigger?: PhaseTransitionTrigger) => void;
  /** Request a transition (sets pending state) */
  requestTransition: (from: AgentPhase, to: AgentPhase) => void;
  /** Confirm a pending transition */
  confirmTransition: (targetPhase: AgentPhase) => void;
  /** Cancel a pending transition */
  cancelTransition: () => void;
  /** Reset to initial phase */
  reset: () => void;
}

const STORAGE_KEY_PREFIX = 'agent-phase-';

function getStorageKey(sessionId: string): string {
  return `${STORAGE_KEY_PREFIX}${sessionId}`;
}

function loadPersistedState(sessionId: string): AgentPhaseState | null {
  try {
    const stored = sessionStorage.getItem(getStorageKey(sessionId));
    if (stored) {
      const parsed = JSON.parse(stored) as AgentPhaseState;
      // Validate the phase is valid
      if (['analyze', 'execute', 'verify'].includes(parsed.currentPhase)) {
        return parsed;
      }
    }
  } catch {
    // Ignore parsing errors
  }
  return null;
}

function persistState(sessionId: string, state: AgentPhaseState): void {
  try {
    sessionStorage.setItem(getStorageKey(sessionId), JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

function clearPersistedState(sessionId: string): void {
  try {
    sessionStorage.removeItem(getStorageKey(sessionId));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Hook for managing agent phase state.
 *
 * Provides centralized phase management with:
 * - Direct transitions (for auto-transitions)
 * - Pending transitions (for user confirmation)
 * - Optional session persistence
 * - Telemetry integration
 */
export function useAgentPhase(options: UseAgentPhaseOptions = {}): UseAgentPhaseResult {
  const { sessionId, persist = false, flowId } = options;

  // Load initial state from storage if persistence is enabled
  const initialState = (): AgentPhaseState => {
    if (persist && sessionId) {
      const persisted = loadPersistedState(sessionId);
      if (persisted) {
        return persisted;
      }
    }
    return {
      currentPhase: getInitialPhase(),
      pendingTransition: null,
    };
  };

  const [currentPhase, setCurrentPhase] = useState<AgentPhase>(() => initialState().currentPhase);
  const [pendingTransition, setPendingTransition] = useState<PendingTransition | null>(
    () => initialState().pendingTransition,
  );

  // Ref for accessing current phase in closures
  const currentPhaseRef = useRef(currentPhase);
  currentPhaseRef.current = currentPhase;

  // Persist state changes
  useEffect(() => {
    if (persist && sessionId) {
      persistState(sessionId, { currentPhase, pendingTransition });
    }
  }, [persist, sessionId, currentPhase, pendingTransition]);

  const transitionTo = useCallback(
    (phase: AgentPhase, trigger: PhaseTransitionTrigger = 'auto') => {
      const from = currentPhaseRef.current;
      if (from !== phase) {
        if (flowId) {
          AgentTelemetry.phaseTransition(flowId, from, phase, trigger);
        }
        currentPhaseRef.current = phase;
        setCurrentPhase(phase);
        setPendingTransition(null);
      }
    },
    [flowId],
  );

  const requestTransition = useCallback((from: AgentPhase, to: AgentPhase) => {
    setPendingTransition({ fromPhase: from, toPhase: to });
  }, []);

  const confirmTransition = useCallback(
    (targetPhase: AgentPhase) => {
      transitionTo(targetPhase, 'user_confirm');
    },
    [transitionTo],
  );

  const cancelTransition = useCallback(() => {
    setPendingTransition(null);
  }, []);

  const reset = useCallback(() => {
    const initial = getInitialPhase();
    if (flowId) {
      AgentTelemetry.phaseTransition(flowId, currentPhaseRef.current, initial, 'reset');
    }
    currentPhaseRef.current = initial;
    setCurrentPhase(initial);
    setPendingTransition(null);
    if (persist && sessionId) {
      clearPersistedState(sessionId);
    }
  }, [flowId, persist, sessionId]);

  return {
    currentPhase,
    currentPhaseRef,
    pendingTransition,
    transitionTo,
    requestTransition,
    confirmTransition,
    cancelTransition,
    reset,
  };
}
