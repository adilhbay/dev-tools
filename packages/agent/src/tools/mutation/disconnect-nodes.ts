import { createClient } from '@connectrpc/connect';
import { FlowService } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ToolContext, ToolResult } from '../../types.ts';
import { ulidToBytes } from '../../utils.ts';

export interface DisconnectNodesParams {
  edgeId: string;
}

/**
 * Remove an edge connection between nodes.
 */
export async function disconnectNodes(ctx: ToolContext, params: DisconnectNodesParams): Promise<ToolResult<void>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const edgeIdBytes = ulidToBytes(params.edgeId);

    await client['edgeDelete']({
      items: [{ edgeId: edgeIdBytes }],
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
