import { eq, useLiveQuery } from '@tanstack/react-db';
import { Ulid } from 'id128';
import { NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import {
  EdgeCollectionSchema,
  FlowVariableCollectionSchema,
  NodeCollectionSchema,
} from '@the-dev-tools/spec/tanstack-db/v1/api/flow';
import { useApiCollection } from '~/shared/api';
import type { EdgeInfo, FlowContextData, NodeInfo, VariableInfo } from './types';

const NODE_KIND_NAMES: Record<number, string> = {
  [NodeKind.UNSPECIFIED]: 'Unknown',
  [NodeKind.MANUAL_START]: 'ManualStart',
  [NodeKind.HTTP]: 'HTTP',
  [NodeKind.CONDITION]: 'Condition',
  [NodeKind.FOR]: 'For',
  [NodeKind.FOR_EACH]: 'ForEach',
  [NodeKind.JS]: 'JavaScript',
};

export const useFlowContext = (flowId: Uint8Array): FlowContextData => {
  const nodeCollection = useApiCollection(NodeCollectionSchema);
  const edgeCollection = useApiCollection(EdgeCollectionSchema);
  const variableCollection = useApiCollection(FlowVariableCollectionSchema);

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

  const nodes: NodeInfo[] = (nodesData ?? [])
    .filter((n) => n.nodeId != null)
    .map((n) => ({
      id: Ulid.construct(n.nodeId).toCanonical(),
      name: n.name,
      kind: NODE_KIND_NAMES[n.kind] ?? 'Unknown',
      position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
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

  return {
    flowId: Ulid.construct(flowId).toCanonical(),
    nodes,
    edges,
    variables,
  };
};

export const buildSystemPrompt = (context: FlowContextData): string => {
  const nodesList = context.nodes
    .map((n) => `  - ${n.name} (ID: ${n.id}, Type: ${n.kind}, Position: ${n.position.x},${n.position.y})`)
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

  return `You are a workflow automation assistant. You help users create and modify workflow nodes using natural language.

Current Workflow State (ID: ${context.flowId}):

NODES:
${nodesList || '  (no nodes)'}

CONNECTIONS:
${edgesList || '  (no connections)'}

VARIABLES:
${variablesList || '  (no variables)'}

IMPORTANT RULES:
1. When creating nodes, always provide a position. Place new nodes below existing ones (increase Y by ~150).
2. To find the start node, look for a node with kind "ManualStart".
3. When connecting nodes, use the node IDs from above.
4. For JavaScript nodes, provide the function body directly - it will be wrapped in "export default function(ctx) { ... }".
5. Use connectSequentialNodes for ManualStart, JavaScript, and HTTP nodes.
6. Use connectBranchingNodes for Condition, For, and ForEach nodes (requires sourceHandle: "then", "else", or "loop").
7. Always confirm what you did after executing tools.`;
};
