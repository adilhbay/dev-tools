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

## CURRENT PHASE: ANALYZE

You are in the **analysis phase**. Your goal is to understand the current workflow state before making any changes.

**ALLOWED ACTIONS:**
- Use exploration tools to gather information about nodes, connections, and executions
- Inspect error details with getNodeExecutions
- Check node outputs with getNodeOutput
- View selected nodes with getSelectedNodes

**RESTRICTIONS:**
- You CANNOT modify the workflow yet
- You CANNOT run the flow yet

**WHEN TO PROCEED:**
- When you have enough information to formulate a plan
- Say "Ready to plan" to move to the planning phase

For simple, well-defined requests, briefly analyze then proceed quickly.
`,
    transitionKeywords: ['ready to plan', 'moving to plan', 'i understand the situation', 'let me plan'],
    nextPhase: 'plan',
  },

  plan: {
    allowedToolNames: [], // No tools - pure reasoning
    systemPromptAddition: `

## CURRENT PHASE: PLAN

You are in the **planning phase**. State your plan clearly and concisely.

**YOUR PLAN SHOULD INCLUDE:**
1. What changes will you make? (be specific about nodes and connections)
2. In what order will you execute them?
3. What could go wrong and how will you handle it?

**FORMAT:**
Keep the plan brief - 2-5 bullet points maximum.

**WHEN TO PROCEED:**
- When your plan is complete
- Say "Ready to execute" to begin making changes

NOTE: You cannot use any tools in this phase. Focus on reasoning and planning.
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
