import type { Transport } from '@connectrpc/connect';
import { Ulid } from 'id128';
import { FlowService, HandleKind, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import { HttpMethod } from '@the-dev-tools/spec/buf/api/http/v1/http_pb';
import { request } from '~/shared/api';
import type { AgentPhase } from './agent-phases';
import { PHASE_TRANSITION_TOOL_NAME, requiresUserConfirmation, validatePhaseTransition } from './agent-phases';
import type { EdgeInfo, FlowContextData, NodeInfo, ToolCall, ToolResult, PlanMutationArgs } from './types';
import { executePlanMutation } from './plan-mutation-tool';
import { AgentTelemetry } from './telemetry';

type CollectionUtils = ReturnType<typeof import('~/shared/api').useApiCollection>['utils'];
type CollectionData = ReturnType<typeof import('~/shared/api').useApiCollection>;

/**
 * Normalizes JS code references by replacing whitespace with underscores in node names.
 * - ["Node Name"].field → ["Node_Name"].field
 */
function normalizeJsCodeReferences(code: string): string {
  if (!code) return code;

  // Pattern: ["NodeName"] - replace whitespace in node name with underscores
  return code.replace(
    /\["([^"]+)"\]/g,
    (_, nodeName) => `["${nodeName.replace(/\s+/g, '_')}"]`,
  );
}

/**
 * Normalizes condition expressions by:
 * - Removing bracket/quote syntax: ["NodeName"].field → NodeName.field
 * - Replacing whitespace with underscores in node names
 * - Converting JS strict equality/inequality to expr-lang operators
 */
function normalizeConditionSyntax(expr: string): string {
  if (!expr) return expr;

  // Pattern: ["NodeName"] - convert to plain identifier with underscores
  let normalized = expr.replace(
    /\["([^"]+)"\]/g,
    (_, nodeName) => nodeName.replace(/\s+/g, '_'),
  );

  // Convert JS strict equality/inequality to expr-lang operators
  normalized = normalized.replace(/===/g, '==');
  normalized = normalized.replace(/!==/g, '!=');

  return normalized;
}

/**
 * Normalizes node names by replacing whitespace with underscores.
 */
function normalizeNodeName(name: string): string {
  if (!name) return name;
  return name.replace(/\s+/g, '_');
}

interface Collections {
  nodeCollection: { utils: CollectionUtils };
  edgeCollection: { utils: CollectionUtils };
  variableCollection: { utils: CollectionUtils };
  jsCollection: CollectionData;
  conditionCollection: CollectionData;
  forCollection: CollectionData;
  forEachCollection: CollectionData;
  nodeHttpCollection: CollectionData;
  httpCollection: CollectionData;
  executionCollection: CollectionData;
}

interface ToolExecutorContext {
  collections: Collections;
  flowContext: FlowContextData;
  transport: Transport;
  /** Current agent phase - needed for phase transition validation */
  currentPhase?: AgentPhase;
  /** Callback when phase transition is requested */
  onPhaseTransitionRequest?: (targetPhase: AgentPhase, reason: string) => PhaseTransitionResult;
}

/** Result of a phase transition request */
export interface PhaseTransitionResult {
  approved: boolean;
  blockedReason?: string;
  requiresUserConfirmation?: boolean;
}

const parseUlid = (id: string): Uint8Array => Ulid.fromCanonical(id).bytes;

const HANDLE_KIND_MAP: Record<string, HandleKind> = {
  then: HandleKind.THEN,
  else: HandleKind.ELSE,
  loop: HandleKind.LOOP,
};

const HTTP_METHOD_MAP: Record<string, HttpMethod> = {
  GET: HttpMethod.GET,
  POST: HttpMethod.POST,
  PUT: HttpMethod.PUT,
  PATCH: HttpMethod.PATCH,
  DELETE: HttpMethod.DELETE,
  HEAD: HttpMethod.HEAD,
  OPTIONS: HttpMethod.OPTIONS,
};

const MUTATION_TOOLS = new Set([
  'applyWorkflowPatch',
  'createJsNode',
  'createConditionNode',
  'createForNode',
  'createForEachNode',
  'createHttpNode',
  'connectSequentialNodes',
  'connectBranchingNodes',
  'disconnectNodes',
  'deleteNode',
]);

const SEQUENTIAL_NODE_KINDS = new Set(['ManualStart', 'JavaScript', 'HTTP']);
const BRANCHING_NODE_KINDS = new Set(['Condition', 'For', 'ForEach']);

type NewNodeSpec = {
  kind: 'HTTP' | 'JavaScript' | 'Condition' | 'For' | 'ForEach';
  name: string;
  clientId?: string;
  method?: string;
  url?: string;
  httpId?: string;
  code?: string;
  condition?: string;
  iterations?: number;
  errorHandling?: string;
  path?: string;
};

type PatchOp =
  | { op: 'insertBefore'; targetId: string; sourceId?: string; node: NewNodeSpec }
  | { op: 'insertAfter'; sourceId: string; targetId?: string; node: NewNodeSpec }
  | { op: 'connect'; sourceId: string; targetId: string; sourceHandle?: string }
  | { op: 'disconnect'; edgeId: string }
  | { op: 'deleteNode'; nodeId: string }
  | { op: 'updateNodeConfig'; nodeId: string; name?: string; position?: { x: number; y: number } }
  | { op: 'updateNodeCode'; nodeId: string; code: string }
  | { op: 'updateHttpMethod'; httpId: string; method: string };

type ShadowContext = {
  nodes: NodeInfo[];
  edges: EdgeInfo[];
};

const cloneShadowContext = (flowContext: FlowContextData): ShadowContext => ({
  nodes: flowContext.nodes.map((node) => ({
    ...node,
    position: { ...node.position },
  })),
  edges: flowContext.edges.map((edge) => ({ ...edge })),
});

const resolveNodeId = (id: string, idMap: Map<string, string>): string =>
  idMap.get(id) ?? id;

