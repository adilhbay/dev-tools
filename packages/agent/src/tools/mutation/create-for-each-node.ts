import { createClient } from '@connectrpc/connect';
import { FlowService, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ErrorHandlingStrategy, Position, ToolContext, ToolResult } from '../../types.ts';
import { bytesToUlid, generateUlidBytes, stringToErrorHandling, ulidToBytes } from '../../utils.ts';

export interface CreateForEachNodeParams {
  flowId: string;
  name: string;
  path: string;
  condition: string;
  errorHandling: ErrorHandlingStrategy;
  position?: Position;
}

export interface CreateForEachNodeResult {
  nodeId: string;
}

/**
 * Create a forEach node that iterates over an array or object.
 */
export async function createForEachNode(
  ctx: ToolContext,
  params: CreateForEachNodeParams,
): Promise<ToolResult<CreateForEachNodeResult>> {
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
          kind: NodeKind.FOR_EACH,
          name: params.name,
          position: { x: params.position?.x ?? 0, y: params.position?.y ?? 0 },
        },
      ],
    });

    // Insert the forEach-specific configuration
    await client['nodeForEachInsert']({
      items: [
        {
          nodeId: nodeIdBytes,
          path: params.path,
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
