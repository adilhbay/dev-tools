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
  'connectChain',
  'disconnectNodes',
  'deleteNode',
  'configureHttp',
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
    case 'inspectNode': {
      const nodeIdStr = args.nodeId as string;
      const includeOutput = (args.includeOutput as boolean) ?? false;
      const node = flowContext.nodes.find((n) => n.id === nodeIdStr);
      if (!node) throw new Error(`Node not found: ${nodeIdStr}`);

      const nodeIdBytes = parseUlid(nodeIdStr);

      // Base info (always returned)
      const result: Record<string, unknown> = {
        id: node.id,
        name: node.name,
        kind: node.kind,
        state: node.state,
        error: node.info ?? undefined,
      };

      // Type-specific config
      switch (node.kind) {
        case 'HTTP': {
          if (!node.httpId) break;
          const httpIdBytes = parseUlid(node.httpId);

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

          result.httpId = node.httpId;
          result.url = httpData?.url ?? '';
          result.method = HTTP_METHOD_NAMES[httpData?.method ?? 0] ?? 'UNSPECIFIED';
          result.headers = headers.map((h) => ({
            id: h.httpHeaderId ? Ulid.construct(h.httpHeaderId).toCanonical() : undefined,
            key: h.key,
            value: h.value,
            enabled: h.enabled,
          }));
          result.searchParams = searchParams.map((sp) => ({
            id: sp.httpSearchParamId ? Ulid.construct(sp.httpSearchParamId).toCanonical() : undefined,
            key: sp.key,
            value: sp.value,
            enabled: sp.enabled,
          }));
          result.body = bodyRaw.length > 0 ? bodyRaw[0]?.data : undefined;
          result.assertions = asserts.map((a) => ({
            id: a.httpAssertId ? Ulid.construct(a.httpAssertId).toCanonical() : undefined,
            value: a.value,
            enabled: a.enabled,
          }));
          break;
        }
        case 'JavaScript': {
          const [jsData] = await queryCollection((_) =>
            _.from({ js: jsCollection }).where((_) => eq(_.js.nodeId, nodeIdBytes)).findOne(),
          );
          result.code = jsData?.code ?? '';
          break;
        }
        case 'Condition': {
          const [condData] = await queryCollection((_) =>
            _.from({ cond: conditionCollection }).where((_) => eq(_.cond.nodeId, nodeIdBytes)).findOne(),
          );
          result.condition = condData?.condition ?? '';
          break;
        }
        case 'For': {
          const [forData] = await queryCollection((_) =>
            _.from({ f: forCollection }).where((_) => eq(_.f.nodeId, nodeIdBytes)).findOne(),
          );
          result.iterations = forData?.iterations;
          result.condition = forData?.condition ?? '';
          result.errorHandling = forData?.errorHandling === 1 ? 'break' : 'continue';
          break;
        }
        case 'ForEach': {
          const [feData] = await queryCollection((_) =>
            _.from({ fe: forEachCollection }).where((_) => eq(_.fe.nodeId, nodeIdBytes)).findOne(),
          );
          result.path = feData?.path ?? '';
          result.condition = feData?.condition ?? '';
          result.errorHandling = feData?.errorHandling === 1 ? 'break' : 'continue';
          break;
        }
      }

      // Query execution data fresh from collection (not cached flowContext)
      const allExecs = await queryCollection((_) =>
        _.from({ exec: executionCollection }),
      );
      const nodeExecs = allExecs
        .filter((e) => e.nodeId != null && Ulid.construct(e.nodeId).toCanonical() === nodeIdStr)
        .sort((a, b) => {
          if (!a.completedAt && !b.completedAt) return 0;
          if (!a.completedAt) return 1;
          if (!b.completedAt) return -1;
          return Number(b.completedAt - a.completedAt);
        });

      if (nodeExecs.length > 0) {
        const latest = nodeExecs[0]!;
        result.execution = {
          state: FLOW_ITEM_STATE_NAMES[latest.state] ?? 'Unknown',
          error: latest.error ?? undefined,
          completedAt: latest.completedAt instanceof Date
            ? latest.completedAt.toISOString()
            : latest.completedAt ? String(latest.completedAt) : undefined,
        };

        if (includeOutput) {
          const MAX_OUTPUT_LENGTH = 10000;
          const truncateData = (data: unknown): unknown => {
            if (data == null) return data;
            const str = typeof data === 'string' ? data : JSON.stringify(data);
            if (str.length <= MAX_OUTPUT_LENGTH) return data;
            return {
              _truncated: true,
              _originalLength: str.length,
              preview: str.slice(0, MAX_OUTPUT_LENGTH) + '...',
            };
          };
          (result.execution as Record<string, unknown>).input = truncateData(latest.input);
          (result.execution as Record<string, unknown>).output = truncateData(latest.output);
        }
      }

      return result;
    }

    case 'configureHttp': {
      const nodeIdStr = args.nodeId as string;
      const node = flowContext.nodes.find((n) => n.id === nodeIdStr);
      if (!node) throw new Error(`Node not found: ${nodeIdStr}`);
      if (node.kind !== 'HTTP') throw new Error(`Node "${node.name}" is not an HTTP node (it's ${node.kind})`);
      if (!node.httpId) throw new Error(`HTTP node "${node.name}" has no associated HTTP request`);

      const httpIdBytes = parseUlid(node.httpId);

      // Update method/url if provided
      const httpUpdates: Record<string, unknown> = { httpId: httpIdBytes };
      let hasHttpUpdates = false;

      if (args.method !== undefined) {
        const methodStr = (args.method as string).toUpperCase();
        const method = HTTP_METHOD_MAP[methodStr];
        if (method === undefined) {
          throw new Error(`Invalid HTTP method: "${args.method}". Valid: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS`);
        }
        httpUpdates.method = method;
        hasHttpUpdates = true;
      }

      if (args.url !== undefined) {
        httpUpdates.url = args.url;
        hasHttpUpdates = true;
      }

      if (hasHttpUpdates) {
        httpCollection.utils.update(httpUpdates);
      }

      // Replace headers if provided (delete all, then insert)
      if (args.headers !== undefined) {
        const existingHeaders = await queryCollection((_) =>
          _.from({ h: httpHeaderCollection }).where((_) => eq(_.h.httpId, httpIdBytes)),
        );
        for (const h of existingHeaders) {
          if (h.httpHeaderId) httpHeaderCollection.utils.delete({ httpHeaderId: h.httpHeaderId });
        }
        const newHeaders = args.headers as { key: string; value?: string; enabled?: boolean; description?: string }[];
        for (let i = 0; i < newHeaders.length; i++) {
          const h = newHeaders[i]!;
          await httpHeaderCollection.utils.insert({
            httpHeaderId: Ulid.generate().bytes,
            httpId: httpIdBytes,
            key: h.key,
            value: h.value ?? '',
            enabled: h.enabled ?? true,
            description: h.description ?? '',
            order: i,
          });
        }
      }

      // Replace search params if provided
      if (args.searchParams !== undefined) {
        const existingParams = await queryCollection((_) =>
          _.from({ sp: httpSearchParamCollection }).where((_) => eq(_.sp.httpId, httpIdBytes)),
        );
        for (const sp of existingParams) {
          if (sp.httpSearchParamId) httpSearchParamCollection.utils.delete({ httpSearchParamId: sp.httpSearchParamId });
        }
        const newParams = args.searchParams as { key: string; value?: string; enabled?: boolean; description?: string }[];
        for (let i = 0; i < newParams.length; i++) {
          const sp = newParams[i]!;
          await httpSearchParamCollection.utils.insert({
            httpSearchParamId: Ulid.generate().bytes,
            httpId: httpIdBytes,
            key: sp.key,
            value: sp.value ?? '',
            enabled: sp.enabled ?? true,
            description: sp.description ?? '',
            order: i,
          });
        }
      }

      // Set or clear body
      if (args.body !== undefined) {
        const body = args.body as string | null;
        if (body === null) {
          // Clear body
          httpCollection.utils.update({ httpId: httpIdBytes, bodyKind: HttpBodyKind.UNSPECIFIED });
          const existingBody = await queryCollection((_) =>
            _.from({ br: httpBodyRawCollection }).where((_) => eq(_.br.httpId, httpIdBytes)),
          );
          if (existingBody.length > 0) {
            httpBodyRawCollection.utils.update({ httpId: httpIdBytes, data: '' });
          }
        } else {
          // Set body
          httpCollection.utils.update({ httpId: httpIdBytes, bodyKind: HttpBodyKind.RAW });
          const existingBody = await queryCollection((_) =>
            _.from({ br: httpBodyRawCollection }).where((_) => eq(_.br.httpId, httpIdBytes)),
          );
          if (existingBody.length > 0) {
            httpBodyRawCollection.utils.update({ httpId: httpIdBytes, data: body });
          } else {
            await httpBodyRawCollection.utils.insert({ httpId: httpIdBytes, data: body });
          }
        }
      }

      // Replace assertions if provided
      if (args.assertions !== undefined) {
        const existingAsserts = await queryCollection((_) =>
          _.from({ a: httpAssertCollection }).where((_) => eq(_.a.httpId, httpIdBytes)),
        );
        for (const a of existingAsserts) {
          if (a.httpAssertId) httpAssertCollection.utils.delete({ httpAssertId: a.httpAssertId });
        }
        const newAsserts = args.assertions as { value: string; enabled?: boolean }[];
        for (let i = 0; i < newAsserts.length; i++) {
          const a = newAsserts[i]!;
          await httpAssertCollection.utils.insert({
            httpAssertId: Ulid.generate().bytes,
            httpId: httpIdBytes,
            value: a.value,
            enabled: a.enabled ?? true,
            order: i,
          });
        }
      }

      return { success: true };
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

    case 'connectChain': {
      const nodeIds = args.nodeIds as (string | string[])[];
      const handleOverride = args.sourceHandle as string | undefined;
      if (handleOverride && !['then', 'else', 'loop'].includes(handleOverride)) {
        throw new Error(
          `Invalid sourceHandle "${handleOverride}". Valid values: "then", "else", "loop".`,
        );
      }
      if (!nodeIds || nodeIds.length < 2) {
        throw new Error('connectChain requires at least 2 elements.');
      }

      // Validate: no consecutive nested arrays
      for (let i = 0; i < nodeIds.length - 1; i++) {
        if (Array.isArray(nodeIds[i]) && Array.isArray(nodeIds[i + 1])) {
          throw new Error(
            `connectChain: consecutive nested arrays at positions ${i} and ${i + 1} are not allowed. ` +
            `Insert a shared fan-in node between the groups, or split into separate connectChain calls. ` +
            `Example: instead of ["A",["B","C"],["D","E"],"F"], use ["A",["B","C"],"Mid"] then ["Mid",["D","E"],"F"].`,
          );
        }
      }

      // Validate: parallel groups have ≥2 unique IDs
      for (let i = 0; i < nodeIds.length; i++) {
        const el = nodeIds[i]!;
        if (Array.isArray(el)) {
          const unique = new Set(el);
          if (unique.size < 2) {
            throw new Error(
              `connectChain: parallel group at position ${i} must have at least 2 unique node IDs.`,
            );
          }
          if (unique.size !== el.length) {
            throw new Error(
              `connectChain: parallel group at position ${i} contains duplicate node IDs.`,
            );
          }
        }
      }

      // Expand consecutive element pairs into edge pairs
      const edgePairs: [string, string][] = [];
      for (let i = 0; i < nodeIds.length - 1; i++) {
        const current = nodeIds[i]!;
        const next = nodeIds[i + 1]!;
        const sources = Array.isArray(current) ? current : [current];
        const targets = Array.isArray(next) ? next : [next];
        for (const s of sources)
          for (const t of targets) edgePairs.push([s, t]);
      }

      const edgeIds: string[] = [];
      const errors: string[] = [];

      // Process SEQUENTIALLY to avoid parallel race conditions
      for (let idx = 0; idx < edgePairs.length; idx++) {
        const [sourceIdStr, targetIdStr] = edgePairs[idx]!;

        try {
          const sourceId = parseUlid(sourceIdStr);
          const targetId = parseUlid(targetIdStr);
          const edgeId = Ulid.generate().bytes;

          // Query live edges to check for existing outgoing connections
          const existingEdges = await queryCollection((_) =>
            _.from({ e: edgeCollection }).where((_) => eq(_.e.sourceId, sourceId)),
          );

          const duplicateEdge = existingEdges.find(
            (e) => Ulid.construct(e.targetId).toCanonical() === targetIdStr,
          );
          if (duplicateEdge) {
            errors.push(
              `Edge ${idx}: Edge from ${sourceIdStr} to ${targetIdStr} already exists. Skipped.`,
            );
            continue;
          }

          // Determine handle kind for branching nodes
          const sourceNode = flowContext.nodes.find((n) => n.id === sourceIdStr);
          const isBranching =
            sourceNode && ['Condition', 'For', 'ForEach'].includes(sourceNode.kind);

          // Validate handle is valid for the specific branching node type
          if (isBranching && handleOverride) {
            const validHandles =
              sourceNode!.kind === 'Condition' ? ['then', 'else'] : ['then', 'loop'];
            if (!validHandles.includes(handleOverride)) {
              errors.push(
                `Edge ${idx}: Invalid sourceHandle "${handleOverride}" for ${sourceNode!.kind} node "${sourceNode!.name}". ` +
                  `Valid handles: ${validHandles.join(', ')}. Skipped.`,
              );
              continue;
            }
          }

          const edgeHandle = isBranching
            ? (HANDLE_KIND_MAP[handleOverride ?? 'then'] ?? HandleKind.THEN)
            : undefined;

          await edgeCollection.utils.insert({
            edgeId,
            flowId,
            sourceId,
            targetId,
            ...(edgeHandle !== undefined ? { sourceHandle: edgeHandle } : {}),
          });

          edgeIds.push(Ulid.construct(edgeId).toCanonical());
        } catch (error) {
          errors.push(
            `Edge ${idx}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return {
        edgesCreated: edgeIds.length,
        edgeIds,
        ...(errors.length > 0 ? { errors } : {}),
      };
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
