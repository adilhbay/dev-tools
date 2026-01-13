import { createClient } from '@connectrpc/connect';
import { FlowService } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ToolContext, ToolResult } from '../../types.ts';
import { ulidToBytes } from '../../utils.ts';

export interface DeleteNodeParams {
  nodeId: string;
}

/**
 * Delete a node from the workflow. Also removes all connected edges.
 */
export async function deleteNode(ctx: ToolContext, params: DeleteNodeParams): Promise<ToolResult<void>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const nodeIdBytes = ulidToBytes(params.nodeId);

    await client['nodeDelete']({
      items: [{ nodeId: nodeIdBytes }],
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
