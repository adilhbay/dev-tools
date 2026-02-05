/**
 * Agent Phase System - Implements phase-based tool filtering for the agentic loop.
 *
 * Phases: analyze -> execute -> verify
 *
 * This enforces a "diagnose before prescribe" workflow where the agent must:
 * 1. Analyze the current state and plan (exploration tools + phase transition tool)
 * 2. Execute the changes after user approval (mutation tools)
 * 3. Verify the results (exploration + execution tools)
 */

import type { ToolSchema } from './types';

// =============================================================================
// Types
// =============================================================================

export type AgentPhase = 'analyze' | 'execute' | 'verify';

export interface PhaseContext {
  lastMessage: string;
  hasToolCalls: boolean;
  /** Number of orphan nodes (nodes not reachable from start) */
  orphanCount?: number;
}

export interface PhaseConfig {
  allowedToolNames: string[];
  systemPromptAddition: string;
  nextPhase: AgentPhase;
  canLoopBack?: AgentPhase;
}

export interface PendingTransition {
  fromPhase: AgentPhase;
  toPhase: AgentPhase;
}

export interface TransitionAction {
  label: string;
  targetPhase: AgentPhase;
  variant: 'primary' | 'secondary';
}

// =============================================================================
// Tool Categories
// =============================================================================

/** Exploration tools - read-only access to workflow state */
const EXPLORATION_TOOLS = [
  'getWorkflow',
  'getAllNodes',
  'getAllEdges',
  'getAllVariables',
  'getNode',
  'getEdge',
  'getFlowVariable',
  'getNodeExecutions',
  'getNodeOutput',
  'getFailedNodes',
];

/** Client-side exploration tools */
const CLIENT_EXPLORATION_TOOLS = ['getSelectedNodes'];

/** Mutation tools - modify workflow state */
const MUTATION_TOOLS = [
  'planMutation', // Required before creates to prevent duplicates
  'createJsNode',
  'createConditionNode',
  'createForNode',
  'createForEachNode',
  'createHttpNode',
  'connectSequentialNodes',
  'connectBranchingNodes',
  'disconnectNodes',
  'deleteNode',
  'updateNodeConfig',
  'updateNodeCode',
  'createVariable',
  'updateVariable',
];

/** Client-side mutation tools */
const CLIENT_MUTATION_TOOLS = ['applyWorkflowPatch', 'updateHttpMethod'];

/** Execution tools - run/stop workflow */
const EXECUTION_TOOLS = ['flowRunRequest', 'flowStopRequest'];

// =============================================================================
// Phase Transition Tool
// =============================================================================

/** Tool for the agent to explicitly request a phase transition */
export const PHASE_TRANSITION_TOOL_NAME = 'requestPhaseTransition';

export const phaseTransitionToolSchema: ToolSchema = {
  name: PHASE_TRANSITION_TOOL_NAME,
  description:
    'Request to transition to a different phase. Call this when you have completed your work in the current phase and are ready to move on. Returns whether the transition is approved.',
  parameters: {
    type: 'object',
    properties: {
      targetPhase: {
        type: 'string',
        enum: ['execute', 'verify', 'analyze'],
        description: 'The phase to transition to',
      },
      reason: {
        type: 'string',
        description: 'Brief explanation of why you are ready to transition',
      },
    },
    required: ['targetPhase', 'reason'],
  },
};

// =============================================================================
// Phase Configurations
// =============================================================================

