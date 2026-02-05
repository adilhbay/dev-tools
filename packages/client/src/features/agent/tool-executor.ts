import type { Transport } from '@connectrpc/connect';
import { Ulid } from 'id128';
import { FlowService, HandleKind, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import { HttpMethod } from '@the-dev-tools/spec/buf/api/http/v1/http_pb';
import { request } from '~/shared/api';
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
  executionCollection: CollectionData;
}

interface ToolExecutorContext {
  collections: Collections;
  flowContext: FlowContextData;
  transport: Transport;
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

export type { Collections, ToolExecutorContext };
