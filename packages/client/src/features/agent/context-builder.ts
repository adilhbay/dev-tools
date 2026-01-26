import { eq, useLiveQuery } from '@tanstack/react-db';
import { Ulid } from 'id128';
import { FlowItemState, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import {
  EdgeCollectionSchema,
  FlowVariableCollectionSchema,
  NodeCollectionSchema,
  NodeExecutionCollectionSchema,
} from '@the-dev-tools/spec/tanstack-db/v1/api/flow';
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

export const useFlowContext = (flowId: Uint8Array): FlowContextData => {
  const nodeCollection = useApiCollection(NodeCollectionSchema);
  const edgeCollection = useApiCollection(EdgeCollectionSchema);
  const variableCollection = useApiCollection(FlowVariableCollectionSchema);
  const executionCollection = useApiCollection(NodeExecutionCollectionSchema);

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

  const nodes: NodeInfo[] = (nodesData ?? [])
    .filter((n) => n.nodeId != null)
    .map((n) => ({
      id: Ulid.construct(n.nodeId).toCanonical(),
      name: n.name,
      kind: NODE_KIND_NAMES[n.kind] ?? 'Unknown',
      position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
      state: FLOW_ITEM_STATE_NAMES[n.state] ?? 'Idle',
      info: n.info ?? undefined,
    }));

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
      return `  - ${n.name} (ID: ${n.id}, Type: ${n.kind}${stateInfo}${errorInfo})`;
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
${variablesList || '  (no variables)'}${errorSection}

IMPORTANT RULES:
1. When creating nodes, always provide a position. Place new nodes below existing ones (increase Y by ~150).
2. To find the start node, look for a node with kind "ManualStart".
3. When connecting nodes, use the node IDs from above.
4. For JavaScript nodes, provide the function body directly - it will be wrapped in "export default function(ctx) { ... }".
5. Use connectSequentialNodes for ManualStart, JavaScript, and HTTP nodes.
6. Use connectBranchingNodes for Condition, For, and ForEach nodes (requires sourceHandle: "then", "else", or "loop").
7. Always confirm what you did after executing tools.
8. If a node has State: Failure, use getNodeExecutions to get detailed error information.`;
};
