import { createClient } from '@connectrpc/connect';
import { FlowService } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ToolContext, ToolResult } from '../../types.ts';
import { ulidToBytes } from '../../utils.ts';

export interface StopWorkflowParams {
  flowId: string;
}

/**
 * Stop a running workflow execution.
 */
export async function stopWorkflow(ctx: ToolContext, params: StopWorkflowParams): Promise<ToolResult<void>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const flowIdBytes = ulidToBytes(params.flowId);

    await client['flowStop']({
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
