import { createClient } from '@connectrpc/connect';
import { FlowService } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ToolContext, ToolResult } from '../../types.ts';
import { ulidToBytes } from '../../utils.ts';
import { validateJsFunctionBody } from './validate-js-code.ts';

export interface UpdateNodeCodeParams {
  nodeId: string;
  code: string;
}

/**
 * Update the JavaScript code of a JS node.
 */
export async function updateNodeCode(ctx: ToolContext, params: UpdateNodeCodeParams): Promise<ToolResult<void>> {
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
    const nodeIdBytes = ulidToBytes(params.nodeId);

    // Wrap code with export default function
    const wrappedCode = `export default function(ctx) {\n${params.code}\n}`;
    await client['nodeJsUpdate']({
      items: [
        {
          nodeId: nodeIdBytes,
          code: wrappedCode,
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
