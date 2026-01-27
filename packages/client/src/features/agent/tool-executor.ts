import type { Transport } from '@connectrpc/connect';
import { Ulid } from 'id128';
import { FlowService, HandleKind, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import { request } from '~/shared/api';
import type { FlowContextData, ToolCall, ToolResult } from './types';

type CollectionUtils = ReturnType<typeof import('~/shared/api').useApiCollection>['utils'];
type CollectionData = ReturnType<typeof import('~/shared/api').useApiCollection>;

interface Collections {
  nodeCollection: { utils: CollectionUtils };
  edgeCollection: { utils: CollectionUtils };
  variableCollection: { utils: CollectionUtils };
  jsCollection: { utils: CollectionUtils };
  conditionCollection: { utils: CollectionUtils };
  forCollection: { utils: CollectionUtils };
  forEachCollection: { utils: CollectionUtils };
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

export const executeToolCall = async (
  toolCall: ToolCall,
  flowId: Uint8Array,
  context: ToolExecutorContext,
): Promise<ToolResult> => {
  const { id, name, arguments: args } = toolCall;

  try {
    const result = await executeToolInternal(name, args, flowId, context);
    return { toolCallId: id, result };
  } catch (error) {
    return {
      toolCallId: id,
      result: null,
      error: error instanceof Error ? error.message : String(error),
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
      return {
        nodeId,
        nodeName: node?.name,
        executionId: latest.id,
        state: latest.state,
        input: latest.input,
        output: latest.output,
      };
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
      const position = args.position as { x: number; y: number };
      const code = args.code as string;
      const nodeName = args.name as string;

      jsCollection.utils.insert({
        nodeId,
        code: `export default function(ctx) {\n  ${code}\n}`,
      });

      nodeCollection.utils.insert({
        flowId,
        kind: NodeKind.JS,
        name: nodeName,
        nodeId,
        position,
      });

      return { nodeId: Ulid.construct(nodeId).toCanonical(), name: nodeName };
    }

    case 'createConditionNode': {
      const nodeId = Ulid.generate().bytes;
      const position = args.position as { x: number; y: number };
      const condition = args.condition as string;
      const nodeName = args.name as string;

      conditionCollection.utils.insert({
        nodeId,
        condition,
      });

      nodeCollection.utils.insert({
        flowId,
        kind: NodeKind.CONDITION,
        name: nodeName,
        nodeId,
        position,
      });

      return { nodeId: Ulid.construct(nodeId).toCanonical(), name: nodeName };
    }

    case 'createForNode': {
      const nodeId = Ulid.generate().bytes;
      const position = args.position as { x: number; y: number };
      const iterations = args.iterations as number;
      const condition = args.condition as string;
      const errorHandling = args.errorHandling as string;
      const nodeName = args.name as string;

      forCollection.utils.insert({
        nodeId,
        iterations,
        condition,
        errorHandling: errorHandling === 'break' ? 1 : 0,
      });

      nodeCollection.utils.insert({
        flowId,
        kind: NodeKind.FOR,
        name: nodeName,
        nodeId,
        position,
      });

      return { nodeId: Ulid.construct(nodeId).toCanonical(), name: nodeName };
    }

    case 'createForEachNode': {
      const nodeId = Ulid.generate().bytes;
      const position = args.position as { x: number; y: number };
      const path = args.path as string;
      const condition = args.condition as string;
      const errorHandling = args.errorHandling as string;
      const nodeName = args.name as string;

      forEachCollection.utils.insert({
        nodeId,
        path,
        condition,
        errorHandling: errorHandling === 'break' ? 1 : 0,
      });

      nodeCollection.utils.insert({
        flowId,
        kind: NodeKind.FOR_EACH,
        name: nodeName,
        nodeId,
        position,
      });

      return { nodeId: Ulid.construct(nodeId).toCanonical(), name: nodeName };
    }

    case 'connectSequentialNodes': {
      const edgeId = Ulid.generate().bytes;
      const sourceId = parseUlid(args.sourceId as string);
      const targetId = parseUlid(args.targetId as string);

      edgeCollection.utils.insert({
        edgeId,
        flowId,
        sourceId,
        targetId,
      });

      return { edgeId: Ulid.construct(edgeId).toCanonical() };
    }

    case 'connectBranchingNodes': {
      const edgeId = Ulid.generate().bytes;
      const sourceId = parseUlid(args.sourceId as string);
      const targetId = parseUlid(args.targetId as string);
      const sourceHandle = HANDLE_KIND_MAP[args.sourceHandle as string] ?? HandleKind.THEN;

      edgeCollection.utils.insert({
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
      const nodeId = parseUlid(args.nodeId as string);
      nodeCollection.utils.delete({ nodeId });
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

      variableCollection.utils.insert({
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
