import { createClient } from '@connectrpc/connect';
import { FlowService } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { Position, ToolContext, ToolResult } from '../../types.ts';
import { ulidToBytes } from '../../utils.ts';

export interface UpdateNodeConfigParams {
  nodeId: string;
  name?: string;
  position?: Position;
}

/**
 * Update general node properties like name or position.
 */
export async function updateNodeConfig(ctx: ToolContext, params: UpdateNodeConfigParams): Promise<ToolResult<void>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const nodeIdBytes = ulidToBytes(params.nodeId);

    const update: {
      nodeId: Uint8Array;
      name?: string;
      positionX?: number;
      positionY?: number;
    } = {
      nodeId: nodeIdBytes,
    };

    if (params.name !== undefined) {
      update.name = params.name;
    }

    if (params.position !== undefined) {
      update.positionX = params.position.x;
      update.positionY = params.position.y;
    }

    await client['nodeUpdate']({
      items: [update],
    });

    return {
      success: true,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
