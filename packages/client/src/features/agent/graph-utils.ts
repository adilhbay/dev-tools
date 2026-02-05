/**
 * Graph Utilities - Shared graph traversal and analysis functions.
 *
 * Consolidates orphan detection logic previously duplicated across:
 * - use-agent-chat.ts
 * - tool-executor.ts
 * - agent-phases.ts
 */

import type { FlowContextData, NodeInfo, EdgeInfo } from './types';

export interface OrphanAnalysis {
  orphanNodes: NodeInfo[];
  orphanCount: number;
  reachableNodes: Set<string>;
}

/**
 * Compute reachable nodes from the ManualStart node using BFS.
 */
export function getReachableNodes(context: FlowContextData): Set<string> {
  const startNode = context.nodes.find((n) => n.kind === 'ManualStart');
  if (!startNode) return new Set();

  // Build adjacency list for outgoing edges
  const outgoing = new Map<string, string[]>();
  for (const edge of context.edges) {
    const list = outgoing.get(edge.sourceId) ?? [];
    list.push(edge.targetId);
    outgoing.set(edge.sourceId, list);
  }

  // BFS from start node
  const reachable = new Set<string>();
  const queue = [startNode.id];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    queue.push(...(outgoing.get(nodeId) ?? []));
  }

  return reachable;
}

/**
 * Get all orphan nodes (nodes not reachable from ManualStart).
 */
export function getOrphanNodes(context: FlowContextData): NodeInfo[] {
  const reachable = getReachableNodes(context);

  return context.nodes.filter(
    (node) => node.kind !== 'ManualStart' && !reachable.has(node.id),
  );
}

/**
 * Count orphan nodes (nodes not reachable from ManualStart).
 */
export function countOrphans(context: FlowContextData): number {
  return getOrphanNodes(context).length;
}

/**
 * Get full orphan analysis including reachable set.
 */
export function analyzeOrphans(context: FlowContextData): OrphanAnalysis {
  const reachableNodes = getReachableNodes(context);
  const orphanNodes = context.nodes.filter(
    (node) => node.kind !== 'ManualStart' && !reachableNodes.has(node.id),
  );

  return {
    orphanNodes,
    orphanCount: orphanNodes.length,
    reachableNodes,
  };
}

/**
 * Check if a specific node is an orphan.
 */
export function isOrphanNode(nodeId: string, context: FlowContextData): boolean {
  const node = context.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind === 'ManualStart') return false;

  const reachable = getReachableNodes(context);
  return !reachable.has(nodeId);
}

/**
 * Find nodes by name (case-insensitive partial match).
 */
export function findNodesByName(name: string, context: FlowContextData): NodeInfo[] {
  const normalizedName = name.toLowerCase().replace(/\s+/g, '_');
  return context.nodes.filter((node) =>
    node.name.toLowerCase().replace(/\s+/g, '_').includes(normalizedName),
  );
}

/**
 * Check if a node with the given name already exists.
 */
export function nodeNameExists(name: string, context: FlowContextData): boolean {
  const normalizedName = name.toLowerCase().replace(/\s+/g, '_');
  return context.nodes.some(
    (node) => node.name.toLowerCase().replace(/\s+/g, '_') === normalizedName,
  );
}