export const PHASE_CONFIGS: Record<AgentPhase, PhaseConfig> = {
  analyze: {
    allowedToolNames: [...EXPLORATION_TOOLS, ...CLIENT_EXPLORATION_TOOLS, PHASE_TRANSITION_TOOL_NAME],
    systemPromptAddition: `

## CURRENT PHASE: ANALYZE & PLAN

Analyze the workflow state, then present your plan. You have access to exploration tools now.

**YOUR TASK:**
1. Use exploration tools to understand the current workflow
2. Present a brief plan (2-5 bullet points)
3. Call the requestPhaseTransition tool with targetPhase="execute" when ready

**IMPORTANT:** You WILL be able to create and modify nodes after user approval. Do NOT tell the user to create nodes manually.

**AVAILABLE MUTATION TOOLS (after approval):**
- createJsNode, createHttpNode, createConditionNode, createForNode, createForEachNode
- connectSequentialNodes, connectBranchingNodes, disconnectNodes
- updateNodeCode, updateNodeConfig, deleteNode
- applyWorkflowPatch (for batch operations)
`,
    nextPhase: 'execute',
  },

  execute: {
    allowedToolNames: [...MUTATION_TOOLS, ...CLIENT_MUTATION_TOOLS, ...EXPLORATION_TOOLS, PHASE_TRANSITION_TOOL_NAME],
    systemPromptAddition: `

## CURRENT PHASE: EXECUTE

You are in the **execution phase**. Implement the changes from your plan.

## GROUNDED MUTATIONS (REQUIRED)
Before any CREATE operation, you MUST call planMutation first.
This validates your understanding of current state and prevents duplicate nodes.
If planMutation is rejected, use getAllNodes to refresh your understanding.

**ALLOWED ACTIONS:**
- Validate with planMutation before creates
- Create nodes (createJsNode, createHttpNode, createConditionNode, etc.)
- Connect nodes (connectSequentialNodes, connectBranchingNodes)
- Modify nodes (updateNodeCode, updateNodeConfig)
- Delete nodes and connections
- Use applyWorkflowPatch for batch operations
- Use exploration tools to verify what you've created

**CRITICAL - ALWAYS CONNECT NODES:**
After creating a node, you MUST connect it before moving on:
1. Call planMutation to validate your intent
2. Create the node -> get the nodeId from the result
3. Immediately connect it using connectSequentialNodes or connectBranchingNodes
4. Only then proceed to the next operation

DO NOT call requestPhaseTransition until ALL nodes are connected. Orphan nodes are failures.

**THE LOOP CONTINUES UNTIL YOUR GOAL IS COMPLETE.**
You cannot exit by not calling tools. The system will verify completion.
If you stop early, you will be prompted to continue.

**WHEN TO PROCEED:**
- ONLY when all planned changes are complete AND all nodes are connected
- Call requestPhaseTransition with targetPhase="verify" to check your work

If a tool call fails, you may retry or adjust your approach.
`,
    nextPhase: 'verify',
  },

  verify: {
    allowedToolNames: ['getNode', 'getNodeExecutions', 'getNodeOutput', ...EXECUTION_TOOLS, PHASE_TRANSITION_TOOL_NAME],
    systemPromptAddition: `

## CURRENT PHASE: VERIFY

You are in the **verification phase**. Confirm that your changes worked correctly.

**ALLOWED ACTIONS:**
- Inspect nodes to verify they were created/modified correctly
- Run the flow with flowRunRequest to test it
- Check execution results with getNodeExecutions and getNodeOutput

**VERIFICATION CHECKLIST:**
- Were all nodes created as planned?
- Are all connections in place?
- Are there any orphan nodes?
- Does the flow execute without errors?

**OUTCOMES:**
- If everything looks good: Summarize what was accomplished
- If there are issues: Call requestPhaseTransition with targetPhase="analyze" to return to analysis

When verification is complete, provide a final summary to the user.
`,
    nextPhase: 'analyze', // Loops back for new requests or issues
    canLoopBack: 'analyze',
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Filter tools to only those allowed in the current phase.
 * Includes the phase transition tool schema if it's allowed in the phase.
 */
export function getToolsForPhase(phase: AgentPhase, allTools: ToolSchema[]): ToolSchema[] {
  const config = PHASE_CONFIGS[phase];
  const allowedNames = new Set(config.allowedToolNames);

  // Filter provided tools
  const filtered = allTools.filter((tool) => allowedNames.has(tool.name));

  // Add the phase transition tool if allowed
  if (allowedNames.has(PHASE_TRANSITION_TOOL_NAME)) {
    filtered.push(phaseTransitionToolSchema);
  }

  return filtered;
}

/**
 * Get the initial phase for a new conversation or after clearing messages.
 */
export function getInitialPhase(): AgentPhase {
  return 'analyze';
}

/**
 * Validate a phase transition request.
 * Returns null if valid, or an error message if blocked.
 */
export function validatePhaseTransition(
  currentPhase: AgentPhase,
  targetPhase: AgentPhase,
  context: PhaseContext,
): { valid: true } | { valid: false; reason: string } {
  // Block execute->verify if there are orphan nodes
  if (currentPhase === 'execute' && targetPhase === 'verify') {
    if ((context.orphanCount ?? 0) > 0) {
      return {
        valid: false,
        reason: `Cannot transition to verify: ${context.orphanCount} orphan node(s) must be connected first`,
      };
    }
  }

  // Block analyze->execute transition (requires user confirmation)
  // This is handled by setting pendingTransition, not blocking
  // So we return valid=true but the caller should set pending state

  return { valid: true };
}

/**
 * Check if a transition requires user confirmation.
 */
export function requiresUserConfirmation(
  currentPhase: AgentPhase,
  targetPhase: AgentPhase,
): boolean {
  // analyze->execute requires user confirmation
  return currentPhase === 'analyze' && targetPhase === 'execute';
}

/**
 * Get the available transition actions for UI buttons based on pending transition.
 */
export function getTransitionActions(pending: PendingTransition): TransitionAction[] {
  const { fromPhase, toPhase } = pending;

  // analyze->execute shows execute and revise buttons
  if (fromPhase === 'analyze' && toPhase === 'execute') {
    return [
      { label: 'Execute Plan', targetPhase: toPhase, variant: 'primary' },
      { label: 'Revise', targetPhase: 'analyze', variant: 'secondary' },
    ];
  }

  return [];
}
