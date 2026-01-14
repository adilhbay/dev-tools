import { createClient } from '@connectrpc/connect';
import { FlowService, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { Position, ToolContext, ToolResult } from '../../types.ts';
import { bytesToUlid, generateUlidBytes, ulidToBytes } from '../../utils.ts';

export interface CreateHttpNodeParams {
  flowId: string;
  name: string;
  httpId: string;
  position?: Position;
}

export interface CreateHttpNodeResult {
  nodeId: string;
}

/**
 * Create a new HTTP request node in the workflow.
 */
export async function createHttpNode(
  ctx: ToolContext,
  params: CreateHttpNodeParams,
): Promise<ToolResult<CreateHttpNodeResult>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const nodeIdBytes = generateUlidBytes();
    const nodeId = bytesToUlid(nodeIdBytes);
    const flowIdBytes = ulidToBytes(params.flowId);
    const httpIdBytes = ulidToBytes(params.httpId);

    // Insert the base node first
    await client['nodeInsert']({
      items: [
        {
          nodeId: nodeIdBytes,
          flowId: flowIdBytes,
          kind: NodeKind.HTTP,
          name: params.name,
          position: { x: params.position?.x ?? 0, y: params.position?.y ?? 0 },
        },
      ],
    });

    // Insert the HTTP-specific configuration
    await client['nodeHttpInsert']({
      items: [
        {
          nodeId: nodeIdBytes,
          httpId: httpIdBytes,
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
