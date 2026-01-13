import { createClient } from '@connectrpc/connect';
import { FlowService } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ToolContext, ToolResult } from '../../types.ts';
import { ulidToBytes } from '../../utils.ts';

export interface UpdateNodeCodeParams {
  nodeId: string;
  code: string;
}

/**
 * Update the JavaScript code of a JS node.
 */
export async function updateNodeCode(ctx: ToolContext, params: UpdateNodeCodeParams): Promise<ToolResult<void>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const nodeIdBytes = ulidToBytes(params.nodeId);

    await client['nodeJsUpdate']({
      items: [
        {
          nodeId: nodeIdBytes,
          code: params.code,
        },
      ],
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
