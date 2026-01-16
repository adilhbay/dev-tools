import { createClient } from '@connectrpc/connect';
import { FlowService, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { Position, ToolContext, ToolResult } from '../../types.ts';
import { bytesToUlid, generateUlidBytes, ulidToBytes } from '../../utils.ts';
import { validateJsFunctionBody } from './validate-js-code.ts';

export interface CreateJsNodeParams {
  flowId: string;
  name: string;
  code: string;
  position?: Position;
}

export interface CreateJsNodeResult {
  nodeId: string;
}

/**
 * Create a new JavaScript node in the workflow.
 */
export async function createJsNode(
  ctx: ToolContext,
  params: CreateJsNodeParams,
): Promise<ToolResult<CreateJsNodeResult>> {
  // Validate the function body before proceeding
  const validation = validateJsFunctionBody(params.code);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
    };
  }

  try {
    const client = createClient(FlowService, ctx.transport);
    const nodeIdBytes = generateUlidBytes();
    const nodeId = bytesToUlid(nodeIdBytes);
    const flowIdBytes = ulidToBytes(params.flowId);

    // Insert the base node first
    await client['nodeInsert']({
      items: [
        {
          nodeId: nodeIdBytes,
          flowId: flowIdBytes,
          kind: NodeKind.JS,
          name: params.name,
          position: { x: params.position?.x ?? 0, y: params.position?.y ?? 0 },
        },
      ],
    });

    // Insert the JS-specific configuration (wrap code with export default function)
    const wrappedCode = `export default function(ctx) {\n${params.code}\n}`;
    await client['nodeJsInsert']({
      items: [
        {
          nodeId: nodeIdBytes,
          code: wrappedCode,
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
