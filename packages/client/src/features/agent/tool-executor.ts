import type { Transport } from '@connectrpc/connect';
import { eq } from '@tanstack/react-db';
import { Ulid } from 'id128';
import { FlowItemState, FlowService, HandleKind, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import { HttpBodyKind, HttpMethod } from '@the-dev-tools/spec/buf/api/http/v1/http_pb';
import { request } from '~/shared/api';
import { queryCollection } from '~/shared/lib';
import type { FlowContextData, ToolCall, ToolResult } from './types';

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
  jsCollection: { utils: CollectionUtils };
  conditionCollection: { utils: CollectionUtils };
  forCollection: { utils: CollectionUtils };
  forEachCollection: { utils: CollectionUtils };
  nodeHttpCollection: { utils: CollectionUtils };
  httpCollection: { utils: CollectionUtils };
  httpSearchParamCollection: { utils: CollectionUtils };
  httpHeaderCollection: { utils: CollectionUtils };
  httpBodyRawCollection: { utils: CollectionUtils };
  httpAssertCollection: { utils: CollectionUtils };
  executionCollection: CollectionData;
}

interface ToolExecutorContext {
  collections: Collections;
  flowContext: FlowContextData;
  transport: Transport;
  waitForFlowCompletion: () => Promise<void>;
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

const MUTATION_TOOLS = new Set([
  'createJsNode',
  'createConditionNode',
  'createForNode',
  'createForEachNode',
  'createHttpNode',
  'connectSequentialNodes',
  'connectBranchingNodes',
  'disconnectNodes',
  'deleteNode',
  'addHttpSearchParam',
  'updateHttpSearchParam',
  'deleteHttpSearchParam',
  'addHttpHeader',
  'updateHttpHeader',
  'deleteHttpHeader',
  'setHttpBody',
  'addHttpAssert',
  'updateHttpAssert',
  'deleteHttpAssert',
]);

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
    httpSearchParamCollection,
    httpHeaderCollection,
    httpBodyRawCollection,
    httpAssertCollection,
    executionCollection,
  } = collections;

  switch (name) {
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
      return node;
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
      // Validate iterations is a positive integer
      const iterations = args.iterations as number | undefined;
      if (iterations === undefined || iterations === null) {
        throw new Error('iterations is required for For nodes. Specify the number of times to iterate.');
      }
      if (!Number.isInteger(iterations) || iterations <= 0) {
        throw new Error(`iterations must be a positive integer, got: ${iterations}`);
      }

      // Validate break condition is provided
      const rawCondition = args.condition as string | undefined;
      if (!rawCondition || rawCondition.trim() === '') {
        throw new Error(
          'condition (break condition) is required for For nodes. ' +
            'Provide an expression that evaluates to true to exit the loop early. ' +
            'Example: Counter.count >= 10',
        );
      }

      const nodeId = Ulid.generate().bytes;
      const position = (args.position as { x: number; y: number }) ?? { x: 0, y: 0 };
      const condition = normalizeConditionSyntax(rawCondition);
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
      // Validate path is provided
      const rawPath = args.path as string | undefined;
      if (!rawPath || rawPath.trim() === '') {
        throw new Error(
          'path is required for ForEach nodes. ' +
            'Provide an expression for the array/object to iterate. ' +
            'Example: HTTP_Request.response.body.items',
        );
      }

      // Validate break condition is provided
      const rawCondition = args.condition as string | undefined;
      if (!rawCondition || rawCondition.trim() === '') {
        throw new Error(
          'condition (break condition) is required for ForEach nodes. ' +
            'Provide an expression that evaluates to true to exit the loop early. ' +
            'Example: ForEach_Loop.key >= 5',
        );
      }

      const nodeId = Ulid.generate().bytes;
      const position = (args.position as { x: number; y: number }) ?? { x: 0, y: 0 };
      const path = normalizeConditionSyntax(rawPath);
      const condition = normalizeConditionSyntax(rawCondition);
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
      const insertPromises: Promise<unknown>[] = [];

      if (args.httpId) {
        // Use existing HTTP request
        httpId = parseUlid(args.httpId as string);
        httpIdStr = args.httpId as string;
      } else {
        // Validate HTTP method
        const methodStr = ((args.method as string) ?? '').toUpperCase();
        if (!methodStr) {
          throw new Error(
            'method is required when creating a new HTTP node. ' +
              'Valid methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
          );
        }
        const method = HTTP_METHOD_MAP[methodStr];
        if (method === undefined) {
          throw new Error(
            `Invalid HTTP method: "${args.method}". ` +
              'Valid methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
          );
        }

        const url = (args.url as string) ?? '';
        const methodsWithBody = new Set(['POST', 'PUT', 'PATCH']);
        const needsBody = methodsWithBody.has(methodStr);

        // Create new HTTP request with appropriate bodyKind
        httpId = Ulid.generate().bytes;
        httpIdStr = Ulid.construct(httpId).toCanonical();

        insertPromises.push(
          httpCollection.utils.insert({
            httpId,
            method,
            name: nodeName,
            url,
            bodyKind: needsBody ? HttpBodyKind.RAW : HttpBodyKind.UNSPECIFIED,
          }),
        );

        // If a body is provided and the method supports it, insert the raw body
        const body = args.body as string | undefined;
        if (body && needsBody) {
          insertPromises.push(
            collections.httpBodyRawCollection.utils.insert({
              httpId,
              data: body,
            }),
          );
        } else if (body && !needsBody) {
          throw new Error(
            `Cannot set body for ${methodStr} requests. ` +
              'Only POST, PUT, and PATCH methods support a request body.',
          );
        }
      }

      // Call all inserts before awaiting to ensure optimistic updates happen
      // synchronously before any sync responses can arrive from the server
      insertPromises.push(
        nodeCollection.utils.insert({
          flowId,
          kind: NodeKind.HTTP,
          name: nodeName,
          nodeId,
          position,
        }),
        nodeHttpCollection.utils.insert({
          nodeId,
          httpId,
        }),
      );

      await Promise.all(insertPromises);

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

        // Validation: Check source doesn't already have outgoing edge
        const existingEdges = flowContext.edges.filter((e) => e.sourceId === sourceIdStr);
        if (existingEdges.length > 0) {
          const existingTarget = flowContext.nodes.find((n) => n.id === existingEdges[0]!.targetId);
          throw new Error(
            `Node "${sourceNode.name}" already connects to "${existingTarget?.name ?? existingEdges[0]!.targetId}". ` +
              `Sequential nodes can only have one output. Use disconnectNodes first to reconnect.`,
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
      const nodeId = parseUlid(nodeIdStr);

      // Delete all edges connected to this node (both incoming and outgoing)
      const connectedEdges = flowContext.edges.filter(
        (e) => e.sourceId === nodeIdStr || e.targetId === nodeIdStr,
      );
      for (const edge of connectedEdges) {
        edgeCollection.utils.delete({ edgeId: parseUlid(edge.id) });
      }

      nodeCollection.utils.delete({ nodeId });
      return { success: true, deletedEdges: connectedEdges.length };
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

    case 'getNodeHttp': {
      const nodeIdStr = args.nodeId as string;
      const node = flowContext.nodes.find((n) => n.id === nodeIdStr);
      if (!node) throw new Error(`Node not found: ${nodeIdStr}`);
      if (node.kind !== 'HTTP') throw new Error(`Node "${node.name}" is not an HTTP node (it's ${node.kind})`);
      if (!node.httpId) throw new Error(`HTTP node "${node.name}" has no associated HTTP request`);

      const httpIdBytes = parseUlid(node.httpId);

      // Query HTTP details from collections
      const [httpData] = await queryCollection((_) =>
        _.from({ http: httpCollection }).where((_) => eq(_.http.httpId, httpIdBytes)).findOne(),
      );

      const searchParams = await queryCollection((_) =>
        _.from({ sp: httpSearchParamCollection }).where((_) => eq(_.sp.httpId, httpIdBytes)),
      );

      const headers = await queryCollection((_) =>
        _.from({ h: httpHeaderCollection }).where((_) => eq(_.h.httpId, httpIdBytes)),
      );

      const bodyRaw = await queryCollection((_) =>
        _.from({ br: httpBodyRawCollection }).where((_) => eq(_.br.httpId, httpIdBytes)),
      );

      const asserts = await queryCollection((_) =>
        _.from({ a: httpAssertCollection }).where((_) => eq(_.a.httpId, httpIdBytes)),
      );

      const HTTP_METHOD_NAMES: Record<number, string> = {
        0: 'UNSPECIFIED', 1: 'GET', 2: 'POST', 3: 'PUT', 4: 'PATCH',
        5: 'DELETE', 6: 'HEAD', 7: 'OPTIONS', 8: 'CONNECT',
      };
      const HTTP_BODY_KIND_NAMES: Record<number, string> = {
        0: 'none', 1: 'form_data', 2: 'url_encoded', 3: 'raw',
      };

      return {
        httpId: node.httpId,
        name: httpData?.name ?? node.name,
        url: httpData?.url ?? '',
        method: HTTP_METHOD_NAMES[httpData?.method ?? 0] ?? 'UNSPECIFIED',
        bodyKind: HTTP_BODY_KIND_NAMES[httpData?.bodyKind ?? 0] ?? 'none',
        searchParams: searchParams.map((sp) => ({
          id: sp.httpSearchParamId ? Ulid.construct(sp.httpSearchParamId).toCanonical() : undefined,
          key: sp.key,
          value: sp.value,
          enabled: sp.enabled,
          description: sp.description,
        })),
        headers: headers.map((h) => ({
          id: h.httpHeaderId ? Ulid.construct(h.httpHeaderId).toCanonical() : undefined,
          key: h.key,
          value: h.value,
          enabled: h.enabled,
          description: h.description,
        })),
        body: bodyRaw.length > 0 ? bodyRaw[0]?.data : undefined,
        assertions: asserts.map((a) => ({
          id: a.httpAssertId ? Ulid.construct(a.httpAssertId).toCanonical() : undefined,
          value: a.value,
          enabled: a.enabled,
        })),
      };
    }

    case 'addHttpSearchParam': {
      const httpId = parseUlid(args.httpId as string);
      const httpSearchParamId = Ulid.generate().bytes;

      await httpSearchParamCollection.utils.insert({
        httpSearchParamId,
        httpId,
        key: args.key as string,
        value: (args.value as string) ?? '',
        enabled: (args.enabled as boolean) ?? true,
        description: (args.description as string) ?? '',
        order: (args.order as number) ?? 0,
      });

      return { httpSearchParamId: Ulid.construct(httpSearchParamId).toCanonical() };
    }

    case 'updateHttpSearchParam': {
      const httpSearchParamId = parseUlid(args.httpSearchParamId as string);
      const updates: Record<string, unknown> = { httpSearchParamId };

      if (args.key !== undefined) updates.key = args.key;
      if (args.value !== undefined) updates.value = args.value;
      if (args.enabled !== undefined) updates.enabled = args.enabled;
      if (args.description !== undefined) updates.description = args.description;

      httpSearchParamCollection.utils.update(updates);
      return { success: true };
    }

    case 'deleteHttpSearchParam': {
      const httpSearchParamId = parseUlid(args.httpSearchParamId as string);
      httpSearchParamCollection.utils.delete({ httpSearchParamId });
      return { success: true };
    }

    case 'addHttpHeader': {
      const httpId = parseUlid(args.httpId as string);
      const httpHeaderId = Ulid.generate().bytes;

      await httpHeaderCollection.utils.insert({
        httpHeaderId,
        httpId,
        key: args.key as string,
        value: (args.value as string) ?? '',
        enabled: (args.enabled as boolean) ?? true,
        description: (args.description as string) ?? '',
        order: (args.order as number) ?? 0,
      });

      return { httpHeaderId: Ulid.construct(httpHeaderId).toCanonical() };
    }

    case 'updateHttpHeader': {
      const httpHeaderId = parseUlid(args.httpHeaderId as string);
      const updates: Record<string, unknown> = { httpHeaderId };

      if (args.key !== undefined) updates.key = args.key;
      if (args.value !== undefined) updates.value = args.value;
      if (args.enabled !== undefined) updates.enabled = args.enabled;
      if (args.description !== undefined) updates.description = args.description;

      httpHeaderCollection.utils.update(updates);
      return { success: true };
    }

    case 'deleteHttpHeader': {
      const httpHeaderId = parseUlid(args.httpHeaderId as string);
      httpHeaderCollection.utils.delete({ httpHeaderId });
      return { success: true };
    }

    case 'setHttpBody': {
      const httpId = parseUlid(args.httpId as string);
      const data = (args.data as string) ?? '';

      // Update the HTTP request's bodyKind to Raw
      httpCollection.utils.update({
        httpId,
        bodyKind: HttpBodyKind.RAW,
      });

      // Upsert the raw body (keyed by httpId)
      httpBodyRawCollection.utils.update({
        httpId,
        data,
      });

      return { success: true };
    }

    case 'addHttpAssert': {
      const httpId = parseUlid(args.httpId as string);
      const httpAssertId = Ulid.generate().bytes;

      await httpAssertCollection.utils.insert({
        httpAssertId,
        httpId,
        value: args.value as string,
        enabled: (args.enabled as boolean) ?? true,
        order: (args.order as number) ?? 0,
      });

      return { httpAssertId: Ulid.construct(httpAssertId).toCanonical() };
    }

    case 'updateHttpAssert': {
      const httpAssertId = parseUlid(args.httpAssertId as string);
      const updates: Record<string, unknown> = { httpAssertId };

      if (args.value !== undefined) updates.value = args.value;
      if (args.enabled !== undefined) updates.enabled = args.enabled;

      httpAssertCollection.utils.update(updates);
      return { success: true };
    }

    case 'deleteHttpAssert': {
      const httpAssertId = parseUlid(args.httpAssertId as string);
      httpAssertCollection.utils.delete({ httpAssertId });
      return { success: true };
    }

    case 'flowRunRequest': {
      await request({
        input: { flowId },
        method: FlowService.method.flowRun,
        transport,
      });

      await context.waitForFlowCompletion();

      return {
        success: true,
        message: 'Flow execution completed. Use getFlowExecutionSummary to inspect results.',
      };
    }

    case 'flowStopRequest': {
      await request({
        input: { flowId },
        method: FlowService.method.flowStop,
        transport,
      });
      return { success: true, message: 'Flow execution stopped' };
    }

    case 'getFlowExecutionSummary': {
      // Query fresh nodes from the collection
      const freshNodes = await queryCollection((_) =>
        _.from({ node: collections.nodeCollection }).where((_) => eq(_.node.flowId, flowId)),
      );

      // Build a set of node IDs belonging to this flow
      const nodeIdSet = new Set(
        freshNodes.filter((n) => n.nodeId != null).map((n) => Ulid.construct(n.nodeId).toCanonical()),
      );

      // Query all executions and filter to this flow's nodes
      const allExecs = await queryCollection((_) =>
        _.from({ exec: collections.executionCollection }),
      );
      const flowExecs = allExecs.filter(
        (e) => e.nodeId != null && nodeIdSet.has(Ulid.construct(e.nodeId).toCanonical()),
      );
      const executedNodeIds = new Set(flowExecs.map((e) => Ulid.construct(e.nodeId).toCanonical()));

      // Build executed nodes list with state from execution records
      const executedNodes = freshNodes
        .filter((n) => n.nodeId != null && executedNodeIds.has(Ulid.construct(n.nodeId).toCanonical()))
        .map((n) => {
          const nodeExecs = flowExecs
            .filter((e) => Ulid.construct(e.nodeId).toCanonical() === Ulid.construct(n.nodeId).toCanonical())
            .sort((a, b) => {
              if (!a.completedAt && !b.completedAt) return 0;
              if (!a.completedAt) return 1;
              if (!b.completedAt) return -1;
              return Number(b.completedAt - a.completedAt);
            });
          const latestExec = nodeExecs[0];
          return {
            id: Ulid.construct(n.nodeId).toCanonical(),
            name: n.name,
            state: latestExec ? (FLOW_ITEM_STATE_NAMES[latestExec.state] ?? 'Unknown') : 'Unknown',
          };
        });

      // Never-reached: non-ManualStart nodes without any executions
      const neverReachedNodes = freshNodes
        .filter(
          (n) =>
            n.nodeId != null &&
            n.kind !== NodeKind.MANUAL_START &&
            !executedNodeIds.has(Ulid.construct(n.nodeId).toCanonical()),
        )
        .map((n) => ({
          id: Ulid.construct(n.nodeId).toCanonical(),
          name: n.name,
          kind: NODE_KIND_NAMES[n.kind] ?? 'Unknown',
        }));

      return {
        executedNodes,
        neverReachedNodes,
        warning: neverReachedNodes.length > 0
          ? `${neverReachedNodes.length} node(s) were never reached during execution. This may indicate an untaken branch or a wiring problem.`
          : undefined,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

export type { Collections, ToolExecutorContext };
