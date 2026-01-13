import OpenAI from "openai";
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

// Transform tools from agent package to OpenAI format
const tools: OpenAI.ChatCompletionTool[] = allToolSchemas.map((schema) => ({
  type: "function" as const,
  function: {
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
  },
}));

// Create OpenRouter client
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
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
const messages: OpenAI.ChatCompletionMessageParam[] = [];

async function chat(userMessage: string): Promise<void> {
  messages.push({ role: "user", content: userMessage });

  while (true) {
    const response = await client.chat.completions.create({
      model: "minimax/minimax-m2.1",
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      tools,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    // Add assistant message to history
    messages.push(assistantMessage);

    // Print text content if any
    if (assistantMessage.content) {
      console.log(`\n\x1b[36mAgent:\x1b[0m ${assistantMessage.content}\n`);
    }

    // Check for tool calls
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      for (const toolCall of assistantMessage.tool_calls) {
        if (!("function" in toolCall)) continue;
        const funcName = toolCall.function.name;
        const funcArgs = JSON.parse(toolCall.function.arguments);

        console.log(`\n\x1b[33m--- Tool Call: ${funcName} ---\x1b[0m`);
        console.log(
          `\x1b[90mArguments: ${JSON.stringify(funcArgs, null, 2)}\x1b[0m\n`
        );

        let result: any;
        try {
          if (funcName in contextTools) {
            result = await contextTools[funcName](ctx, funcArgs);
          } else if (funcName in standaloneTools) {
            result = await standaloneTools[funcName](funcArgs);
          } else {
            result = { success: false, error: `Unknown tool: ${funcName}` };
          }
        } catch (error) {
          result = { success: false, error: String(error) };
        }

        console.log(
          `\x1b[90mResult: ${JSON.stringify(result, null, 2)}\x1b[0m\n`
        );

        // Add tool result to messages
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
      // Continue the loop to let the model process tool results
    } else {
      // No tool calls, conversation turn complete
      break;
    }
  }
}

async function main() {
  console.log("\x1b[35m=== Workflow Agent Test Console ===\x1b[0m");
  console.log("Model: minimax/minimax-m2.1 via OpenRouter");
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
