/**
 * Completion Oracle - Goal extraction and completion checking.
 *
 * This module solves the "early termination" problem where the agent stops
 * because the LLM decides to stop calling tools, not because the task is done.
 *
 * The oracle:
 * 1. Extracts the user's goal from their message
 * 2. Checks whether that goal has been achieved based on workflow state
 * 3. Provides progress feedback during execution
 */

import type {
  ExtractedGoal,
  CompletionResult,
  GoalIntent,
  FlowContextData,
  ToolResult,
} from './types';
import { countOrphans, findNodesByName } from './graph-utils';

// =============================================================================
// Goal Extraction
// =============================================================================

/** Keyword patterns for intent detection (fast heuristics) */
const INTENT_PATTERNS: Record<GoalIntent, RegExp[]> = {
  create: [
    /\b(add|create|new|insert|make)\b/i,
    /\b(node|step|function|condition|loop)\b/i,
  ],
  modify: [
    /\b(update|change|modify|edit|fix|alter)\b/i,
    /\b(set|configure|rename)\b/i,
  ],
  delete: [
    /\b(delete|remove|drop)\b/i,
  ],
  connect: [
    /\b(connect|link|wire|chain|attach)\b/i,
    /\b(after|before|between)\b/i,
  ],
  run: [
    /\b(run|execute|start|trigger)\b/i,
    /\b(test|try)\b.*\b(flow|workflow)\b/i,
  ],
  debug: [
    /\b(debug|fix|solve|investigate)\b/i,
    /\b(error|fail|broken|issue|problem|bug)\b/i,
  ],
  query: [
    /\b(what|which|how|show|list|get|find)\b/i,
    /\b(status|state|info|detail)\b/i,
  ],
};

/** Node type keywords for target extraction */
const NODE_TYPE_PATTERNS: Record<string, RegExp> = {
  JavaScript: /\b(javascript|js|script|code|function)\b/i,
  HTTP: /\b(http|api|request|endpoint|fetch|call)\b/i,
  Condition: /\b(condition|if|branch|check|decision)\b/i,
  For: /\b(for|loop|iterate|repeat)\b\s*\d*/i,
  ForEach: /\b(foreach|for\s*each|iterate\s*(over|through))\b/i,
};

/**
 * Extract the primary intent from a user message using keyword heuristics.
 */
function detectIntent(message: string): { intent: GoalIntent; confidence: number } {
  const scores: Record<GoalIntent, number> = {
    create: 0,
    modify: 0,
    delete: 0,
    connect: 0,
    run: 0,
    debug: 0,
    query: 0,
  };

  // Score each intent based on pattern matches
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(message)) {
        scores[intent as GoalIntent] += 1;
      }
    }
  }

  // Find the highest scoring intent
  let maxIntent: GoalIntent = 'query';
  let maxScore = 0;

  for (const [intent, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxIntent = intent as GoalIntent;
    }
  }

  // Calculate confidence based on score and clarity
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = totalScore > 0 ? maxScore / totalScore : 0.5;

  return { intent: maxIntent, confidence: Math.min(confidence, 0.95) };
}

/**
 * Extract target node names/types from the message.
 */
function extractTargetNodes(message: string): string[] {
  const targets: string[] = [];

  // Look for quoted names
  const quotedNames = message.match(/["']([^"']+)["']/g);
  if (quotedNames) {
    targets.push(...quotedNames.map((q) => q.slice(1, -1)));
  }

  // Look for "called X" or "named X" patterns
  const namedMatch = message.match(/\b(called|named)\s+(\w+)/i);
  if (namedMatch) {
    targets.push(namedMatch[2]!);
  }

  // Look for node type mentions
  for (const [nodeType, pattern] of Object.entries(NODE_TYPE_PATTERNS)) {
    if (pattern.test(message)) {
      targets.push(nodeType);
    }
  }

  return [...new Set(targets)];
}

/**
 * Generate expected outcome description from the message.
 */
function generateExpectedOutcome(intent: GoalIntent, targets: string[], message: string): string {
  switch (intent) {
    case 'create':
      if (targets.length > 0) {
        return `Create ${targets.join(', ')} node(s) and connect them to the workflow`;
      }
      return 'Create new node(s) and connect them to the workflow';
    case 'modify':
      return `Modify ${targets.length > 0 ? targets.join(', ') : 'specified node(s)'}`;
    case 'delete':
      return `Delete ${targets.length > 0 ? targets.join(', ') : 'specified node(s)'}`;
    case 'connect':
      return 'Connect nodes and ensure no orphans remain';
    case 'run':
      return 'Execute the workflow successfully';
    case 'debug':
      return 'Identify and fix the issue';
    case 'query':
      return 'Provide the requested information';
    default:
      return 'Complete the requested task';
  }
}

/**
 * Extract goal from user message.
 * Uses keyword heuristics for fast detection.
 */
export function extractGoal(
  userMessage: string,
  flowContext: FlowContextData,
): ExtractedGoal {
  const { intent, confidence } = detectIntent(userMessage);
  const targetNodes = extractTargetNodes(userMessage);
  const expectedOutcome = generateExpectedOutcome(intent, targetNodes, userMessage);

  return {
    intent,
    targetNodes: targetNodes.length > 0 ? targetNodes : undefined,
    expectedOutcome,
    originalMessage: userMessage,
    confidence,
  };
}

// =============================================================================
// Completion Checking
// =============================================================================

/**
 * Check if the goal has been completed based on current state.
 */
