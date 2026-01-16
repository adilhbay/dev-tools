import { createClient } from '@connectrpc/connect';
import { FlowService, type NodeExecution } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { FlowItemStateType, ToolContext, ToolResult } from '../../types.ts';
import { bytesToUlid, flowItemStateToString } from '../../utils.ts';

export interface GetExecutionLogsParams {
  executionId?: string;
  flowId?: string;
  limit?: number;
}

export interface ExecutionLogEntry {
  nodeExecutionId: string;
  nodeId: string;
  name: string;
  state: FlowItemStateType | 'unspecified';
  error?: string;
  input?: unknown;
  output?: unknown;
  httpResponseId?: string;
  completedAt?: string;
}

export interface ExecutionLogsResult {
  logs: ExecutionLogEntry[];
}

/**
 * Get detailed logs from a specific workflow execution.
 * The executionId can be a flowVersionId or nodeExecutionId prefix.
 */
export async function getExecutionLogs(
  ctx: ToolContext,
  params: GetExecutionLogsParams,
): Promise<ToolResult<ExecutionLogsResult>> {
  try {
    const client = createClient(FlowService, ctx.transport);

    // Fetch node executions and nodes to filter by flow
    const [execResponse, nodeResponse] = await Promise.all([
      client['nodeExecutionCollection']({}),
      params.flowId ? client['nodeCollection']({}) : Promise.resolve({ items: [] }),
    ]);

    // Build a set of node IDs that belong to this flow (if flowId provided)
    const flowNodeIds = params.flowId
      ? new Set(
          nodeResponse.items
            .filter((n: { flowId: Uint8Array }) => bytesToUlid(n.flowId) === params.flowId)
            .map((n: { nodeId: Uint8Array }) => bytesToUlid(n.nodeId)),
        )
      : null;

    // Filter executions by flow and get only the latest per node
    const latestByNode = new Map<string, NodeExecution>();
    for (const exec of execResponse.items) {
      const nodeId = bytesToUlid(exec.nodeId);

      // Skip if filtering by flow and node doesn't belong to this flow
      if (flowNodeIds && !flowNodeIds.has(nodeId)) continue;

      // Keep only the latest execution per node (sorted by completedAt)
      const existing = latestByNode.get(nodeId);
      if (!existing || (exec.completedAt && existing.completedAt && exec.completedAt.seconds > existing.completedAt.seconds)) {
        latestByNode.set(nodeId, exec);
      }
    }

    // Apply limit (default: 10)
    const limit = params.limit ?? 10;
    const limitedExecutions = Array.from(latestByNode.values()).slice(0, limit);

    const logs = limitedExecutions.map((exec: NodeExecution) => {
      const entry: ExecutionLogEntry = {
        nodeExecutionId: bytesToUlid(exec.nodeExecutionId),
        nodeId: bytesToUlid(exec.nodeId),
        name: exec.name,
        state: flowItemStateToString(exec.state),
      };

      if (exec.error) {
        entry.error = exec.error;
      }

      if (exec.input) {
        // Convert protobuf Value to JSON-friendly format
        entry.input = valueToJson(exec.input);
      }

      if (exec.output) {
        entry.output = valueToJson(exec.output);
      }

      if (exec.httpResponseId && exec.httpResponseId.length > 0) {
        entry.httpResponseId = bytesToUlid(exec.httpResponseId);
      }

      if (exec.completedAt) {
        entry.completedAt = new Date(Number(exec.completedAt.seconds) * 1000).toISOString();
      }

      return entry;
    });

    return {
      success: true,
      data: { logs },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Convert protobuf Value to JSON-friendly format
 */
function valueToJson(value: { kind: { case: string | undefined; value?: unknown } }): unknown {
  switch (value.kind.case) {
    case 'nullValue':
      return null;
    case 'numberValue':
      return value.kind.value;
    case 'stringValue':
      return value.kind.value;
    case 'boolValue':
      return value.kind.value;
    case 'structValue': {
      const struct = value.kind.value as { fields: Record<string, unknown> };
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(struct.fields ?? {})) {
        result[key] = valueToJson(val as { kind: { case: string | undefined; value?: unknown } });
      }
      return result;
    }
    case 'listValue': {
      const list = value.kind.value as { values: unknown[] };
      return (list.values ?? []).map((v) => valueToJson(v as { kind: { case: string | undefined; value?: unknown } }));
    }
    default:
      return undefined;
  }
}
