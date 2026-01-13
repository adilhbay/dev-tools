import { createClient } from '@connectrpc/connect';
import { FlowService, type Edge, type Flow, type Node } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ToolContext, ToolResult, WorkflowGraph } from '../../types.ts';
import { bytesToUlid, flowItemStateToString, handleKindToString, nodeKindToString } from '../../utils.ts';

export interface GetWorkflowGraphParams {
  flowId: string;
}

/**
 * Get the complete workflow graph including all nodes and edges.
 */
export async function getWorkflowGraph(
  ctx: ToolContext,
  params: GetWorkflowGraphParams,
): Promise<ToolResult<WorkflowGraph>> {
  try {
    const client = createClient(FlowService, ctx.transport);

    // Fetch flow, nodes, and edges in parallel
    const [flowResponse, nodeResponse, edgeResponse] = await Promise.all([
      client['flowCollection']({}),
      client['nodeCollection']({}),
      client['edgeCollection']({}),
    ]);

    // Find the specific flow
    const flow = flowResponse.items.find((f: Flow) => bytesToUlid(f.flowId) === params.flowId);
    if (!flow) {
      return {
        success: false,
        error: `Flow not found: ${params.flowId}`,
      };
    }

    // Filter nodes and edges for this flow
    const flowIdStr = params.flowId;
    const nodes = nodeResponse.items
      .filter((n: Node) => bytesToUlid(n.flowId) === flowIdStr)
      .map((n: Node) => {
        const nodeData: {
          nodeId: string;
          kind: ReturnType<typeof nodeKindToString>;
          name: string;
          position?: { x: number; y: number };
          state: ReturnType<typeof flowItemStateToString>;
        } = {
          nodeId: bytesToUlid(n.nodeId),
          kind: nodeKindToString(n.kind),
          name: n.name,
          state: flowItemStateToString(n.state),
        };
        if (n.position) {
          nodeData.position = { x: n.position.x, y: n.position.y };
        }
        return nodeData;
      });

    const edges = edgeResponse.items
      .filter((e: Edge) => bytesToUlid(e.flowId) === flowIdStr)
      .map((e: Edge) => ({
        edgeId: bytesToUlid(e.edgeId),
        sourceId: bytesToUlid(e.sourceId),
        targetId: bytesToUlid(e.targetId),
        sourceHandle: handleKindToString(e.sourceHandle),
        state: flowItemStateToString(e.state),
      }));

    return {
      success: true,
      data: {
        flow: {
          flowId: bytesToUlid(flow.flowId),
          name: flow.name,
          running: flow.running,
        },
        nodes,
        edges,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