export function checkCompletion(
  goal: ExtractedGoal,
  flowContext: FlowContextData,
  toolResults: ToolResult[],
): CompletionResult {
  const missingCriteria: string[] = [];

  // Always check orphan count first (regression prevention)
  const orphanCount = countOrphans(flowContext);
  if (orphanCount > 0) {
    missingCriteria.push(`${orphanCount} orphan node(s) need to be connected`);
  }

  // Check recent tool results for errors
  const recentErrors = toolResults
    .slice(-5)
    .filter((r) => r.error)
    .map((r) => r.error!);

  if (recentErrors.length > 0) {
    missingCriteria.push(`Recent tool errors: ${recentErrors.join('; ')}`);
  }

  // Intent-specific completion checks
  switch (goal.intent) {
    case 'create': {
      // Check if target nodes exist
      if (goal.targetNodes && goal.targetNodes.length > 0) {
        for (const target of goal.targetNodes) {
          // Skip node type names (JavaScript, HTTP, etc.)
          if (Object.keys(NODE_TYPE_PATTERNS).includes(target)) {
            continue;
          }
          const matches = findNodesByName(target, flowContext);
          if (matches.length === 0) {
            missingCriteria.push(`Node "${target}" not found`);
          }
        }
      }

      // Check for successful create tool results
      const createResults = toolResults.filter(
        (r) =>
          !r.error &&
          r.result &&
          typeof r.result === 'object' &&
          'nodeId' in (r.result as Record<string, unknown>),
      );

      if (createResults.length === 0 && !missingCriteria.some((c) => c.includes('not found'))) {
        missingCriteria.push('No nodes created yet');
      }
      break;
    }

    case 'modify': {
      // Check for successful update tool results
      const modifyResults = toolResults.filter(
        (r) =>
          !r.error &&
          r.result &&
          typeof r.result === 'object' &&
          'success' in (r.result as Record<string, unknown>),
      );

      if (modifyResults.length === 0) {
        missingCriteria.push('No modifications applied yet');
      }
      break;
    }

    case 'delete': {
      // Check if target nodes were deleted
      const deleteResults = toolResults.filter(
        (r) =>
          !r.error &&
          r.result &&
          typeof r.result === 'object' &&
          'success' in (r.result as Record<string, unknown>),
      );

      if (deleteResults.length === 0) {
        missingCriteria.push('No deletions performed yet');
      }
      break;
    }

    case 'connect': {
      // Primary check is orphan count (already done above)
      const connectResults = toolResults.filter(
        (r) =>
          !r.error &&
          r.result &&
          typeof r.result === 'object' &&
          'edgeId' in (r.result as Record<string, unknown>),
      );

      if (orphanCount > 0 && connectResults.length === 0) {
        missingCriteria.push('No connections made yet');
      }
      break;
    }

    case 'run': {
      // Check for flow execution results
      const runResults = toolResults.filter(
        (r) =>
          !r.error &&
          r.result &&
          typeof r.result === 'object' &&
          (r.result as Record<string, unknown>).message === 'Flow execution started',
      );

      if (runResults.length === 0) {
        missingCriteria.push('Flow not executed yet');
      }
      break;
    }

    case 'debug': {
      // Debug is complete when errors are identified or resolved
      // This is harder to verify automatically
      const hasExploration = toolResults.some(
        (r) =>
          !r.error &&
          r.result &&
          typeof r.result === 'object' &&
          ('failedNodes' in (r.result as Record<string, unknown>) ||
            'error' in (r.result as Record<string, unknown>)),
      );

      if (!hasExploration) {
        missingCriteria.push('Error investigation not started');
      }
      break;
    }

    case 'query': {
      // Query is complete when relevant information is retrieved
      // Just ensure some tool was called successfully
      const queryResults = toolResults.filter((r) => !r.error);
      if (queryResults.length === 0) {
        missingCriteria.push('Information not retrieved yet');
      }
      break;
    }
  }

  // Calculate progress
  const totalCriteria = missingCriteria.length + 1; // +1 for base completion
  const metCriteria = 1; // Base
  const progress = Math.max(0.1, 1 - missingCriteria.length / (totalCriteria + missingCriteria.length));

  // Determine completion
  const complete = missingCriteria.length === 0;

  return {
    complete,
    reason: complete
      ? 'Goal achieved'
      : `Incomplete: ${missingCriteria.slice(0, 2).join(', ')}`,
    progress,
    missingCriteria: missingCriteria.length > 0 ? missingCriteria : undefined,
  };
}

/**
 * Generate a correction message when the LLM stops but the goal isn't complete.
 */
export function generateCorrectionMessage(
  goal: ExtractedGoal,
  completionResult: CompletionResult,
): string {
  const { missingCriteria } = completionResult;

  if (!missingCriteria || missingCriteria.length === 0) {
    return '[CORRECTION] Goal not yet complete. Continue working on the task.';
  }

  const criteriaList = missingCriteria.slice(0, 3).join('\n- ');
  return `[CORRECTION] Your goal is not yet complete (${Math.round(completionResult.progress * 100)}% progress).

Missing criteria:
- ${criteriaList}

Continue working to complete the task. Do not stop until all criteria are met.`;
}

/**
 * Build goal-aware system prompt addition.
 */
export function buildGoalPrompt(goal: ExtractedGoal): string {
  return `
## CURRENT GOAL
Intent: ${goal.intent}
${goal.targetNodes ? `Targets: ${goal.targetNodes.join(', ')}` : ''}
Expected: ${goal.expectedOutcome}

You cannot stop until this goal is complete. The system will verify completion.
If you stop early, you will be prompted to continue.
`;
}
