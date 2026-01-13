import { createClient } from '@connectrpc/connect';
import { FlowService, type FlowVersion } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ToolContext, ToolResult } from '../../types.ts';
import { bytesToUlid } from '../../utils.ts';

export interface GetExecutionHistoryParams {
  flowId: string;
  limit?: number;
}

export interface ExecutionHistoryItem {
  flowVersionId: string;
  flowId: string;
}

export interface ExecutionHistoryResult {
  executions: ExecutionHistoryItem[];
}

/**
 * Get the history of past workflow executions/versions.
 */
export async function getExecutionHistory(
  ctx: ToolContext,
  params: GetExecutionHistoryParams,
): Promise<ToolResult<ExecutionHistoryResult>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const limit = params.limit ?? 10;

    // Fetch flow versions (these represent saved states/executions)
    const response = await client['flowVersionCollection']({});

    // Filter for the specific flow and apply limit
    const executions = response.items
      .filter((v: FlowVersion) => bytesToUlid(v.flowId) === params.flowId)
      .slice(0, limit)
      .map((v: FlowVersion) => ({
        flowVersionId: bytesToUlid(v.flowVersionId),
        flowId: bytesToUlid(v.flowId),
      }));

    return {
      success: true,
      data: { executions },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