const getNodeById = (shadow: ShadowContext, nodeId: string): NodeInfo | undefined =>
  shadow.nodes.find((node) => node.id === nodeId);

const getEdgeById = (shadow: ShadowContext, edgeId: string): EdgeInfo | undefined =>
  shadow.edges.find((edge) => edge.id === edgeId);

const getIncomingEdges = (shadow: ShadowContext, nodeId: string): EdgeInfo[] =>
  shadow.edges.filter((edge) => edge.targetId === nodeId);

const getOutgoingEdges = (shadow: ShadowContext, nodeId: string): EdgeInfo[] =>
  shadow.edges.filter((edge) => edge.sourceId === nodeId);

const assertNodeExists = (shadow: ShadowContext, nodeId: string): NodeInfo => {
  const node = getNodeById(shadow, nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
};

const assertEdgeExists = (shadow: ShadowContext, edgeId: string): EdgeInfo => {
  const edge = getEdgeById(shadow, edgeId);
  if (!edge) throw new Error(`Edge not found: ${edgeId}`);
  return edge;
};

const getHandleKindFromEdge = (edge: EdgeInfo): HandleKind | undefined => {
  if (edge.sourceHandle == null) return undefined;
  const handleValue = Number(edge.sourceHandle);
  if (!Number.isFinite(handleValue)) {
    throw new Error(`Invalid edge handle value: ${edge.sourceHandle}`);
  }
  return handleValue as HandleKind;
};

const validateConnect = (
  shadow: ShadowContext,
  sourceNode: NodeInfo,
  sourceHandle?: string,
): HandleKind | undefined => {
  const isSequential = SEQUENTIAL_NODE_KINDS.has(sourceNode.kind);
  const isBranching = BRANCHING_NODE_KINDS.has(sourceNode.kind);

  if (isSequential) {
    // If a sourceHandle is provided for a sequential node, ignore it to be tolerant of tool misuse.
    return undefined;
  }

  if (isBranching) {
    if (!sourceHandle) {
      throw new Error(`Branching node "${sourceNode.name}" requires sourceHandle.`);
    }
    const validHandles = sourceNode.kind === 'Condition' ? ['then', 'else'] : ['then', 'loop'];
    if (!validHandles.includes(sourceHandle)) {
      throw new Error(
        `Invalid sourceHandle "${sourceHandle}" for ${sourceNode.kind}. Valid handles: ${validHandles.join(', ')}.`,
      );
    }
    const handleKind = HANDLE_KIND_MAP[sourceHandle];
    const handleValue = String(handleKind);
    const existing = shadow.edges.find(
      (edge) =>
        edge.sourceId === sourceNode.id &&
        edge.sourceHandle != null &&
        edge.sourceHandle === handleValue,
    );
    if (existing) {
      throw new Error(
        `The "${sourceHandle}" handle of "${sourceNode.name}" is already connected.`,
      );
    }
    return handleKind;
  }

  throw new Error(`Unsupported node type for connection: ${sourceNode.kind}`);
};

const insertEdge = async (
  shadow: ShadowContext,
  edgeCollection: Collections['edgeCollection'],
  flowId: Uint8Array,
  sourceId: string,
  targetId: string,
  sourceHandle?: HandleKind,
): Promise<EdgeInfo> => {
  const edgeId = Ulid.generate().bytes;
  await edgeCollection.utils.insert({
    edgeId,
    flowId,
    sourceId: parseUlid(sourceId),
    targetId: parseUlid(targetId),
    sourceHandle,
  });
  const edgeInfo: EdgeInfo = {
    id: Ulid.construct(edgeId).toCanonical(),
    sourceId,
    targetId,
    sourceHandle: sourceHandle != null ? String(sourceHandle) : undefined,
  };
  shadow.edges.push(edgeInfo);
  return edgeInfo;
};

const deleteEdge = async (
  shadow: ShadowContext,
  edgeCollection: Collections['edgeCollection'],
  edgeId: string,
): Promise<void> => {
  await edgeCollection.utils.delete({ edgeId: parseUlid(edgeId) });
  shadow.edges = shadow.edges.filter((edge) => edge.id !== edgeId);
};

const deleteNode = async (
  shadow: ShadowContext,
  collections: Collections,
  nodeId: string,
): Promise<void> => {
  const {
    nodeCollection,
    edgeCollection,
    jsCollection,
    conditionCollection,
    forCollection,
    forEachCollection,
    nodeHttpCollection,
  } = collections;
  const nodeIdBytes = parseUlid(nodeId);
  const edgesToDelete = shadow.edges.filter(
    (edge) => edge.sourceId === nodeId || edge.targetId === nodeId,
  );
  for (const edge of edgesToDelete) {
    await edgeCollection.utils.delete({ edgeId: parseUlid(edge.id) });
  }
  shadow.edges = shadow.edges.filter(
    (edge) => edge.sourceId !== nodeId && edge.targetId !== nodeId,
  );
  await Promise.all([
    jsCollection.utils.delete({ nodeId: nodeIdBytes }),
    conditionCollection.utils.delete({ nodeId: nodeIdBytes }),
    forCollection.utils.delete({ nodeId: nodeIdBytes }),
    forEachCollection.utils.delete({ nodeId: nodeIdBytes }),
    nodeHttpCollection.utils.delete({ nodeId: nodeIdBytes }),
  ]);
  await nodeCollection.utils.delete({ nodeId: nodeIdBytes });
  shadow.nodes = shadow.nodes.filter((node) => node.id !== nodeId);
};

const createNodeFromSpec = async (
  spec: NewNodeSpec,
  flowId: Uint8Array,
  collections: Collections,
): Promise<NodeInfo> => {
  const { nodeCollection, jsCollection, conditionCollection, forCollection, forEachCollection, nodeHttpCollection, httpCollection } =
    collections;
  const nodeId = Ulid.generate().bytes;
  const nodeIdStr = Ulid.construct(nodeId).toCanonical();
  const position = { x: 0, y: 0 };
  const nodeName = normalizeNodeName(spec.name);

  const baseNode: NodeInfo = {
    id: nodeIdStr,
    name: nodeName,
    kind: spec.kind,
    position,
    state: 'Idle',
  };

  switch (spec.kind) {
    case 'JavaScript': {
      if (!spec.code) throw new Error('JavaScript node requires code.');
      const code = normalizeJsCodeReferences(spec.code);
      await Promise.all([
        nodeCollection.utils.insert({
          flowId,
          kind: NodeKind.JS,
          name: nodeName,
          nodeId,
          position,
        }),
        jsCollection.utils.insert({
          nodeId,
          code: `export default function(ctx) {\n  ${code}\n}`,
        }),
      ]);
      return baseNode;
    }
    case 'Condition': {
      if (!spec.condition) throw new Error('Condition node requires condition.');
      const condition = normalizeConditionSyntax(spec.condition);
      await Promise.all([
        nodeCollection.utils.insert({
          flowId,
          kind: NodeKind.CONDITION,
          name: nodeName,
          nodeId,
          position,
        }),
        conditionCollection.utils.insert({
          nodeId,
          condition,
        }),
      ]);
      return baseNode;
    }
    case 'For': {
      if (spec.iterations == null) throw new Error('For node requires iterations.');
      if (!spec.condition) throw new Error('For node requires condition.');
      const condition = normalizeConditionSyntax(spec.condition);
      const errorHandling = spec.errorHandling ?? 'continue';
      if (!['break', 'continue'].includes(errorHandling)) {
        throw new Error('For node errorHandling must be "break" or "continue".');
      }
      await Promise.all([
        nodeCollection.utils.insert({
          flowId,
          kind: NodeKind.FOR,
          name: nodeName,
          nodeId,
          position,
        }),
        forCollection.utils.insert({
          nodeId,
          iterations: spec.iterations,
          condition,
          errorHandling: errorHandling === 'break' ? 1 : 0,
        }),
      ]);
      return baseNode;
    }
    case 'ForEach': {
      if (!spec.path) throw new Error('ForEach node requires path.');
      if (!spec.condition) throw new Error('ForEach node requires condition.');
      const path = normalizeConditionSyntax(spec.path);
      const condition = normalizeConditionSyntax(spec.condition);
      const errorHandling = spec.errorHandling ?? 'continue';
      if (!['break', 'continue'].includes(errorHandling)) {
        throw new Error('ForEach node errorHandling must be "break" or "continue".');
      }
      await Promise.all([
        nodeCollection.utils.insert({
          flowId,
          kind: NodeKind.FOR_EACH,
          name: nodeName,
          nodeId,
          position,
        }),
        forEachCollection.utils.insert({
          nodeId,
          path,
          condition,
          errorHandling: errorHandling === 'break' ? 1 : 0,
        }),
      ]);
      return baseNode;
    }
    case 'HTTP': {
      let httpId: Uint8Array;
      let httpIdStr: string;
      let httpMethod: string | undefined;
      let httpPromise: ReturnType<typeof httpCollection.utils.insert> | undefined;

      if (spec.httpId) {
        httpIdStr = spec.httpId;
        httpId = parseUlid(spec.httpId);
        if (spec.method) {
          const methodStr = spec.method.toUpperCase();
          if (!HTTP_METHOD_MAP[methodStr]) {
            throw new Error(
              `Invalid HTTP method: ${spec.method}. Valid methods are: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS`,
            );
          }
          httpMethod = methodStr;
        }
      } else {
        httpId = Ulid.generate().bytes;
        httpIdStr = Ulid.construct(httpId).toCanonical();
        const methodStr = (spec.method ?? 'GET').toUpperCase();
        const method = HTTP_METHOD_MAP[methodStr];
        if (method === undefined) {
          throw new Error(
            `Invalid HTTP method: ${spec.method}. Valid methods are: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS`,
          );
        }
        const url = spec.url ?? '';
        httpMethod = methodStr;
        httpPromise = httpCollection.utils.insert({
          httpId,
          method,
          name: nodeName,
          url,
        });
      }

      const nodePromise = nodeCollection.utils.insert({
        flowId,
        kind: NodeKind.HTTP,
        name: nodeName,
        nodeId,
        position,
      });

      const nodeHttpPromise = nodeHttpCollection.utils.insert({
        nodeId,
        httpId,
      });

      await Promise.all([httpPromise, nodePromise, nodeHttpPromise].filter(Boolean));

      return {
        ...baseNode,
        httpId: httpIdStr,
        httpMethod,
      };
    }
    default:
      throw new Error(`Unsupported node kind: ${spec.kind}`);
  }
};

export const executeToolCall = async (
  toolCall: ToolCall,
  flowId: Uint8Array,
  context: ToolExecutorContext,
): Promise<ToolResult> => {
  const { id, name, arguments: args } = toolCall;
  const isMutation = MUTATION_TOOLS.has(name);

  try {
    const result = await executeToolInternal(name, args, flowId, context);
    return { toolCallId: id, result, isMutation };
  } catch (error) {
    return {
      toolCallId: id,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      isMutation,
    };
  }
};

const executeToolInternal = async (
  name: string,
  args: Record<string, unknown>,
  flowId: Uint8Array,
  context: ToolExecutorContext,
): Promise<unknown> => {
  const { collections, flowContext, transport } = context;
  const {
    nodeCollection,
    edgeCollection,
    variableCollection,
    jsCollection,
    conditionCollection,
    forCollection,
    forEachCollection,
    nodeHttpCollection,
    httpCollection,
    executionCollection,
  } = collections;

  switch (name) {
    case 'planMutation': {
      const mutationArgs = args as unknown as PlanMutationArgs;
      const result = executePlanMutation(mutationArgs, flowContext);

      // Log the plan mutation event
      AgentTelemetry.planMutation(
        flowId,
        mutationArgs.intendedAction,
        mutationArgs.targetName,
        result.approved,
        result.error,
      );

      return result;
    }

    case 'applyWorkflowPatch': {
      if (!Array.isArray(args.ops)) {
        throw new Error('applyWorkflowPatch expects "ops" to be an array.');
      }

      const ops = args.ops as PatchOp[];
      const shadow = cloneShadowContext(flowContext);
      const idMap = new Map<string, string>();
      const appliedOps: Array<{ index: number; op: PatchOp; result?: unknown }> = [];

      for (let index = 0; index < ops.length; index += 1) {
        const op = ops[index] as PatchOp;
        try {
          switch (op.op) {
            case 'insertBefore': {
              const targetId = resolveNodeId(op.targetId, idMap);
              const targetNode = assertNodeExists(shadow, targetId);
              let sourceId = op.sourceId ? resolveNodeId(op.sourceId, idMap) : undefined;
              let edgeToReplace: EdgeInfo | undefined;

              if (sourceId) {
                edgeToReplace = shadow.edges.find(
                  (edge) => edge.sourceId === sourceId && edge.targetId === targetId,
                );
                if (!edgeToReplace) {
                  throw new Error(
                    `No edge found from source ${sourceId} to target ${targetId}.`,
                  );
                }
              } else {
                const incoming = getIncomingEdges(shadow, targetId);
                if (incoming.length !== 1) {
                  throw new Error(
                    `insertBefore requires a single incoming edge to target ${targetId}.`,
                  );
                }
                edgeToReplace = incoming[0]!;
                sourceId = edgeToReplace.sourceId;
              }

              const sourceNode = assertNodeExists(shadow, sourceId);
              const handleKind = getHandleKindFromEdge(edgeToReplace);

              if (BRANCHING_NODE_KINDS.has(sourceNode.kind) && handleKind == null) {
                throw new Error(
                  `Branching node "${sourceNode.name}" requires a source handle.`,
                );
              }
              if (SEQUENTIAL_NODE_KINDS.has(sourceNode.kind) && handleKind != null) {
                throw new Error(
                  `Sequential node "${sourceNode.name}" cannot have a source handle.`,
                );
              }

              const newNode = await createNodeFromSpec(op.node, flowId, collections);
              shadow.nodes.push(newNode);
              if (op.node.clientId) {
                idMap.set(op.node.clientId, newNode.id);
              }

              await deleteEdge(shadow, edgeCollection, edgeToReplace.id);
              await insertEdge(shadow, edgeCollection, flowId, sourceId, newNode.id, handleKind);

              const nextHandle = BRANCHING_NODE_KINDS.has(newNode.kind)
                ? HandleKind.THEN
                : undefined;
              await insertEdge(shadow, edgeCollection, flowId, newNode.id, targetId, nextHandle);

              appliedOps.push({
                index,
                op,
                result: { nodeId: newNode.id, targetId: targetNode.id },
              });
              break;
            }
            case 'insertAfter': {
              const sourceId = resolveNodeId(op.sourceId, idMap);
              const sourceNode = assertNodeExists(shadow, sourceId);
              let targetId = op.targetId ? resolveNodeId(op.targetId, idMap) : undefined;
              let edgeToReplace: EdgeInfo | undefined;

              if (targetId) {
                edgeToReplace = shadow.edges.find(
                  (edge) => edge.sourceId === sourceId && edge.targetId === targetId,
                );
                if (!edgeToReplace) {
                  throw new Error(
                    `No edge found from source ${sourceId} to target ${targetId}.`,
                  );
                }
              } else {
                const outgoing = getOutgoingEdges(shadow, sourceId);
                if (outgoing.length !== 1) {
                  throw new Error(
                    `insertAfter requires a single outgoing edge from source ${sourceId}.`,
                  );
                }
                edgeToReplace = outgoing[0]!;
                targetId = edgeToReplace.targetId;
              }

              const targetNode = assertNodeExists(shadow, targetId);
              const handleKind = getHandleKindFromEdge(edgeToReplace);

              if (BRANCHING_NODE_KINDS.has(sourceNode.kind) && handleKind == null) {
                throw new Error(
                  `Branching node "${sourceNode.name}" requires a source handle.`,
                );
              }
              if (SEQUENTIAL_NODE_KINDS.has(sourceNode.kind) && handleKind != null) {
                throw new Error(
                  `Sequential node "${sourceNode.name}" cannot have a source handle.`,
                );
              }

              const newNode = await createNodeFromSpec(op.node, flowId, collections);
              shadow.nodes.push(newNode);
              if (op.node.clientId) {
                idMap.set(op.node.clientId, newNode.id);
              }

              await deleteEdge(shadow, edgeCollection, edgeToReplace.id);
              await insertEdge(shadow, edgeCollection, flowId, sourceId, newNode.id, handleKind);

              const nextHandle = BRANCHING_NODE_KINDS.has(newNode.kind)
                ? HandleKind.THEN
                : undefined;
              await insertEdge(shadow, edgeCollection, flowId, newNode.id, targetId, nextHandle);

              appliedOps.push({
                index,
                op,
                result: { nodeId: newNode.id, sourceId: sourceNode.id, targetId: targetNode.id },
              });
              break;
            }
            case 'connect': {
              const sourceId = resolveNodeId(op.sourceId, idMap);
              const targetId = resolveNodeId(op.targetId, idMap);
              const sourceNode = assertNodeExists(shadow, sourceId);
              assertNodeExists(shadow, targetId);

              const handleKind = validateConnect(shadow, sourceNode, op.sourceHandle);
              const existing = shadow.edges.find(
                (edge) =>
                  edge.sourceId === sourceId &&
                  edge.targetId === targetId &&
                  (handleKind == null
                    ? edge.sourceHandle == null
                    : edge.sourceHandle === String(handleKind)),
              );
              if (existing) {
                throw new Error('Edge already exists between source and target.');
              }

              const edge = await insertEdge(
                shadow,
                edgeCollection,
                flowId,
                sourceId,
                targetId,
                handleKind,
              );
              appliedOps.push({ index, op, result: { edgeId: edge.id } });
              break;
            }
            case 'disconnect': {
              assertEdgeExists(shadow, op.edgeId);
              await deleteEdge(shadow, edgeCollection, op.edgeId);
              appliedOps.push({ index, op, result: { success: true } });
              break;
            }
            case 'deleteNode': {
              const nodeId = resolveNodeId(op.nodeId, idMap);
              assertNodeExists(shadow, nodeId);
              await deleteNode(shadow, collections, nodeId);
              appliedOps.push({ index, op, result: { success: true } });
              break;
            }
            case 'updateNodeConfig': {
              const nodeId = resolveNodeId(op.nodeId, idMap);
              const node = assertNodeExists(shadow, nodeId);
              const updates: Record<string, unknown> = { nodeId: parseUlid(nodeId) };
              if (op.name != null) updates.name = op.name;
              if (op.position) updates.position = op.position;
              nodeCollection.utils.update(updates);

              if (op.name != null) node.name = op.name;
              if (op.position) node.position = op.position;

              appliedOps.push({ index, op, result: { success: true } });
              break;
            }
            case 'updateNodeCode': {
              const nodeId = resolveNodeId(op.nodeId, idMap);
              assertNodeExists(shadow, nodeId);
              const code = op.code;
              jsCollection.utils.update({
                nodeId: parseUlid(nodeId),
                code: `export default function(ctx) {\n  ${code}\n}`,
              });
              appliedOps.push({ index, op, result: { success: true } });
              break;
            }
            case 'updateHttpMethod': {
              const methodStr = op.method.toUpperCase();
              const method = HTTP_METHOD_MAP[methodStr];
              if (method === undefined) {
                throw new Error(
                  `Invalid HTTP method: ${op.method}. Valid methods are: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS`,
                );
              }
              httpCollection.utils.update({
                httpId: parseUlid(op.httpId),
                method,
              });
              shadow.nodes.forEach((node) => {
                if (node.httpId === op.httpId) {
                  node.httpMethod = methodStr;
                }
              });
              appliedOps.push({ index, op, result: { success: true, method: methodStr } });
              break;
            }
            default:
              throw new Error(`Unknown patch op: ${(op as { op?: string }).op ?? 'unknown'}`);
          }
        } catch (error) {
          return {
            appliedOps,
            error: {
              index,
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }

      return { appliedOps };
    }
    // Read operations - return workflow data
    case 'getWorkflow': {
      return flowContext;
    }

    case 'getAllNodes': {
      return { nodes: flowContext.nodes };
    }

    case 'getAllEdges': {
      return { edges: flowContext.edges };
    }

    case 'getAllVariables': {
      return { variables: flowContext.variables };
    }

    case 'getNode': {
      const nodeId = args.nodeId as string;
      const node = flowContext.nodes.find((n) => n.id === nodeId);
      if (!node) throw new Error(`Node not found: ${nodeId}`);

      // Build the collection key format: {"nodeId":"<canonical-ulid>"}
      const nodeKey = JSON.stringify({ nodeId });

      // Fetch node-specific data based on node kind
      let nodeSpecificData: Record<string, unknown> | undefined;

      switch (node.kind) {
        case 'JavaScript': {
          const jsData = jsCollection.utils.state().collection.get(nodeKey);
          if (jsData) {
            nodeSpecificData = { code: (jsData as { code?: string }).code };
          }
          break;
        }
        case 'Condition': {
          const condData = conditionCollection.utils.state().collection.get(nodeKey);
          if (condData) {
            nodeSpecificData = { condition: (condData as { condition?: string }).condition };
          }
          break;
        }
        case 'For': {
          const forData = forCollection.utils.state().collection.get(nodeKey);
          if (forData) {
            const data = forData as { iterations?: number; condition?: string; errorHandling?: number };
            const ERROR_HANDLING_NAMES: Record<number, string> = {
              0: 'throw',
              1: 'ignore',
              2: 'break',
            };
            nodeSpecificData = {
              iterations: data.iterations,
              condition: data.condition,
              errorHandling: ERROR_HANDLING_NAMES[data.errorHandling ?? 0] ?? 'throw',
            };
          }
          break;
        }
        case 'ForEach': {
          const forEachData = forEachCollection.utils.state().collection.get(nodeKey);
          if (forEachData) {
            const data = forEachData as { path?: string; condition?: string; errorHandling?: number };
            const ERROR_HANDLING_NAMES: Record<number, string> = {
              0: 'throw',
              1: 'ignore',
              2: 'break',
            };
            nodeSpecificData = {
              path: data.path,
              breakIf: data.condition,
              errorHandling: ERROR_HANDLING_NAMES[data.errorHandling ?? 0] ?? 'throw',
            };
          }
          break;
        }
        case 'HTTP': {
          const nodeHttpData = nodeHttpCollection.utils.state().collection.get(nodeKey);
          if (nodeHttpData) {
            const httpIdBytes = (nodeHttpData as { httpId?: Uint8Array }).httpId;
            if (httpIdBytes) {
              const httpIdStr = Ulid.construct(httpIdBytes).toCanonical();
              const httpKey = JSON.stringify({ httpId: httpIdStr });
              const httpData = httpCollection.utils.state().collection.get(httpKey);
              if (httpData) {
                const data = httpData as { url?: string; method?: number; name?: string };
                const HTTP_METHOD_NAMES: Record<number, string> = {
                  0: 'UNSPECIFIED',
                  1: 'GET',
                  2: 'POST',
                  3: 'PUT',
                  4: 'PATCH',
                  5: 'DELETE',
                  6: 'HEAD',
                  7: 'OPTIONS',
                };
                nodeSpecificData = {
                  httpId: httpIdStr,
                  url: data.url,
                  method: HTTP_METHOD_NAMES[data.method ?? 0] ?? 'UNSPECIFIED',
                  requestName: data.name,
                };
              }
            }
          }
          break;
        }
      }

      return nodeSpecificData ? { ...node, ...nodeSpecificData } : node;
    }

    case 'getEdge': {
      const edgeId = args.edgeId as string;
      const edge = flowContext.edges.find((e) => e.id === edgeId);
      if (!edge) throw new Error(`Edge not found: ${edgeId}`);
      return edge;
    }

    case 'getFlowVariable': {
      const flowVariableId = args.flowVariableId as string;
      const variable = flowContext.variables.find((v) => v.id === flowVariableId);
      if (!variable) throw new Error(`Variable not found: ${flowVariableId}`);
      return variable;
    }

    case 'getNodeExecutions': {
      // Handle both nodeId (preferred) and nodeExecutionId (from generated schema)
      let nodeId = args.nodeId as string | undefined;

      // If nodeExecutionId is provided instead, find the node it belongs to
      if (!nodeId && args.nodeExecutionId) {
        const executionId = args.nodeExecutionId as string;
        const execution = flowContext.executions.find((e) => e.id === executionId);
        if (execution) {
          nodeId = execution.nodeId;
        } else {
          return { executions: [], message: `Execution not found: ${executionId}` };
        }
      }

      if (!nodeId) {
        return { executions: [], message: 'No nodeId or nodeExecutionId provided' };
      }

      // Get executions for this node from the context
      const executions = flowContext.executions
        .filter((e) => e.nodeId === nodeId)
        .sort((a, b) => {
          // Sort by completion time descending (most recent first)
          if (!a.completedAt && !b.completedAt) return 0;
          if (!a.completedAt) return 1;
          if (!b.completedAt) return -1;
          return new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime();
        });

      if (executions.length === 0) {
        return { executions: [], message: 'No execution history found for this node' };
      }

      return {
        executions: executions.map((e) => ({
          id: e.id,
          name: e.name,
          state: e.state,
          error: e.error,
          completedAt: e.completedAt,
        })),
      };
    }

    case 'getNodeOutput': {
      const nodeId = args.nodeId as string;
      const executions = flowContext.executions
        .filter((e) => e.nodeId === nodeId && e.state !== 'Running')
        .sort((a, b) => {
          if (!a.completedAt && !b.completedAt) return 0;
          if (!a.completedAt) return 1;
          if (!b.completedAt) return -1;
          return new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime();
        });

      if (executions.length === 0) {
        const node = flowContext.nodes.find((n) => n.id === nodeId);
        return { nodeId, nodeName: node?.name, message: 'No completed executions found for this node' };
      }

      const latest = executions[0]!;
      const node = flowContext.nodes.find((n) => n.id === nodeId);

      // Truncate large input/output to prevent massive responses
      const MAX_OUTPUT_LENGTH = 10000;
      const truncateData = (data: unknown): unknown => {
        if (data == null) return data;
        const str = typeof data === 'string' ? data : JSON.stringify(data);
        if (str.length <= MAX_OUTPUT_LENGTH) {
          return data;
        }
        return {
          _truncated: true,
          _originalLength: str.length,
          preview: str.slice(0, MAX_OUTPUT_LENGTH) + '...',
        };
      };

      return {
        nodeId,
        nodeName: node?.name,
        executionId: latest.id,
        state: latest.state,
        input: truncateData(latest.input),
        output: truncateData(latest.output),
      };
    }

    case 'getSelectedNodes': {
      const selectedIds = flowContext.selectedNodeIds ?? [];
      if (selectedIds.length === 0) {
        return { selectedNodes: [], message: 'No nodes are currently selected.' };
      }
      const selectedNodes = selectedIds
        .map((id) => flowContext.nodes.find((n) => n.id === id))
        .filter((n): n is NonNullable<typeof n> => n != null)
        .map((n) => ({ id: n.id, name: n.name, kind: n.kind, state: n.state }));
      return { selectedNodes };
    }

    case 'getFailedNodes': {
      const failedNodes = flowContext.nodes.filter((n) => n.state === 'Failure');
      const failedExecutions = flowContext.executions.filter((e) => e.state === 'Failure');

      return {
        failedNodes: failedNodes.map((n) => ({
          id: n.id,
          name: n.name,
          kind: n.kind,
          state: n.state,
          info: n.info,
        })),
        failedExecutions: failedExecutions.map((e) => {
          const node = flowContext.nodes.find((n) => n.id === e.nodeId);
          return {
            nodeId: e.nodeId,
            nodeName: node?.name,
            executionId: e.id,
            error: e.error,
            completedAt: e.completedAt,
          };
        }),
      };
    }

    case 'createJsNode': {
      const nodeId = Ulid.generate().bytes;
      const position = (args.position as { x: number; y: number }) ?? { x: 0, y: 0 };
      const code = normalizeJsCodeReferences(args.code as string);
      const nodeName = normalizeNodeName(args.name as string);

      // Call both inserts before awaiting to ensure optimistic updates happen
      // synchronously before any sync responses can arrive from the server
      const nodePromise = nodeCollection.utils.insert({
        flowId,
        kind: NodeKind.JS,
        name: nodeName,
        nodeId,
        position,
      });

      const jsPromise = jsCollection.utils.insert({
        nodeId,
        code: `export default function(ctx) {\n  ${code}\n}`,
      });

      await Promise.all([nodePromise, jsPromise]);

      return { nodeId: Ulid.construct(nodeId).toCanonical(), name: nodeName };
    }

    case 'createConditionNode': {
      const nodeId = Ulid.generate().bytes;
      const position = (args.position as { x: number; y: number }) ?? { x: 0, y: 0 };
      const condition = normalizeConditionSyntax(args.condition as string);
      const nodeName = normalizeNodeName(args.name as string);

      // Call both inserts before awaiting to ensure optimistic updates happen
      // synchronously before any sync responses can arrive from the server
      const nodePromise = nodeCollection.utils.insert({
        flowId,
        kind: NodeKind.CONDITION,
        name: nodeName,
        nodeId,
        position,
      });

      const conditionPromise = conditionCollection.utils.insert({
        nodeId,
        condition,
      });

      await Promise.all([nodePromise, conditionPromise]);

      return { nodeId: Ulid.construct(nodeId).toCanonical(), name: nodeName };
    }

    case 'createForNode': {
      const nodeId = Ulid.generate().bytes;
      const position = (args.position as { x: number; y: number }) ?? { x: 0, y: 0 };
      const iterations = args.iterations as number;
      const condition = normalizeConditionSyntax(args.condition as string);
      const errorHandling = args.errorHandling as string;
      const nodeName = normalizeNodeName(args.name as string);

      // Call both inserts before awaiting to ensure optimistic updates happen
      // synchronously before any sync responses can arrive from the server
      const nodePromise = nodeCollection.utils.insert({
        flowId,
        kind: NodeKind.FOR,
        name: nodeName,
        nodeId,
        position,
      });

      const forPromise = forCollection.utils.insert({
        nodeId,
        iterations,
        condition,
        errorHandling: errorHandling === 'break' ? 1 : 0,
      });

      await Promise.all([nodePromise, forPromise]);

      return { nodeId: Ulid.construct(nodeId).toCanonical(), name: nodeName };
    }

    case 'createForEachNode': {
      const nodeId = Ulid.generate().bytes;
      const position = (args.position as { x: number; y: number }) ?? { x: 0, y: 0 };
      const path = normalizeConditionSyntax(args.path as string);
      const condition = normalizeConditionSyntax(args.condition as string);
      const errorHandling = args.errorHandling as string;
      const nodeName = normalizeNodeName(args.name as string);

      // Call both inserts before awaiting to ensure optimistic updates happen
      // synchronously before any sync responses can arrive from the server
      const nodePromise = nodeCollection.utils.insert({
        flowId,
        kind: NodeKind.FOR_EACH,
        name: nodeName,
        nodeId,
        position,
      });

      const forEachPromise = forEachCollection.utils.insert({
        nodeId,
        path,
        condition,
        errorHandling: errorHandling === 'break' ? 1 : 0,
      });

      await Promise.all([nodePromise, forEachPromise]);

      return { nodeId: Ulid.construct(nodeId).toCanonical(), name: nodeName };
    }

    case 'createHttpNode': {
      const nodeId = Ulid.generate().bytes;
      const position = (args.position as { x: number; y: number }) ?? { x: 0, y: 0 };
      const nodeName = normalizeNodeName(args.name as string);

      let httpId: Uint8Array;
      let httpIdStr: string;
      let httpPromise: ReturnType<typeof httpCollection.utils.insert> | undefined;

      if (args.httpId) {
        // Use existing HTTP request
        httpId = parseUlid(args.httpId as string);
        httpIdStr = args.httpId as string;
      } else {
        // Create new HTTP request
        httpId = Ulid.generate().bytes;
        httpIdStr = Ulid.construct(httpId).toCanonical();
        const methodStr = ((args.method as string) ?? 'GET').toUpperCase();
        const method = HTTP_METHOD_MAP[methodStr] ?? HttpMethod.GET;
        const url = (args.url as string) ?? '';

        httpPromise = httpCollection.utils.insert({
          httpId,
          method,
          name: nodeName,
          url,
        });
      }

      // Call all inserts before awaiting to ensure optimistic updates happen
      // synchronously before any sync responses can arrive from the server
      const nodePromise = nodeCollection.utils.insert({
        flowId,
        kind: NodeKind.HTTP,
        name: nodeName,
        nodeId,
        position,
      });

      const nodeHttpPromise = nodeHttpCollection.utils.insert({
        nodeId,
        httpId,
      });

      await Promise.all([httpPromise, nodePromise, nodeHttpPromise].filter(Boolean));

      return { nodeId: Ulid.construct(nodeId).toCanonical(), httpId: httpIdStr, name: nodeName };
    }

    case 'connectSequentialNodes': {
      const sourceIdStr = args.sourceId as string;
      const targetIdStr = args.targetId as string;

      // Validation: Only validate if we can find the node (it may have just been created)
      const sourceNode = flowContext.nodes.find((n) => n.id === sourceIdStr);
      if (sourceNode) {
        // Validation: Check source is a sequential node
        const isSequentialNode = ['ManualStart', 'JavaScript', 'HTTP'].includes(sourceNode.kind);
        if (!isSequentialNode) {
          throw new Error(
            `Node "${sourceNode.name}" is a ${sourceNode.kind} node. ` +
              `Use connectBranchingNodes instead (with sourceHandle: 'then', 'else', or 'loop').`,
          );
        }
      }

      const edgeId = Ulid.generate().bytes;
      const sourceId = parseUlid(sourceIdStr);
      const targetId = parseUlid(targetIdStr);

      // Await to ensure server persistence before returning
      await edgeCollection.utils.insert({
        edgeId,
        flowId,
        sourceId,
        targetId,
      });

      return { edgeId: Ulid.construct(edgeId).toCanonical() };
    }

    case 'connectBranchingNodes': {
      const sourceIdStr = args.sourceId as string;
      const targetIdStr = args.targetId as string;
      const handleStr = args.sourceHandle as string;

      // Validation: Only validate if we can find the node (it may have just been created)
      const sourceNode = flowContext.nodes.find((n) => n.id === sourceIdStr);
      if (sourceNode) {
        // Validation: Check source is a branching node
        const isBranchingNode = ['Condition', 'For', 'ForEach'].includes(sourceNode.kind);
        if (!isBranchingNode) {
          throw new Error(
            `Node "${sourceNode.name}" is a ${sourceNode.kind} node. ` +
              `Use connectSequentialNodes instead.`,
          );
        }

        // Validation: Check handle is valid for node type
        const validHandles = sourceNode.kind === 'Condition' ? ['then', 'else'] : ['then', 'loop'];
        if (!validHandles.includes(handleStr)) {
          throw new Error(
            `Invalid sourceHandle "${handleStr}" for ${sourceNode.kind} node. ` +
              `Valid handles: ${validHandles.join(', ')}.`,
          );
        }

        // Validation: Check handle isn't already connected
        // Note: sourceHandle in flowContext is stored as the numeric enum value (as string)
        const handleKindValue = String(HANDLE_KIND_MAP[handleStr]);
        const existingEdge = flowContext.edges.find(
          (e) => e.sourceId === sourceIdStr && e.sourceHandle === handleKindValue,
        );
        if (existingEdge) {
          const existingTarget = flowContext.nodes.find((n) => n.id === existingEdge.targetId);
          throw new Error(
            `The "${handleStr}" handle of "${sourceNode.name}" is already connected to "${existingTarget?.name}". ` +
              `Use disconnectNodes first to reconnect.`,
          );
        }
      }

      const edgeId = Ulid.generate().bytes;
      const sourceId = parseUlid(sourceIdStr);
      const targetId = parseUlid(targetIdStr);
      const sourceHandle = HANDLE_KIND_MAP[handleStr] ?? HandleKind.THEN;

      // Await to ensure server persistence before returning
      await edgeCollection.utils.insert({
        edgeId,
        flowId,
        sourceId,
        targetId,
        sourceHandle,
      });

      return { edgeId: Ulid.construct(edgeId).toCanonical() };
    }

    case 'disconnectNodes': {
      const edgeId = parseUlid(args.edgeId as string);
      edgeCollection.utils.delete({ edgeId });
      return { success: true };
    }

    case 'deleteNode': {
      const nodeIdStr = args.nodeId as string;
      const shadow = cloneShadowContext(flowContext);
      await deleteNode(shadow, collections, nodeIdStr);
      return { success: true };
    }

    case 'updateNodeConfig': {
      const nodeId = parseUlid(args.nodeId as string);
      const updates: Record<string, unknown> = { nodeId };

      if (args.name) updates.name = args.name;
      if (args.position) updates.position = args.position;

      nodeCollection.utils.update(updates);
      return { success: true };
    }

    case 'updateNodeCode': {
      const nodeId = parseUlid(args.nodeId as string);
      const code = args.code as string;

      jsCollection.utils.update({
        nodeId,
        code: `export default function(ctx) {\n  ${code}\n}`,
      });

      return { success: true };
    }

    case 'createVariable': {
      const flowVariableId = Ulid.generate().bytes;
      const key = args.key as string;
      const value = args.value as string;
      const enabled = args.enabled as boolean;
      const description = args.description as string;
      const order = args.order as number;

      // Await to ensure server persistence before returning
      await variableCollection.utils.insert({
        flowVariableId,
        flowId,
        key,
        value,
        enabled,
        description,
        order,
      });

      return { flowVariableId: Ulid.construct(flowVariableId).toCanonical() };
    }

    case 'updateVariable': {
      const flowVariableId = parseUlid(args.flowVariableId as string);
      const updates: Record<string, unknown> = { flowVariableId };

      if (args.key !== undefined) updates.key = args.key;
      if (args.value !== undefined) updates.value = args.value;
      if (args.enabled !== undefined) updates.enabled = args.enabled;
      if (args.description !== undefined) updates.description = args.description;
      if (args.order !== undefined) updates.order = args.order;

      variableCollection.utils.update(updates);
      return { success: true };
    }

    case 'updateHttpMethod': {
      const httpId = parseUlid(args.httpId as string);
      const methodStr = (args.method as string).toUpperCase();
      const method = HTTP_METHOD_MAP[methodStr];

      if (method === undefined) {
        throw new Error(`Invalid HTTP method: ${args.method}. Valid methods are: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS`);
      }

      httpCollection.utils.update({
        httpId,
        method,
      });

      return { success: true, method: methodStr };
    }

    case 'flowRunRequest': {
      await request({
        input: { flowId },
        method: FlowService.method.flowRun,
        transport,
      });
      return { success: true, message: 'Flow execution started' };
    }

    case 'flowStopRequest': {
      await request({
        input: { flowId },
        method: FlowService.method.flowStop,
        transport,
      });
      return { success: true, message: 'Flow execution stopped' };
    }

    case PHASE_TRANSITION_TOOL_NAME: {
      const targetPhase = args.targetPhase as AgentPhase;
      const reason = args.reason as string;
      const currentPhase = context.currentPhase;

      if (!currentPhase) {
        return {
          approved: false,
          blockedReason: 'Phase tracking not available',
        };
      }

      // Compute orphan count for validation
      const computeOrphanCount = (): number => {
        const startNode = flowContext.nodes.find((n) => n.kind === 'ManualStart');
        if (!startNode) return 0;

        const outgoing = new Map<string, string[]>();
        for (const e of flowContext.edges) {
          const list = outgoing.get(e.sourceId) ?? [];
          list.push(e.targetId);
          outgoing.set(e.sourceId, list);
        }

        const reachable = new Set<string>();
        const queue = [startNode.id];
        while (queue.length > 0) {
          const nodeId = queue.shift()!;
          if (reachable.has(nodeId)) continue;
          reachable.add(nodeId);
          queue.push(...(outgoing.get(nodeId) ?? []));
        }

        return flowContext.nodes.filter(
          (n) => n.kind !== 'ManualStart' && !reachable.has(n.id),
        ).length;
      };

      const orphanCount = computeOrphanCount();
      const validationResult = validatePhaseTransition(currentPhase, targetPhase, {
        lastMessage: '',
        hasToolCalls: false,
        orphanCount,
      });

      if (!validationResult.valid) {
        return {
          approved: false,
          blockedReason: validationResult.reason,
          targetPhase,
          reason,
        };
      }

      // Check if user confirmation is required
      const needsConfirmation = requiresUserConfirmation(currentPhase, targetPhase);

      // Notify the context about the transition request
      if (context.onPhaseTransitionRequest) {
        return context.onPhaseTransitionRequest(targetPhase, reason);
      }

      return {
        approved: !needsConfirmation,
        requiresUserConfirmation: needsConfirmation,
        targetPhase,
        reason,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

export type { Collections, ToolExecutorContext };
