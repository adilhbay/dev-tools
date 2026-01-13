import { createClient } from '@connectrpc/connect';
import { FlowService } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ToolContext, ToolResult } from '../../types.ts';
import { generateUlid, generateUlidBytes, ulidToBytes } from '../../utils.ts';

export interface CreateVariableParams {
  flowId: string;
  key: string;
  value: string;
  description?: string;
  enabled?: boolean;
}

export interface CreateVariableResult {
  flowVariableId: string;
}

/**
 * Create a new workflow variable that can be referenced in node expressions.
 */
export async function createVariable(
  ctx: ToolContext,
  params: CreateVariableParams,
): Promise<ToolResult<CreateVariableResult>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const flowVariableIdBytes = generateUlidBytes();
    const flowVariableId = generateUlid();
    const flowIdBytes = ulidToBytes(params.flowId);

    await client['flowVariableInsert']({
      items: [
        {
          flowVariableId: flowVariableIdBytes,
          flowId: flowIdBytes,
          key: params.key,
          value: params.value,
          description: params.description ?? '',
          enabled: params.enabled ?? true,
          order: 0, // Will be positioned at the beginning
        },
      ],
    });

    return {
      success: true,
      data: { flowVariableId },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
