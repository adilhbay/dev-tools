import { createClient } from '@connectrpc/connect';
import {
  FlowService,
  NodeKind,
  type Edge,
  type Flow,
  type Node,
  type NodeCondition,
  type NodeFor,
  type NodeForEach,
  type NodeHttp,
  type NodeJs,
} from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ToolContext, ToolResult } from '../../types.ts';
import { bytesToUlid, nodeKindToString } from '../../utils.ts';

export interface ValidateWorkflowParams {
  flowId: string;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidateWorkflowResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * Validate the workflow for errors, missing connections, or configuration issues.
 */
export async function validateWorkflow(
  ctx: ToolContext,
  params: ValidateWorkflowParams,
): Promise<ToolResult<ValidateWorkflowResult>> {
  try {
    const client = createClient(FlowService, ctx.transport);
    const issues: ValidationIssue[] = [];

    // Fetch all data
    const [flowResponse, nodeResponse, edgeResponse, jsResponse, httpResponse, conditionResponse, forResponse, forEachResponse] =
      await Promise.all([
        client['flowCollection']({}),
        client['nodeCollection']({}),
        client['edgeCollection']({}),
        client['nodeJsCollection']({}),
        client['nodeHttpCollection']({}),
        client['nodeConditionCollection']({}),
        client['nodeForCollection']({}),
        client['nodeForEachCollection']({}),
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
    const nodes = nodeResponse.items.filter((n: Node) => bytesToUlid(n.flowId) === params.flowId);
    const edges = edgeResponse.items.filter((e: Edge) => bytesToUlid(e.flowId) === params.flowId);

    // Create lookup maps
    const nodeIdSet = new Set(nodes.map((n: Node) => bytesToUlid(n.nodeId)));
    const jsNodeIds = new Set(jsResponse.items.map((js: NodeJs) => bytesToUlid(js.nodeId)));
    const httpNodeIds = new Set(httpResponse.items.map((http: NodeHttp) => bytesToUlid(http.nodeId)));
    const conditionNodeIds = new Set(conditionResponse.items.map((c: NodeCondition) => bytesToUlid(c.nodeId)));
    const forNodeIds = new Set(forResponse.items.map((f: NodeFor) => bytesToUlid(f.nodeId)));
    const forEachNodeIds = new Set(forEachResponse.items.map((f: NodeForEach) => bytesToUlid(f.nodeId)));

    // Check 1: Must have a start node
    const startNodes = nodes.filter((n: Node) => n.kind === NodeKind.MANUAL_START);
    if (startNodes.length === 0) {
      issues.push({
        severity: 'error',
        message: 'Workflow must have a start node (MANUAL_START)',
      });
    } else if (startNodes.length > 1) {
      issues.push({
        severity: 'error',
        message: `Workflow has ${startNodes.length} start nodes, should have exactly 1`,
      });
    }

    // Check 2: Validate node configurations exist
    for (const node of nodes) {
      const nodeId = bytesToUlid(node.nodeId);
      const kind = node.kind;

      switch (kind) {
        case NodeKind.JS:
          if (!jsNodeIds.has(nodeId)) {
            issues.push({
              severity: 'error',
              message: `JS node "${node.name}" is missing configuration`,
              nodeId,
            });
          }
          break;
        case NodeKind.HTTP:
          if (!httpNodeIds.has(nodeId)) {
            issues.push({
              severity: 'error',
              message: `HTTP node "${node.name}" is missing configuration`,
              nodeId,
            });
          }
          break;
        case NodeKind.CONDITION:
          if (!conditionNodeIds.has(nodeId)) {
            issues.push({
              severity: 'error',
              message: `Condition node "${node.name}" is missing configuration`,
              nodeId,
            });
          }
          break;
        case NodeKind.FOR:
          if (!forNodeIds.has(nodeId)) {
            issues.push({
              severity: 'error',
              message: `For node "${node.name}" is missing configuration`,
              nodeId,
            });
          }
          break;
        case NodeKind.FOR_EACH:
          if (!forEachNodeIds.has(nodeId)) {
            issues.push({
              severity: 'error',
              message: `ForEach node "${node.name}" is missing configuration`,
              nodeId,
            });
          }
          break;
      }
    }

    // Check 3: Validate edges reference existing nodes
    for (const edge of edges) {
      const edgeId = bytesToUlid(edge.edgeId);
      const sourceId = bytesToUlid(edge.sourceId);
      const targetId = bytesToUlid(edge.targetId);

      if (!nodeIdSet.has(sourceId)) {
        issues.push({
          severity: 'error',
          message: `Edge references non-existent source node: ${sourceId}`,
          edgeId,
        });
      }

      if (!nodeIdSet.has(targetId)) {
        issues.push({
          severity: 'error',
          message: `Edge references non-existent target node: ${targetId}`,
          edgeId,
        });
      }
    }

    // Check 4: Nodes should be connected (except start node should have outgoing)
    const nodesWithIncoming = new Set(edges.map((e: Edge) => bytesToUlid(e.targetId)));
    const nodesWithOutgoing = new Set(edges.map((e: Edge) => bytesToUlid(e.sourceId)));

    for (const node of nodes) {
      const nodeId = bytesToUlid(node.nodeId);

      // Start node should have outgoing edges
      if (node.kind === NodeKind.MANUAL_START) {
        if (!nodesWithOutgoing.has(nodeId)) {
          issues.push({
            severity: 'warning',
            message: `Start node "${node.name}" has no outgoing connections`,
            nodeId,
          });
        }
        continue;
      }

      // Other nodes should have incoming edges
      if (!nodesWithIncoming.has(nodeId)) {
        issues.push({
          severity: 'warning',
          message: `Node "${node.name}" (${nodeKindToString(node.kind)}) has no incoming connections and will never execute`,
          nodeId,
        });
      }
    }

    return {
      success: true,
      data: {
        valid: issues.filter((i) => i.severity === 'error').length === 0,
        issues,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
