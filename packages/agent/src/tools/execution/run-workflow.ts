import { createClient } from '@connectrpc/connect';
import { FlowService } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ToolContext, ToolResult } from '../../types.ts';
import { ulidToBytes } from '../../utils.ts';

export interface RunWorkflowParams {
  flowId: string;
}

/**
 * Execute the workflow from the start node.
 */
export async function runWorkflow(ctx: ToolContext, params: RunWorkflowParams): Promise<ToolResult<void>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const flowIdBytes = ulidToBytes(params.flowId);

    await client['flowRun']({
      flowId: flowIdBytes,
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
