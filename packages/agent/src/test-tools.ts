/**
 * Test script for workflow agent tools
 *
 * Usage:
 *   npx tsx packages/agent/src/test-tools.ts [flowId]
 *
 * Examples:
 *   npx tsx packages/agent/src/test-tools.ts
 *   npx tsx packages/agent/src/test-tools.ts 01HXYZ...
 */

import { createConnectTransport } from '@connectrpc/connect-web';
import type { ToolContext } from './types.ts';
import { allToolSchemas } from './tools/schemas/index.ts';
import { getWorkflowGraph } from './tools/exploration/get-workflow-graph.ts';
import { getNodeDetails } from './tools/exploration/get-node-details.ts';
import { searchTemplates } from './tools/exploration/search-templates.ts';
import { validateWorkflow } from './tools/execution/validate-workflow.ts';
import { createJsNode } from './tools/mutation/create-js-node.ts';
import { connectNodes } from './tools/mutation/connect-nodes.ts';
import { deleteNode } from './tools/mutation/delete-node.ts';

// Configuration
const SERVER_URL = process.env['SERVER_URL'] ?? 'http://localhost:8080';

// Create transport and context
const transport = createConnectTransport({
  baseUrl: SERVER_URL,
});

const ctx: ToolContext = { transport };

// Helper to print results
function printResult(name: string, result: { success: boolean; data?: unknown; error?: string }) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Tool: ${name}`);
  console.log('='.repeat(60));

  if (result.success) {
    console.log('Status: SUCCESS');
    console.log('Data:', JSON.stringify(result.data, null, 2));
  } else {
    console.log('Status: FAILED');
    console.log('Error:', result.error);
  }
}

async function listTools() {
  console.log('\n📋 Available Tools:\n');
  console.log('Exploration (read-only):');
  for (const schema of allToolSchemas.filter((s) => ['getWorkflowGraph', 'getNodeDetails', 'getNodeTemplate', 'searchTemplates', 'getExecutionHistory', 'getExecutionLogs'].includes(s.name))) {
    console.log(`  • ${schema.name}: ${schema.description}`);
  }

  console.log('\nMutation (write):');
  for (const schema of allToolSchemas.filter((s) => s.name.startsWith('create') || s.name.startsWith('update') || s.name.startsWith('delete') || s.name.startsWith('connect') || s.name.startsWith('disconnect'))) {
    console.log(`  • ${schema.name}: ${schema.description}`);
  }

  console.log('\nExecution (run/test):');
  for (const schema of allToolSchemas.filter((s) => ['runWorkflow', 'stopWorkflow', 'validateWorkflow'].includes(s.name))) {
    console.log(`  • ${schema.name}: ${schema.description}`);
  }
}

async function testExplorationTools(flowId: string) {
  console.log('\n🔍 Testing Exploration Tools...\n');

  // Test getWorkflowGraph
  const graphResult = await getWorkflowGraph(ctx, { flowId });
  printResult('getWorkflowGraph', graphResult);

  // If we got nodes, test getNodeDetails on the first one
  if (graphResult.success && graphResult.data && graphResult.data.nodes.length > 0) {
    const firstNodeId = graphResult.data.nodes[0].nodeId;
    const detailsResult = await getNodeDetails(ctx, { nodeId: firstNodeId });
    printResult('getNodeDetails', detailsResult);
  }

  // Test searchTemplates
  const templatesResult = await searchTemplates({ query: 'http' });
  printResult('searchTemplates', templatesResult);
}

async function testValidation(flowId: string) {
  console.log('\n✅ Testing Validation...\n');

  const validationResult = await validateWorkflow(ctx, { flowId });
  printResult('validateWorkflow', validationResult);
}

async function testMutationTools(flowId: string) {
  console.log('\n🔧 Testing Mutation Tools (creates a test node, then deletes it)...\n');

  // Create a test JS node
  const createResult = await createJsNode(ctx, {
    flowId,
    name: 'Test Node (will be deleted)',
    code: 'return { test: true };',
    position: { x: 500, y: 500 },
  });
  printResult('createJsNode', createResult);

  if (createResult.success && createResult.data) {
    const nodeId = createResult.data.nodeId;
    console.log(`\nCreated node: ${nodeId}`);

    // Delete the test node
    const deleteResult = await deleteNode(ctx, { nodeId });
    printResult('deleteNode', deleteResult);
  }
}

async function interactiveMode() {
  console.log('\n🎮 Interactive Mode\n');
  console.log('This script can be extended with readline for interactive testing.');
  console.log('For now, use the functions directly in your code or REPL.\n');

  console.log('Example usage in Node REPL:');
  console.log('  const { getWorkflowGraph } = await import("./packages/agent/src/index.ts");');
  console.log('  const { createConnectTransport } = await import("@connectrpc/connect-web");');
  console.log('  const transport = createConnectTransport({ baseUrl: "http://localhost:8080" });');
  console.log('  await getWorkflowGraph({ transport }, { flowId: "YOUR_ID" });');
}

async function main() {
  const args = process.argv.slice(2);
  const flowId = args[0];

  console.log('🚀 Workflow Agent Tools Test Script');
  console.log(`Server: ${SERVER_URL}`);

  // Always list available tools
  await listTools();

  if (!flowId) {
    console.log('\n⚠️  No flowId provided. Run with a flow ID to test tools:');
    console.log('   npx tsx packages/agent/src/test-tools.ts <flowId>\n');
    await interactiveMode();
    return;
  }

  console.log(`\nTesting with flowId: ${flowId}`);

  try {
    // Test exploration tools
    await testExplorationTools(flowId);

    // Test validation
    await testValidation(flowId);

    // Uncomment to test mutation (creates/deletes a node):
    // await testMutationTools(flowId);

    console.log('\n✨ Tests completed!\n');
  } catch (error) {
    console.error('\n❌ Error during testing:', error);
    process.exit(1);
  }
}

main();
