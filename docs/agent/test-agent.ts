import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, tool, jsonSchema, CoreMessage, stepCountIs } from "ai";
import * as fs from "fs";
import * as readline from "readline";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  // Transport
  createConnectTransport,
  type ToolContext,
  // Schemas
  allToolSchemas,
  // Exploration tools
  getWorkflowGraph,
  getNodeDetails,
  getNodeTemplate,
  searchTemplates,
  getExecutionHistory,
  getExecutionLogs,
  // Mutation tools
  createJsNode,
  createHttpNode,
  createConditionNode,
  createForNode,
  createForEachNode,
  updateNodeCode,
  updateNodeConfig,
  connectNodes,
  disconnectNodes,
  deleteNode,
  createVariable,
  updateVariable,
  // Execution tools
  runWorkflow,
  stopWorkflow,
  validateWorkflow,
} from "../../packages/agent/src/index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load system prompt
const systemPrompt = fs.readFileSync(
  path.join(__dirname, "system-prompt.md"),
  "utf-8"
);

// Create OpenRouter provider
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Create gRPC transport for tool execution
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8080";
const transport = createConnectTransport({
  baseUrl: SERVER_URL,
});
const ctx: ToolContext = { transport };

// Tool executors that need ToolContext
const contextTools: Record<
  string,
  (ctx: ToolContext, params: any) => Promise<any>
> = {
  getWorkflowGraph,
  getNodeDetails,
  getExecutionHistory,
  getExecutionLogs,
  createJsNode,
  createHttpNode,
  createConditionNode,
  createForNode,
  createForEachNode,
  updateNodeCode,
  updateNodeConfig,
  connectNodes,
  disconnectNodes,
  deleteNode,
  createVariable,
  updateVariable,
  runWorkflow,
  stopWorkflow,
  validateWorkflow,
};

// Tool executors that don't need ToolContext
const standaloneTools: Record<string, (params: any) => Promise<any>> = {
  searchTemplates,
  getNodeTemplate,
};

// Build AI SDK tools from schemas
const aiTools = Object.fromEntries(
  allToolSchemas.map((schema) => [
    schema.name,
    tool({
      description: schema.description,
      inputSchema: jsonSchema(schema.parameters),
      execute: async (params) => {
        const name = schema.name;
        try {
          if (name in contextTools) {
            return await contextTools[name](ctx, params);
          } else if (name in standaloneTools) {
            return await standaloneTools[name](params);
          }
          return { success: false, error: `Unknown tool: ${name}` };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),
  ])
);

// Readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

// Conversation state
const messages: CoreMessage[] = [];

async function chat(userMessage: string): Promise<void> {
  messages.push({ role: "user", content: userMessage });

  const result = await generateText({
    model: openrouter("minimax/minimax-m2.1"),
    system: systemPrompt,
    messages,
    tools: aiTools,
    stopWhen: stepCountIs(20), // Max 20 tool call iterations
    onStepFinish: ({ toolCalls, toolResults, text }) => {
      // Log tool calls for visibility
      if (toolCalls && toolCalls.length > 0) {
        for (const call of toolCalls) {
          console.log(`\n\x1b[33m--- Tool Call: ${call.toolName} ---\x1b[0m`);
          console.log(
            `\x1b[90mInput: ${JSON.stringify(call.input, null, 2)}\x1b[0m\n`
          );
        }
      }
      // Log tool results
      if (toolResults && toolResults.length > 0) {
        for (const res of toolResults) {
          console.log(
            `\x1b[90mOutput: ${JSON.stringify(res.output, null, 2)}\x1b[0m\n`
          );
        }
      }
      // Log intermediate text
      if (text) {
        console.log(`\x1b[90m[Intermediate]: ${text}\x1b[0m`);
      }
    },
  });

  // Add assistant response to history
  messages.push(...result.response.messages);

  // Print final text
  if (result.text) {
    console.log(`\n\x1b[36mAgent:\x1b[0m ${result.text}\n`);
  }
}

async function main() {
  console.log("\x1b[35m=== Workflow Agent Test Console ===\x1b[0m");
  console.log("Model: minimax/minimax-m2.1 via OpenRouter (Vercel AI SDK)");
  console.log('Type your message, "quit" to exit\n');

  // Optional: inject initial context
  console.log("\x1b[90mTip: Start by providing workflow context, e.g.:\x1b[0m");
  console.log(
    '\x1b[90m"Current workflow: Test Flow, Flow ID: abc-123, Nodes: 1 start node"\x1b[0m\n'
  );

  while (true) {
    const userInput = await prompt("\x1b[32mYou:\x1b[0m ");

    if (userInput.toLowerCase() === "quit") {
      console.log("Goodbye!");
      rl.close();
      break;
    }

    if (!userInput.trim()) continue;

    try {
      await chat(userInput);
    } catch (error) {
      console.error("\x1b[31mError:\x1b[0m", error);
    }
  }
}

main();
