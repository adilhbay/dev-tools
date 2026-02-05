/**
 * Plan Mutation Tool - Forces grounded mutations to prevent duplicates.
 *
 * This module solves the "duplicate nodes" problem where the agent creates
 * nodes without checking what already exists.
 *
 * Before any CREATE operation, the agent MUST call planMutation first.
 * This validates:
 * 1. The agent has read and understands current state (cited nodes exist)
 * 2. No duplicate names will be created
 * 3. For modify/delete: target actually exists
 */

import type {
  FlowContextData,
  PlanMutationArgs,
  PlanMutationResult,
  ToolSchema,
} from './types';
import { nodeNameExists, findNodesByName } from './graph-utils';

// =============================================================================
// Tool Schema
// =============================================================================

export const planMutationToolSchema: ToolSchema = {
  name: 'planMutation',
  description: `Validate your understanding of current state before creating or modifying nodes.
You MUST call this before any create operation. This prevents duplicate nodes and ensures you're working with accurate state.

Returns approval or rejection with explanation. If rejected, use getAllNodes to refresh your understanding.`,
  parameters: {
    type: 'object',
    properties: {
      existingNodesRelevant: {
        type: 'array',
        items: { type: 'string' },
        description: 'IDs of existing nodes you are aware of that are relevant to this operation. This proves you read the current state.',
      },
      intendedAction: {
        type: 'string',
        enum: ['create', 'modify', 'delete', 'connect'],
        description: 'The type of mutation you intend to perform',
      },
      targetName: {
        type: 'string',
        description: 'For creates: the name of the new node. For modify/delete: the ID of the target node.',
      },
      rationale: {
        type: 'string',
        description: 'Brief explanation of why this mutation is needed',
      },
    },
    required: ['existingNodesRelevant', 'intendedAction', 'targetName', 'rationale'],
    additionalProperties: false,
  },
};

// =============================================================================
// Execution
// =============================================================================

/**
 * Execute plan mutation validation.
 *
 * @param args - The planMutation tool arguments
 * @param flowContext - Current flow context
 * @returns Approval or rejection with explanation
 */
export function executePlanMutation(
  args: PlanMutationArgs,
  flowContext: FlowContextData,
): PlanMutationResult {
  const { existingNodesRelevant, intendedAction, targetName, rationale } = args;

  // Validate cited nodes actually exist
  const invalidCitations: string[] = [];
  for (const nodeId of existingNodesRelevant) {
    const exists = flowContext.nodes.some((n) => n.id === nodeId);
    if (!exists) {
      invalidCitations.push(nodeId);
    }
  }

  if (invalidCitations.length > 0) {
    return {
      approved: false,
      error: `Invalid node references: ${invalidCitations.join(', ')}. These nodes do not exist.`,
      suggestion: 'Call getAllNodes to refresh your understanding of the current workflow state.',
    };
  }

  // Action-specific validation
  switch (intendedAction) {
    case 'create': {
      // Check for duplicate names
      if (nodeNameExists(targetName, flowContext)) {
        const existing = findNodesByName(targetName, flowContext);
        const existingInfo = existing
          .map((n) => `${n.name} (${n.id}, ${n.kind})`)
          .join(', ');

        return {
          approved: false,
          error: `A node with name "${targetName}" already exists: ${existingInfo}`,
          suggestion: `Either use the existing node (ID: ${existing[0]?.id}) or choose a different name.`,
        };
      }

      // Require at least one existing node citation for context
      // (except for the very first node after ManualStart)
      const nonStartNodes = flowContext.nodes.filter((n) => n.kind !== 'ManualStart');
      if (nonStartNodes.length > 0 && existingNodesRelevant.length === 0) {
        return {
          approved: false,
          error: 'You must cite at least one existing node to prove you read the current state.',
          suggestion: 'Call getAllNodes first, then cite relevant node IDs in existingNodesRelevant.',
        };
      }

      return {
        approved: true,
      };
    }

    case 'modify':
    case 'delete': {
      // Target must be a valid node ID
      const targetNode = flowContext.nodes.find((n) => n.id === targetName);
      if (!targetNode) {
        return {
          approved: false,
          error: `Target node not found: ${targetName}`,
          suggestion: 'Call getAllNodes to find the correct node ID.',
        };
      }

      // Cannot modify/delete ManualStart
      if (targetNode.kind === 'ManualStart') {
        return {
          approved: false,
          error: 'Cannot modify or delete the ManualStart node.',
          suggestion: 'Choose a different node to modify/delete.',
        };
      }

      return {
        approved: true,
      };
    }

    case 'connect': {
      // For connect, targetName should be in format "sourceId -> targetId"
      // or we just validate based on cited nodes
      if (existingNodesRelevant.length < 2) {
        return {
          approved: false,
          error: 'Connect operation requires citing at least 2 nodes (source and target).',
          suggestion: 'Include both the source and target node IDs in existingNodesRelevant.',
        };
      }

      return {
        approved: true,
      };
    }

    default:
      return {
        approved: false,
        error: `Unknown action: ${intendedAction}`,
        suggestion: 'Use one of: create, modify, delete, connect',
      };
  }
}

/**
 * Check if a recent planMutation approval exists for the given action and target.
 * This is for optional enforcement tracking.
 */
export interface PlanMutationApproval {
  targetName: string;
  action: PlanMutationArgs['intendedAction'];
  approvedAt: number;
}

const APPROVAL_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Check if there's a valid recent approval for the given mutation.
 */
export function hasRecentApproval(
  approval: PlanMutationApproval | undefined,
  targetName: string,
  action: PlanMutationArgs['intendedAction'],
): boolean {
  if (!approval) return false;

  const isRecent = Date.now() - approval.approvedAt < APPROVAL_TIMEOUT_MS;
  const matchesTarget = approval.targetName.toLowerCase() === targetName.toLowerCase();
  const matchesAction = approval.action === action;

  return isRecent && matchesTarget && matchesAction;
}
