import { createClient } from '@connectrpc/connect';
import { FlowService, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ErrorHandlingStrategy, Position, ToolContext, ToolResult } from '../../types.ts';
import { bytesToUlid, generateUlidBytes, stringToErrorHandling, ulidToBytes } from '../../utils.ts';

export interface CreateForNodeParams {
  flowId: string;
  name: string;
  iterations: number;
  condition: string;
  errorHandling: ErrorHandlingStrategy;
  position?: Position;
}

export interface CreateForNodeResult {
  nodeId: string;
}

/**
 * Create a for-loop node that iterates a fixed number of times.
 */
export async function createForNode(
  ctx: ToolContext,
  params: CreateForNodeParams,
): Promise<ToolResult<CreateForNodeResult>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const nodeIdBytes = generateUlidBytes();
    const nodeId = bytesToUlid(nodeIdBytes);
    const flowIdBytes = ulidToBytes(params.flowId);

    // Insert the base node first
    await client['nodeInsert']({
      items: [
        {
          nodeId: nodeIdBytes,
          flowId: flowIdBytes,
          kind: NodeKind.FOR,
          name: params.name,
          position: { x: params.position?.x ?? 0, y: params.position?.y ?? 0 },
        },
      ],
    });

    // Insert the for-specific configuration
    await client['nodeForInsert']({
      items: [
        {
          nodeId: nodeIdBytes,
          iterations: params.iterations,
          condition: params.condition,
          errorHandling: stringToErrorHandling(params.errorHandling),
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
