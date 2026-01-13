import { createClient } from '@connectrpc/connect';
import { FlowService, HandleKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { HandleKindType, ToolContext, ToolResult } from '../../types.ts';
import { generateUlid, generateUlidBytes, stringToHandleKind, ulidToBytes } from '../../utils.ts';

export interface ConnectNodesParams {
  flowId: string;
  sourceId: string;
  targetId: string;
  sourceHandle?: HandleKindType;
}

export interface ConnectNodesResult {
  edgeId: string;
}

/**
 * Create an edge connection between two nodes.
 */
export async function connectNodes(
  ctx: ToolContext,
  params: ConnectNodesParams,
): Promise<ToolResult<ConnectNodesResult>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const edgeIdBytes = generateUlidBytes();
    const edgeId = generateUlid();
    const flowIdBytes = ulidToBytes(params.flowId);
    const sourceIdBytes = ulidToBytes(params.sourceId);
    const targetIdBytes = ulidToBytes(params.targetId);

    const sourceHandle = params.sourceHandle ? stringToHandleKind(params.sourceHandle) : HandleKind.THEN;

    await client['edgeInsert']({
      items: [
        {
          edgeId: edgeIdBytes,
          flowId: flowIdBytes,
          sourceId: sourceIdBytes,
          targetId: targetIdBytes,
          sourceHandle,
        },
      ],
    });

    return {
      success: true,
      data: { edgeId },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
