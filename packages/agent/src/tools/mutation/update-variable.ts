import { createClient } from '@connectrpc/connect';
import { FlowService } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ToolContext, ToolResult } from '../../types.ts';
import { ulidToBytes } from '../../utils.ts';

export interface UpdateVariableParams {
  flowVariableId: string;
  key?: string;
  value?: string;
  description?: string;
  enabled?: boolean;
}

/**
 * Update an existing workflow variable.
 */
export async function updateVariable(ctx: ToolContext, params: UpdateVariableParams): Promise<ToolResult<void>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const flowVariableIdBytes = ulidToBytes(params.flowVariableId);

    const update: {
      flowVariableId: Uint8Array;
      key?: string;
      value?: string;
      description?: string;
      enabled?: boolean;
    } = {
      flowVariableId: flowVariableIdBytes,
    };

    if (params.key !== undefined) {
      update.key = params.key;
    }
    if (params.value !== undefined) {
      update.value = params.value;
    }
    if (params.description !== undefined) {
      update.description = params.description;
    }
    if (params.enabled !== undefined) {
      update.enabled = params.enabled;
    }

    await client['flowVariableUpdate']({
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
