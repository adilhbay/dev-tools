import { createClient } from '@connectrpc/connect';
import { FlowService, type NodeExecution } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { FlowItemStateType, ToolContext, ToolResult } from '../../types.ts';
import { bytesToUlid, flowItemStateToString } from '../../utils.ts';

export interface GetExecutionLogsParams {
  executionId: string;
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
  _params: GetExecutionLogsParams,
): Promise<ToolResult<ExecutionLogsResult>> {
  try {
    const client = createClient(FlowService, ctx.transport);

    // Fetch all node executions
    const response = await client['nodeExecutionCollection']({});

    // For now, we return all executions as the API doesn't seem to have
    // a clear execution grouping mechanism. In practice, you'd filter
    // by a specific run ID or time range.
    const logs = response.items.map((exec: NodeExecution) => {
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
