/**
 * Agent Phase System - Implements phase-based tool filtering for the agentic loop.
 *
 * Phases: analyze -> plan -> execute -> verify
 *
 * This enforces a "diagnose before prescribe" workflow where the agent must:
 * 1. Analyze the current state (exploration tools only)
 * 2. Plan the changes (no tools, pure reasoning)
 * 3. Execute the changes (mutation tools only)
 * 4. Verify the results (exploration + execution tools)
 */

import type { ToolSchema } from './types';

// =============================================================================
// Types
// =============================================================================

export type AgentPhase = 'analyze' | 'plan' | 'execute' | 'verify';

export interface PhaseContext {
  lastMessage: string;
  hasToolCalls: boolean;
}

export interface PhaseConfig {
  allowedToolNames: string[];
  systemPromptAddition: string;
  transitionKeywords: string[];
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
// Phase Configurations
// =============================================================================

export const PHASE_CONFIGS: Record<AgentPhase, PhaseConfig> = {
  analyze: {
    allowedToolNames: [...EXPLORATION_TOOLS, ...CLIENT_EXPLORATION_TOOLS],
    systemPromptAddition: `

## CURRENT PHASE: ANALYZE & PLAN

Analyze the workflow state, then present your plan. You have access to exploration tools now, and after the user approves your plan, you will have access to these mutation tools:
- createJsNode, createHttpNode, createConditionNode, createForNode, createForEachNode
- connectSequentialNodes, connectBranchingNodes, disconnectNodes
- updateNodeCode, updateNodeConfig, deleteNode
- applyWorkflowPatch (for batch operations)

**YOUR TASK:**
1. Use exploration tools to understand the current workflow
2. Present a brief plan (2-5 bullet points)
3. End with "Ready to execute" - the user will see a button to approve

**IMPORTANT:** You WILL be able to create and modify nodes after user approval. Do NOT tell the user to create nodes manually.
`,
    transitionKeywords: ['ready to plan', 'moving to plan', 'i understand the situation', 'let me plan'],
    nextPhase: 'plan',
  },

  plan: {
    allowedToolNames: [], // No tools in plan phase - but we tell the agent what's coming
    systemPromptAddition: `

## CURRENT PHASE: PLAN

You are in the **planning phase**. State your plan clearly and concisely.

**YOUR PLAN SHOULD INCLUDE:**
1. What changes will you make? (be specific about nodes and connections)
2. In what order will you execute them?

**FORMAT:**
Keep the plan brief - 2-5 bullet points maximum.

**TOOLS YOU WILL USE (available after user approval):**
- createJsNode, createHttpNode, createConditionNode, createForNode, createForEachNode
- connectSequentialNodes, connectBranchingNodes, disconnectNodes
- updateNodeCode, updateNodeConfig, deleteNode
- applyWorkflowPatch (for batch operations)

**WHEN DONE PLANNING:**
You MUST end your response with exactly: "Ready to execute"
The user will see a button to approve, then you will execute your plan.
`,
    transitionKeywords: ['ready to execute', 'plan complete', 'let me proceed', 'executing now', 'let\'s execute'],
    nextPhase: 'execute',
  },

  execute: {
    allowedToolNames: [...MUTATION_TOOLS, ...CLIENT_MUTATION_TOOLS],
    systemPromptAddition: `

## CURRENT PHASE: EXECUTE

You are in the **execution phase**. Implement the changes from your plan.

**ALLOWED ACTIONS:**
- Create nodes (createJsNode, createHttpNode, createConditionNode, etc.)
- Connect nodes (connectSequentialNodes, connectBranchingNodes)
- Modify nodes (updateNodeCode, updateNodeConfig)
- Delete nodes and connections
- Use applyWorkflowPatch for batch operations

**BEST PRACTICES:**
- Execute one logical operation at a time
- Create nodes before connecting them
- Use applyWorkflowPatch when making multiple related changes

**WHEN TO PROCEED:**
- When all planned changes are complete
- Say "Ready to verify" to check your work

If a tool call fails, you may retry or adjust your approach.
`,
    transitionKeywords: ['ready to verify', 'changes complete', 'done executing', 'let me verify', 'verification time'],
    nextPhase: 'verify',
  },

  verify: {
    allowedToolNames: ['getNode', 'getNodeExecutions', 'getNodeOutput', ...EXECUTION_TOOLS],
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
- If there are issues: Say "Need to analyze" to return to analysis phase

When verification is complete, provide a final summary to the user.
`,
    transitionKeywords: ['need to analyze', 'something is wrong', 'let me investigate', 'there\'s an issue'],
    nextPhase: 'analyze', // Loops back for new requests or issues
    canLoopBack: 'analyze',
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Filter tools to only those allowed in the current phase.
 */
export function getToolsForPhase(phase: AgentPhase, allTools: ToolSchema[]): ToolSchema[] {
  const config = PHASE_CONFIGS[phase];
  const allowedNames = new Set(config.allowedToolNames);
  return allTools.filter((tool) => allowedNames.has(tool.name));
}

/**
 * Determine the next phase based on the current phase and LLM response context.
 *
 * Transition rules:
 * - Check for explicit transition keywords in the LLM's response
 * - Plan phase auto-transitions to execute (since it has no tools)
 * - Verify phase can loop back to analyze if issues are found
 * - Verify phase completes (stays in verify) when no tool calls and no loop-back keywords
 */
export function getNextPhase(currentPhase: AgentPhase, context: PhaseContext): AgentPhase {
  const config = PHASE_CONFIGS[currentPhase];
  const lowerMessage = context.lastMessage.toLowerCase();

  // Check for loop-back condition first (verify -> analyze)
  if (config.canLoopBack) {
    for (const keyword of config.transitionKeywords) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        return config.canLoopBack;
      }
    }
  }

  // Check for forward transition keywords
  if (!config.canLoopBack) {
    for (const keyword of config.transitionKeywords) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        return config.nextPhase;
      }
    }
  }

  // Auto-transition from plan phase (no tools available, so after LLM responds it should proceed)
  if (currentPhase === 'plan' && !context.hasToolCalls) {
    // Check if the response indicates readiness to execute
    const executeKeywords = ['ready to execute', 'plan complete', 'let me proceed', 'executing now', 'let\'s execute'];
    for (const keyword of executeKeywords) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        return 'execute';
      }
    }
  }

  return currentPhase;
}

/**
 * Get the initial phase for a new conversation or after clearing messages.
 */
export function getInitialPhase(): AgentPhase {
  return 'analyze';
}

/**
 * Keywords that indicate the agent has a plan ready and is asking to execute.
 * These cover both explicit "Ready to execute" and natural language variations.
 */
const EXECUTE_READY_KEYWORDS = [
  // Explicit
  'ready to execute',
  'plan complete',
  'let me proceed',
  'executing now',
  "let's execute",
  // Natural language variations
  'should i proceed',
  'proceed to creation',
  'want to review this plan',
  'shall i execute',
  'shall i proceed',
  'want me to execute',
  'want me to proceed',
  'ready to create',
  'ready to implement',
  'approve this plan',
];

/**
 * Detect if the agent's message signals readiness to execute.
 * Returns pending transition if the agent has presented a plan and is ready.
 *
 * We check from BOTH analyze and plan phases since the agent often combines them.
 */
export function detectPendingTransition(
  currentPhase: AgentPhase,
  context: PhaseContext,
): PendingTransition | null {
  // Only prompt for execute transition (from analyze or plan)
  if (currentPhase !== 'analyze' && currentPhase !== 'plan') {
    return null;
  }

  const lowerMessage = context.lastMessage.toLowerCase();

  for (const keyword of EXECUTE_READY_KEYWORDS) {
    if (lowerMessage.includes(keyword.toLowerCase())) {
      return { fromPhase: currentPhase, toPhase: 'execute' };
    }
  }

  return null;
}

/**
 * Get the available transition actions for UI buttons based on pending transition.
 * Shows execute buttons when agent has presented a plan (from analyze or plan phase).
 */
export function getTransitionActions(pending: PendingTransition): TransitionAction[] {
  const { fromPhase, toPhase } = pending;

  // Both analyze and plan can transition to execute
  if (fromPhase === 'analyze' || fromPhase === 'plan') {
    return [
      { label: 'Execute Plan', targetPhase: toPhase, variant: 'primary' },
      { label: 'Revise', targetPhase: 'analyze', variant: 'secondary' },
    ];
  }

  return [];
}
