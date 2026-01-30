import { eq, useLiveQuery } from '@tanstack/react-db';
import { Ulid } from 'id128';
import { FlowItemState, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import { HttpMethod } from '@the-dev-tools/spec/buf/api/http/v1/http_pb';
import {
  EdgeCollectionSchema,
  FlowVariableCollectionSchema,
  NodeCollectionSchema,
  NodeExecutionCollectionSchema,
  NodeHttpCollectionSchema,
} from '@the-dev-tools/spec/tanstack-db/v1/api/flow';
import { HttpCollectionSchema } from '@the-dev-tools/spec/tanstack-db/v1/api/http';
import { useApiCollection } from '~/shared/api';
import type { EdgeInfo, FlowContextData, NodeExecutionInfo, NodeInfo, VariableInfo } from './types';

const NODE_KIND_NAMES: Record<number, string> = {
  [NodeKind.UNSPECIFIED]: 'Unknown',
  [NodeKind.MANUAL_START]: 'ManualStart',
  [NodeKind.HTTP]: 'HTTP',
  [NodeKind.CONDITION]: 'Condition',
  [NodeKind.FOR]: 'For',
  [NodeKind.FOR_EACH]: 'ForEach',
  [NodeKind.JS]: 'JavaScript',
};

const FLOW_ITEM_STATE_NAMES: Record<number, string> = {
  [FlowItemState.UNSPECIFIED]: 'Idle',
  [FlowItemState.RUNNING]: 'Running',
  [FlowItemState.SUCCESS]: 'Success',
  [FlowItemState.FAILURE]: 'Failure',
  [FlowItemState.CANCELED]: 'Canceled',
};

const HTTP_METHOD_NAMES: Record<number, string> = {
  [HttpMethod.UNSPECIFIED]: 'UNSPECIFIED',
  [HttpMethod.GET]: 'GET',
  [HttpMethod.POST]: 'POST',
  [HttpMethod.PUT]: 'PUT',
  [HttpMethod.PATCH]: 'PATCH',
  [HttpMethod.DELETE]: 'DELETE',
  [HttpMethod.HEAD]: 'HEAD',
  [HttpMethod.OPTIONS]: 'OPTIONS',
};

export const useFlowContext = (flowId: Uint8Array): FlowContextData => {
  const nodeCollection = useApiCollection(NodeCollectionSchema);
  const edgeCollection = useApiCollection(EdgeCollectionSchema);
  const variableCollection = useApiCollection(FlowVariableCollectionSchema);
  const executionCollection = useApiCollection(NodeExecutionCollectionSchema);
  const nodeHttpCollection = useApiCollection(NodeHttpCollectionSchema);
  const httpCollection = useApiCollection(HttpCollectionSchema);

  const { data: nodesData } = useLiveQuery(
    (_) =>
      _.from({ node: nodeCollection }).where((_) => eq(_.node.flowId, flowId)),
    [nodeCollection, flowId],
  );

  const { data: edgesData } = useLiveQuery(
    (_) =>
      _.from({ edge: edgeCollection }).where((_) => eq(_.edge.flowId, flowId)),
    [edgeCollection, flowId],
  );

  const { data: variablesData } = useLiveQuery(
    (_) =>
      _.from({ variable: variableCollection }).where((_) =>
        eq(_.variable.flowId, flowId),
      ),
    [variableCollection, flowId],
  );

  // Get all node IDs from the current flow as a Set for efficient lookup
  const nodeIdSet = new Set(
    (nodesData ?? [])
      .filter((n) => n.nodeId != null)
      .map((n) => Ulid.construct(n.nodeId).toCanonical()),
  );

  // Get all executions - we'll filter in memory by node IDs
  const { data: allExecutionsData } = useLiveQuery(
    (_) => _.from({ exec: executionCollection }),
    [executionCollection],
  );

  // Filter executions to only those belonging to nodes in this flow
  const executionsData = (allExecutionsData ?? []).filter(
    (e) => e.nodeId != null && nodeIdSet.has(Ulid.construct(e.nodeId).toCanonical()),
  );

  // Get all nodeHttp mappings for HTTP nodes
  const { data: nodeHttpData } = useLiveQuery(
    (_) => _.from({ nodeHttp: nodeHttpCollection }),
    [nodeHttpCollection],
  );

  // Build a map of nodeId -> httpId for quick lookup
  const nodeHttpMap = new Map(
    (nodeHttpData ?? [])
      .filter((nh) => nh.nodeId != null && nh.httpId != null)
      .map((nh) => [Ulid.construct(nh.nodeId).toCanonical(), Ulid.construct(nh.httpId).toCanonical()]),
  );

  // Get all HTTP requests to fetch their methods
  const { data: httpData } = useLiveQuery(
    (_) => _.from({ http: httpCollection }),
    [httpCollection],
  );

  // Build a map of httpId -> method for quick lookup
  const httpMethodMap = new Map(
    (httpData ?? [])
      .filter((h) => h.httpId != null)
      .map((h) => [Ulid.construct(h.httpId).toCanonical(), HTTP_METHOD_NAMES[h.method] ?? 'UNSPECIFIED']),
  );

  const nodes: NodeInfo[] = (nodesData ?? [])
    .filter((n) => n.nodeId != null)
    .map((n) => {
      const nodeIdStr = Ulid.construct(n.nodeId).toCanonical();
      const httpId = n.kind === NodeKind.HTTP ? nodeHttpMap.get(nodeIdStr) : undefined;
      const httpMethod = httpId ? httpMethodMap.get(httpId) : undefined;
      return {
        id: nodeIdStr,
        name: n.name,
        kind: NODE_KIND_NAMES[n.kind] ?? 'Unknown',
        position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
        state: FLOW_ITEM_STATE_NAMES[n.state] ?? 'Idle',
        info: n.info ?? undefined,
        httpId,
        httpMethod,
      };
    });

  const edges: EdgeInfo[] = (edgesData ?? [])
    .filter((e) => e.edgeId != null)
    .map((e) => ({
      id: Ulid.construct(e.edgeId).toCanonical(),
      sourceId: Ulid.construct(e.sourceId).toCanonical(),
      targetId: Ulid.construct(e.targetId).toCanonical(),
      sourceHandle: e.sourceHandle !== undefined ? String(e.sourceHandle) : undefined,
    }));

  const variables: VariableInfo[] = (variablesData ?? [])
    .filter((v) => v.flowVariableId != null)
    .map((v) => ({
      id: Ulid.construct(v.flowVariableId).toCanonical(),
      key: v.key,
      value: v.value,
      enabled: v.enabled,
    }));

  const executions: NodeExecutionInfo[] = (executionsData ?? [])
    .filter((e) => e.nodeExecutionId != null)
    .map((e) => ({
      id: Ulid.construct(e.nodeExecutionId).toCanonical(),
      nodeId: Ulid.construct(e.nodeId).toCanonical(),
      name: e.name,
      state: FLOW_ITEM_STATE_NAMES[e.state] ?? 'Idle',
      error: e.error ?? undefined,
      input: e.input ?? undefined,
      output: e.output ?? undefined,
      completedAt: e.completedAt instanceof Date ? e.completedAt.toISOString() : e.completedAt,
    }));

  return {
    flowId: Ulid.construct(flowId).toCanonical(),
    nodes,
    edges,
    variables,
    executions,
  };
};

export const buildSystemPrompt = (context: FlowContextData): string => {
  const nodesList = context.nodes
    .map((n) => {
      const stateInfo = n.state !== 'Idle' ? `, State: ${n.state}` : '';
      const errorInfo = n.info ? `, Error: "${n.info}"` : '';
      const methodInfo = n.httpMethod ? `, Method: ${n.httpMethod}` : '';
      return `  - ${n.name} (ID: ${n.id}, Type: ${n.kind}${methodInfo}${stateInfo}${errorInfo})`;
    })
    .join('\n');

  const edgesList = context.edges
    .map((e) => {
      const sourceNode = context.nodes.find((n) => n.id === e.sourceId);
      const targetNode = context.nodes.find((n) => n.id === e.targetId);
      const handleInfo = e.sourceHandle ? ` via ${e.sourceHandle}` : '';
      return `  - ${sourceNode?.name ?? e.sourceId} -> ${targetNode?.name ?? e.targetId}${handleInfo}`;
    })
    .join('\n');

  const variablesList = context.variables
    .filter((v) => v.enabled)
    .map((v) => `  - ${v.key}: ${v.value}`)
    .join('\n');

  // Find nodes with errors (state is Failure)
  const failedNodes = context.nodes.filter((n) => n.state === 'Failure');
  const failedExecutions = context.executions.filter((e) => e.state === 'Failure' && e.error);

  let errorSection = '';
  if (failedNodes.length > 0 || failedExecutions.length > 0) {
    const errorDetails = failedExecutions.map((e) => {
      const node = context.nodes.find((n) => n.id === e.nodeId);
      return `  - ${node?.name ?? e.nodeId}: ${e.error}`;
    }).join('\n');

    errorSection = `

ERRORS (nodes that failed during execution):
${errorDetails || '  (no detailed error info available)'}`;
  }

  return `You are a workflow automation assistant. You help users create and modify workflow nodes using natural language.

Current Workflow State (ID: ${context.flowId}):

NODES:
${nodesList || '  (no nodes)'}

CONNECTIONS:
${edgesList || '  (no connections)'}

VARIABLES:
${variablesList || '  (no variables)'}${buildSelectedNodesSection(context)}${errorSection}

IMPORTANT RULES:
1. To find the start node, look for a node with kind "ManualStart".
2. When connecting nodes, use the node IDs from above.
3. For JavaScript nodes, provide the function body directly - it will be wrapped in "export default function(ctx) { ... }".
4. Use connectSequentialNodes for ManualStart, JavaScript, and HTTP nodes.
5. Use connectBranchingNodes for Condition, For, and ForEach nodes (requires sourceHandle: "then", "else", or "loop").
6. Always confirm what you did after executing tools.
7. If a node has State: Failure, use getNodeExecutions to get detailed error information.
8. Use getNodeOutput to inspect the input/output data of a node's most recent execution.
9. When the user has nodes selected, prefer operating on those nodes unless they specify otherwise.
10. Node positions are automatically calculated - you do not need to specify positions when creating nodes.`;
};

const buildSelectedNodesSection = (context: FlowContextData): string => {
  if (!context.selectedNodeIds || context.selectedNodeIds.length === 0) return '';

  const selectedList = context.selectedNodeIds
    .map((id) => {
      const node = context.nodes.find((n) => n.id === id);
      if (!node) return `  - (unknown node, ID: ${id})`;
      return `  - ${node.name} (ID: ${node.id}, Type: ${node.kind})`;
    })
    .join('\n');

  return `

SELECTED NODES (currently selected on canvas):
${selectedList}`;
};
