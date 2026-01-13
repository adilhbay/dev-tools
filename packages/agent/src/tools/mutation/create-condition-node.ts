import { createClient } from '@connectrpc/connect';
import { FlowService, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { Position, ToolContext, ToolResult } from '../../types.ts';
import { generateUlid, generateUlidBytes, ulidToBytes } from '../../utils.ts';

export interface CreateConditionNodeParams {
  flowId: string;
  name: string;
  condition: string;
  position?: Position;
}

export interface CreateConditionNodeResult {
  nodeId: string;
}

/**
 * Create a condition node that routes flow based on a boolean expression.
 * Has THEN and ELSE output handles.
 */
export async function createConditionNode(
  ctx: ToolContext,
  params: CreateConditionNodeParams,
): Promise<ToolResult<CreateConditionNodeResult>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const nodeIdBytes = generateUlidBytes();
    const nodeId = generateUlid();
    const flowIdBytes = ulidToBytes(params.flowId);

    // Insert the base node first
    await client['nodeInsert']({
      items: [
        {
          nodeId: nodeIdBytes,
          flowId: flowIdBytes,
          kind: NodeKind.CONDITION,
          name: params.name,
          position: { x: params.position?.x ?? 0, y: params.position?.y ?? 0 },
        },
      ],
    });

    // Insert the condition-specific configuration
    await client['nodeConditionInsert']({
      items: [
        {
          nodeId: nodeIdBytes,
          condition: params.condition,
        },
      ],
    });

    return {
      success: true,
      data: { nodeId },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
