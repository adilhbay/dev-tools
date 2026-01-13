import { createClient } from '@connectrpc/connect';
import {
  FlowService,
  NodeKind,
  type Edge,
  type Node,
  type NodeCondition,
  type NodeFor,
  type NodeForEach,
  type NodeHttp,
  type NodeJs,
} from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { NodeDetails, ToolContext, ToolResult } from '../../types.ts';
import {
  bytesToUlid,
  errorHandlingToString,
  flowItemStateToString,
  handleKindToString,
  nodeKindToString,
} from '../../utils.ts';

export interface GetNodeDetailsParams {
  nodeId: string;
}

/**
 * Get detailed information about a specific node including its configuration,
 * code (for JS nodes), and connections.
 */
export async function getNodeDetails(
  ctx: ToolContext,
  params: GetNodeDetailsParams,
): Promise<ToolResult<NodeDetails>> {
  try {
    const client = createClient(FlowService, ctx.transport);

    // Fetch base node info and edges
    const [nodeResponse, edgeResponse] = await Promise.all([client['nodeCollection']({}), client['edgeCollection']({})]);

    // Find the specific node
    const node = nodeResponse.items.find((n: Node) => bytesToUlid(n.nodeId) === params.nodeId);
    if (!node) {
      return {
        success: false,
        error: `Node not found: ${params.nodeId}`,
      };
    }

    const flowIdStr = bytesToUlid(node.flowId);

    // Get connected edges
    const incomingEdges = edgeResponse.items
      .filter((e: Edge) => bytesToUlid(e.targetId) === params.nodeId)
      .map((e: Edge) => ({
        edgeId: bytesToUlid(e.edgeId),
        sourceId: bytesToUlid(e.sourceId),
        sourceHandle: handleKindToString(e.sourceHandle),
      }));

    const outgoingEdges = edgeResponse.items
      .filter((e: Edge) => bytesToUlid(e.sourceId) === params.nodeId)
      .map((e: Edge) => ({
        edgeId: bytesToUlid(e.edgeId),
        targetId: bytesToUlid(e.targetId),
        sourceHandle: handleKindToString(e.sourceHandle),
      }));

    // Fetch node-specific configuration based on kind
    let config: NodeDetails['config'] = null;

    switch (node.kind) {
      case NodeKind.JS: {
        const jsResponse = await client['nodeJsCollection']({});
        const jsNode = jsResponse.items.find((js: NodeJs) => bytesToUlid(js.nodeId) === params.nodeId);
        if (jsNode) {
          config = { type: 'js', code: jsNode.code };
        }
        break;
      }
      case NodeKind.HTTP: {
        const httpResponse = await client['nodeHttpCollection']({});
        const httpNode = httpResponse.items.find((http: NodeHttp) => bytesToUlid(http.nodeId) === params.nodeId);
        if (httpNode) {
          const httpConfig: { type: 'http'; httpId: string; deltaHttpId?: string } = {
            type: 'http',
            httpId: bytesToUlid(httpNode.httpId),
          };
          if (httpNode.deltaHttpId && httpNode.deltaHttpId.length > 0) {
            httpConfig.deltaHttpId = bytesToUlid(httpNode.deltaHttpId);
          }
          config = httpConfig;
        }
        break;
      }
      case NodeKind.CONDITION: {
        const conditionResponse = await client['nodeConditionCollection']({});
        const conditionNode = conditionResponse.items.find((c: NodeCondition) => bytesToUlid(c.nodeId) === params.nodeId);
        if (conditionNode) {
          config = { type: 'condition', condition: conditionNode.condition };
        }
        break;
      }
      case NodeKind.FOR: {
        const forResponse = await client['nodeForCollection']({});
        const forNode = forResponse.items.find((f: NodeFor) => bytesToUlid(f.nodeId) === params.nodeId);
        if (forNode) {
          config = {
            type: 'for',
            iterations: forNode.iterations,
            condition: forNode.condition,
            errorHandling: errorHandlingToString(forNode.errorHandling),
          };
        }
        break;
      }
      case NodeKind.FOR_EACH: {
        const forEachResponse = await client['nodeForEachCollection']({});
        const forEachNode = forEachResponse.items.find((f: NodeForEach) => bytesToUlid(f.nodeId) === params.nodeId);
        if (forEachNode) {
          config = {
            type: 'for_each',
            path: forEachNode.path,
            condition: forEachNode.condition,
            errorHandling: errorHandlingToString(forEachNode.errorHandling),
          };
        }
        break;
      }
      case NodeKind.MANUAL_START: {
        config = { type: 'manual_start' };
        break;
      }
    }

    const nodeDetails: NodeDetails = {
      nodeId: params.nodeId,
      flowId: flowIdStr,
      kind: nodeKindToString(node.kind),
      name: node.name,
      state: flowItemStateToString(node.state),
      config,
      incomingEdges,
      outgoingEdges,
    };

    if (node.position) {
      nodeDetails.position = { x: node.position.x, y: node.position.y };
    }

    return {
      success: true,
      data: nodeDetails,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
