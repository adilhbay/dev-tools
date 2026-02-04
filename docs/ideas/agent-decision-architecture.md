# Agent Decision Architecture Improvements

> A comprehensive plan to improve how the agent chooses what to do next using structured decision trees while preserving LLM flexibility.

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Identified Problems](#identified-problems)
3. [Proposed Solutions](#proposed-solutions)
   - [Phase 1: Enhanced System Prompt](#phase-1-enhanced-system-prompt)
   - [Phase 2: Phase-Based Tool Filtering](#phase-2-phase-based-tool-filtering)
   - [Phase 3: Intent Classification Layer](#phase-3-intent-classification-layer)
   - [Phase 4: Composite Action Tools](#phase-4-composite-action-tools)
   - [Phase 5: Smart Tool Wrappers](#phase-5-smart-tool-wrappers)
   - [Phase 6: Feedback-Driven Verification](#phase-6-feedback-driven-verification)
4. [Implementation Checklist](#implementation-checklist)

---

## Current State Analysis

### Architecture Overview

The agent lives in `packages/client/src/features/agent/` and uses a **fully agentic approach**:

```
┌─────────────────────────────────────────────────┐
│  USER MESSAGE + CHAT HISTORY + SYSTEM PROMPT    │
│         + 25 AVAILABLE TOOLS (JSON Schema)      │
└────────────┬────────────────────────────────────┘
             │
             v
┌─────────────────────────────────────────────────┐
│   LLM DECIDES: What to do next?                 │
│   • Call tools (which ones? in what order?)     │
│   • Or respond directly to user                 │
│   (tool_choice='auto' - LLM has full agency)    │
└────────────┬────────────────────────────────────┘
             │
             v
       ┌─────────────┐
       │ Tool calls? │
       └──┬────────┬─┘
          │ YES    │ NO
          v        v
       Execute   Final
       tools     response
          │        │
          v        │
    Collect       │
    results       │
          │        │
          └───┬────┘
              v
         Add to history,
         continue loop OR
         mark complete
```

### Key Files

| File | Purpose |
|------|---------|
| `use-agent-chat.ts` | Main agentic loop, message handling, tool execution coordination |
| `context-builder.ts` | Builds system prompt with flow state (nodes, edges, errors, variables) |
| `tool-schemas.ts` | Defines all 25 tools with JSON schemas |
| `tool-executor.ts` | Executes tool calls, handles validation, normalizes input |
| `types.ts` | TypeScript types for agent state |

### Current Tool Categories

```
EXECUTION TOOLS (2):
├── flowRunRequest      - Execute workflow from ManualStart
└── flowStopRequest     - Stop running execution

EXPLORATION TOOLS (10):
├── getFlowVariable     - Look up variable value
├── getEdge             - Get connection details
├── getNode             - Get node details with config
├── getNodeExecutions   - Get execution history (critical for debugging)
├── getNodeOutput       - Get node's input/output data
├── getJsNode           - Get JavaScript node details
├── getHttpNode         - Get HTTP node details
├── getConditionNode    - Get condition node details
├── getForNode          - Get for-loop node details
└── getForEachNode      - Get forEach node details

MUTATION TOOLS (13):
├── createJsNode            - Create JavaScript node
├── createHttpNode          - Create HTTP request node
├── createConditionNode     - Create if/else branching
├── createForNode           - Create fixed-count loop
├── createForEachNode       - Create array iteration loop
├── connectSequentialNodes  - Connect sequential nodes (no handle)
├── connectBranchingNodes   - Connect with handle (then/else/loop)
├── disconnectNodes         - Remove a connection
├── updateNodeConfig        - Rename or reposition node
├── updateNodeCode          - Edit JavaScript code
├── createVariable          - Add workflow variable
├── updateVariable          - Modify variable value
└── deleteNode              - Remove node from flow

CLIENT-SIDE TOOLS (2):
├── getSelectedNodes    - Query canvas selection
└── applyWorkflowPatch  - Batch multiple operations
```

### Context Provided to LLM

From `context-builder.ts`, the system prompt includes:

```
NODES: [List of all nodes with ID, Type, State, Error info]
CONNECTIONS: [All edges showing flow direction with handles]
VARIABLES: [Enabled variables only]
SELECTED NODES: [Currently selected nodes on canvas]
FLOW ENDPOINTS: [Sequential nodes with no outgoing edges]
ORPHAN NODES: [Disconnected nodes needing connection]
ERRORS: [Nodes that failed with error details]
```

### Agentic Loop (use-agent-chat.ts:495-580)

```typescript
while (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
  // Execute each tool sequentially
  for (const toolCall of assistantMessage.tool_calls) {
    const result = await executeToolCall(toolCall);
    toolResults.push(result);

    if (isMutation(toolCall)) {
      await refreshLayout(); // Update UI after mutations
    }
  }

  // Send results back to LLM
  const nextResponse = await openai.chat.completions.create({
    messages: [...history, ...toolResults],
    tools: allTools,
    tool_choice: 'auto',
  });

  assistantMessage = nextResponse.choices[0].message;
}
```

---

## Identified Problems

### 1. No Guardrails on Tool Order

**Problem:** LLM can call mutation tools before understanding the current state.

**Example failure:**
```
User: "Fix the error in my flow"
LLM: *immediately calls updateNodeCode without checking what the error is*
```

**Desired behavior:**
```
User: "Fix the error in my flow"
LLM:
  1. getNodeExecutions(failed_node) → understand the error
  2. getNodeOutput(failed_node) → see what data caused it
  3. updateNodeCode(failed_node, fix) → apply targeted fix
```

### 2. Flat Tool Presentation

**Problem:** All 25 tools compete for attention equally. The LLM must evaluate every tool on every turn.

**Impact:**
- Slower decisions
- More token usage
- Higher chance of selecting wrong tool
- Context pollution

### 3. No Phase Awareness

**Problem:** The agent can't enforce workflows like "diagnose before prescribe."

**Current state:** Every turn is independent - no memory of what phase we're in.

### 4. Expensive Exploration

**Problem:** LLM often needs 3-5 tool calls just to understand the current state before taking action.

**Cost:** Each exploration call costs tokens and latency.

### 5. Sequential vs Branching Confusion

**Problem:** LLM frequently confuses when to use `connectSequentialNodes` vs `connectBranchingNodes`.

**Root cause:** The distinction (handle required vs not) is buried in tool descriptions.

### 6. No Verification After Mutations

**Problem:** After making changes, the agent doesn't systematically verify success.

**Result:** Silent failures, orphaned nodes, broken connections.

---

## Proposed Solutions

### Phase 1: Enhanced System Prompt

**Effort:** Low | **Impact:** Medium | **Files:** `context-builder.ts`

Add explicit decision tree logic to the system prompt without code changes.

#### Implementation

Add this section to the system prompt in `context-builder.ts`:

```markdown
## DECISION PROTOCOL

Before taking action, follow this decision tree:

### Step 1: DIAGNOSE (Required before mutations)
Ask yourself:
- Are there errors in the flow? → Use getNodeExecutions FIRST
- Is the current state unclear? → Use exploration tools before mutation
- What nodes exist and how are they connected?

### Step 2: PLAN (State your intent)
Before executing, briefly state:
- What is the goal?
- What is the minimal set of changes needed?
- What order should operations happen?

### Step 3: EXECUTE (One logical operation at a time)
- Create nodes before connecting them
- Connect nodes before running the flow
- After each mutation, verify it succeeded

### Step 4: VERIFY (Check your work)
- Did the operation succeed?
- Are there new errors or orphan nodes?
- Does the flow structure match the intent?

## TOOL SELECTION RULES

### For Debugging Errors:
1. ALWAYS call getNodeExecutions(failed_node_id) first
2. Then getNodeOutput to see the data that caused the error
3. Only then attempt fixes with updateNodeCode

### For Creating Nodes:
1. Check FLOW ENDPOINTS to see where new nodes can connect
2. Create the node with appropriate type
3. Connect it to an endpoint

### For Connecting Nodes:
- Sequential nodes (ManualStart, JavaScript, HTTP): Use connectSequentialNodes, NO handle
- Branching nodes (Condition, For, ForEach): Use connectBranchingNodes, MUST specify handle
  - Condition: handle = "then" or "else"
  - For/ForEach: handle = "then" (loop body) or "loop" (after loop completes)

### For Running Flows:
1. Check for orphan nodes (they won't execute)
2. Verify ManualStart exists
3. Call flowRunRequest
```

#### Acceptance Criteria

- [ ] Decision protocol added to system prompt
- [ ] Tool selection rules documented
- [ ] Tested with error debugging scenario
- [ ] Tested with node creation scenario
- [ ] Tested with connection scenario

---

### Phase 2: Phase-Based Tool Filtering

**Effort:** Medium | **Impact:** High | **Files:** `use-agent-chat.ts`, `tool-schemas.ts`

Implement a state machine that restricts available tools based on the current phase.

#### Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   ANALYZE    │ ──> │    PLAN      │ ──> │   EXECUTE    │ ──> │   VERIFY     │
│  (read-only) │     │  (reasoning) │     │  (mutations) │     │  (validate)  │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
     │                     │                    │                    │
     v                     v                    v                    v
  Exploration          No tools             Mutation              Exploration
  tools ONLY          (LLM thinks)         tools OK              tools ONLY
```

#### Implementation

**New file: `agent-phases.ts`**

```typescript
export type AgentPhase = 'analyze' | 'plan' | 'execute' | 'verify';

export interface PhaseConfig {
  allowedTools: string[];
  systemPromptAddition: string;
  transitionCondition: (context: PhaseContext) => boolean;
}

export const PHASE_CONFIGS: Record<AgentPhase, PhaseConfig> = {
  analyze: {
    allowedTools: [
      'getNode',
      'getNodeExecutions',
      'getNodeOutput',
      'getEdge',
      'getFlowVariable',
      'getJsNode',
      'getHttpNode',
      'getConditionNode',
      'getForNode',
      'getForEachNode',
      'getSelectedNodes',
    ],
    systemPromptAddition: `
## CURRENT PHASE: ANALYZE
You are in the analysis phase. Your goal is to understand the current state.
- Use exploration tools to gather information
- You cannot make changes yet
- When you have enough information, say "Ready to plan" to proceed
    `,
    transitionCondition: (ctx) => ctx.lastMessage.includes('Ready to plan'),
  },

  plan: {
    allowedTools: [], // No tools - pure reasoning
    systemPromptAddition: `
## CURRENT PHASE: PLAN
You are in the planning phase. State your plan clearly:
1. What changes will you make?
2. In what order?
3. What could go wrong?

When your plan is complete, say "Ready to execute" to proceed.
    `,
    transitionCondition: (ctx) => ctx.lastMessage.includes('Ready to execute'),
  },

  execute: {
    allowedTools: [
      'createJsNode',
      'createHttpNode',
      'createConditionNode',
      'createForNode',
      'createForEachNode',
      'connectSequentialNodes',
      'connectBranchingNodes',
      'disconnectNodes',
      'updateNodeConfig',
      'updateNodeCode',
      'createVariable',
      'updateVariable',
      'deleteNode',
      'applyWorkflowPatch',
    ],
    systemPromptAddition: `
## CURRENT PHASE: EXECUTE
You are in the execution phase. Make the changes from your plan.
- Execute one logical operation at a time
- If something fails, you may need to return to ANALYZE
- When done, say "Ready to verify" to proceed
    `,
    transitionCondition: (ctx) => ctx.lastMessage.includes('Ready to verify'),
  },

  verify: {
    allowedTools: [
      'getNode',
      'getNodeExecutions',
      'getNodeOutput',
      'flowRunRequest',
      'flowStopRequest',
    ],
    systemPromptAddition: `
## CURRENT PHASE: VERIFY
You are in the verification phase. Check that your changes worked:
- Verify nodes were created/connected correctly
- Run the flow if appropriate
- Check for errors

If everything looks good, summarize what was done.
If there are issues, say "Need to analyze" to return to ANALYZE phase.
    `,
    transitionCondition: (ctx) =>
      ctx.lastMessage.includes('Need to analyze') ||
      !ctx.lastMessage.includes('tool_calls'),
  },
};

export function getToolsForPhase(phase: AgentPhase, allTools: Tool[]): Tool[] {
  const allowedNames = PHASE_CONFIGS[phase].allowedTools;
  return allTools.filter(tool => allowedNames.includes(tool.function.name));
}

export function getNextPhase(currentPhase: AgentPhase, context: PhaseContext): AgentPhase {
  if (PHASE_CONFIGS[currentPhase].transitionCondition(context)) {
    const phaseOrder: AgentPhase[] = ['analyze', 'plan', 'execute', 'verify'];
    const currentIndex = phaseOrder.indexOf(currentPhase);

    // Special case: verify can loop back to analyze
    if (currentPhase === 'verify' && context.lastMessage.includes('Need to analyze')) {
      return 'analyze';
    }

    return phaseOrder[(currentIndex + 1) % phaseOrder.length];
  }
  return currentPhase;
}
```

**Modifications to `use-agent-chat.ts`:**

```typescript
// Add phase state
const [currentPhase, setCurrentPhase] = useState<AgentPhase>('analyze');

// In sendMessage, filter tools by phase
const phaseTools = getToolsForPhase(currentPhase, allTools);
const phasePrompt = PHASE_CONFIGS[currentPhase].systemPromptAddition;

const response = await openai.chat.completions.create({
  messages: [
    { role: 'system', content: systemPrompt + phasePrompt },
    ...history,
  ],
  tools: phaseTools.length > 0 ? phaseTools : undefined,
  tool_choice: phaseTools.length > 0 ? 'auto' : 'none',
});

// After response, check for phase transition
const nextPhase = getNextPhase(currentPhase, {
  lastMessage: response.choices[0].message.content,
  toolsCalled: response.choices[0].message.tool_calls,
});

if (nextPhase !== currentPhase) {
  setCurrentPhase(nextPhase);
}
```

#### Acceptance Criteria

- [ ] `agent-phases.ts` created with phase definitions
- [ ] `use-agent-chat.ts` modified to track phase state
- [ ] Tools filtered by current phase
- [ ] Phase transitions work correctly
- [ ] UI shows current phase (optional)
- [ ] Can override phases for simple requests (optional)

---

### Phase 3: Intent Classification Layer

**Effort:** Low | **Impact:** Medium | **Files:** `use-agent-chat.ts`, new `intent-classifier.ts`

Add a lightweight pre-classification step to route requests intelligently.

#### Architecture

```
User Message
     │
     v
┌─────────────────┐
│ Intent Classifier│  (gpt-4o-mini, ~10 tokens)
│                 │
│ Outputs:        │
│ - intent type   │
│ - confidence    │
│ - suggested     │
│   starting phase│
└────────┬────────┘
         │
         v
┌─────────────────┐
│ Tool Subset     │
│ Selection       │
│                 │
│ Based on intent,│
│ select relevant │
│ tools only      │
└────────┬────────┘
         │
         v
   Main LLM Call
   (with filtered tools)
```

#### Implementation

**New file: `intent-classifier.ts`**

```typescript
import OpenAI from 'openai';

export type UserIntent =
  | 'create'      // User wants to add new nodes/functionality
  | 'debug'       // User wants to fix errors
  | 'connect'     // User wants to wire nodes together
  | 'modify'      // User wants to change existing nodes
  | 'run'         // User wants to execute the flow
  | 'explain'     // User wants to understand the flow
  | 'delete'      // User wants to remove nodes
  | 'unknown';    // Can't determine intent

export interface ClassificationResult {
  intent: UserIntent;
  confidence: number;
  suggestedPhase: AgentPhase;
  relevantTools: string[];
}

const INTENT_TOOL_MAP: Record<UserIntent, string[]> = {
  create: [
    'createJsNode', 'createHttpNode', 'createConditionNode',
    'createForNode', 'createForEachNode', 'connectSequentialNodes',
    'connectBranchingNodes',
  ],
  debug: [
    'getNodeExecutions', 'getNodeOutput', 'getNode',
    'updateNodeCode', 'flowRunRequest',
  ],
  connect: [
    'getNode', 'connectSequentialNodes', 'connectBranchingNodes',
    'disconnectNodes',
  ],
  modify: [
    'getNode', 'getJsNode', 'getHttpNode', 'updateNodeConfig',
    'updateNodeCode',
  ],
  run: [
    'flowRunRequest', 'flowStopRequest', 'getNodeExecutions',
    'getNodeOutput',
  ],
  explain: [
    'getNode', 'getEdge', 'getNodeExecutions', 'getNodeOutput',
    'getFlowVariable',
  ],
  delete: [
    'getNode', 'deleteNode', 'disconnectNodes',
  ],
  unknown: [], // Will use all tools
};

const INTENT_PHASE_MAP: Record<UserIntent, AgentPhase> = {
  create: 'execute',
  debug: 'analyze',
  connect: 'execute',
  modify: 'analyze',
  run: 'execute',
  explain: 'analyze',
  delete: 'analyze',
  unknown: 'analyze',
};

export async function classifyIntent(
  message: string,
  flowContext: { hasErrors: boolean; hasOrphans: boolean; nodeCount: number }
): Promise<ClassificationResult> {
  const openai = new OpenAI();

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `Classify the user's intent into exactly one category:
- create: Adding new nodes or functionality
- debug: Fixing errors or investigating failures
- connect: Wiring nodes together
- modify: Changing existing node configuration or code
- run: Executing or testing the workflow
- explain: Understanding how something works
- delete: Removing nodes or connections
- unknown: Cannot determine

Context:
- Flow has errors: ${flowContext.hasErrors}
- Flow has orphan nodes: ${flowContext.hasOrphans}
- Total nodes: ${flowContext.nodeCount}

Respond with just the category name, nothing else.`,
      },
      {
        role: 'user',
        content: message,
      },
    ],
    max_tokens: 10,
    temperature: 0,
  });

  const intent = (response.choices[0].message.content?.trim().toLowerCase() || 'unknown') as UserIntent;

  return {
    intent,
    confidence: 0.9, // Could be enhanced with logprobs
    suggestedPhase: INTENT_PHASE_MAP[intent],
    relevantTools: INTENT_TOOL_MAP[intent],
  };
}
```

**Modifications to `use-agent-chat.ts`:**

```typescript
const sendMessage = async (message: string) => {
  // Step 1: Classify intent (fast, cheap)
  const classification = await classifyIntent(message, {
    hasErrors: flowState.errors.length > 0,
    hasOrphans: flowState.orphanNodes.length > 0,
    nodeCount: flowState.nodes.length,
  });

  // Step 2: Select tools based on intent
  let tools = allTools;
  if (classification.intent !== 'unknown' && classification.confidence > 0.8) {
    tools = allTools.filter(t =>
      classification.relevantTools.includes(t.function.name)
    );
  }

  // Step 3: Optionally set starting phase
  if (classification.suggestedPhase) {
    setCurrentPhase(classification.suggestedPhase);
  }

  // Step 4: Main LLM call with filtered tools
  const response = await openai.chat.completions.create({
    messages: [...],
    tools,
  });
};
```

#### Acceptance Criteria

- [ ] `intent-classifier.ts` created
- [ ] Classification integrated into message flow
- [ ] Tool filtering based on intent works
- [ ] Fallback to all tools when intent is unknown
- [ ] Classification cost is minimal (< 100 tokens)

---

### Phase 4: Composite Action Tools

**Effort:** Low | **Impact:** Medium | **Files:** `tool-schemas.ts`, `tool-executor.ts`

Create higher-level tools that combine common multi-step operations.

#### Rationale

Many user requests require predictable sequences:
- "Add a node" = create + connect
- "Insert a node between X and Y" = disconnect + create + connect + connect
- "Replace node X with Y" = create Y + rewire connections + delete X

By providing composite tools, we:
1. Reduce the number of LLM decisions
2. Ensure correct operation ordering
3. Reduce token usage
4. Improve reliability

#### Implementation

**New composite tools in `tool-schemas.ts`:**

```typescript
export const compositeToolSchemas = [
  {
    type: 'function',
    function: {
      name: 'addNodeToFlow',
      description: `Creates a new node and connects it to an existing node in one operation.
Use this instead of separate create + connect calls.
Automatically handles sequential vs branching connection logic.`,
      parameters: {
        type: 'object',
        properties: {
          nodeType: {
            type: 'string',
            enum: ['javascript', 'http', 'condition', 'for', 'forEach'],
            description: 'Type of node to create',
          },
          name: {
            type: 'string',
            description: 'Name for the new node',
          },
          connectAfter: {
            type: 'string',
            description: 'ID or name of the node to connect after',
          },
          handleName: {
            type: 'string',
            enum: ['then', 'else', 'loop'],
            description: 'Required only if connectAfter is a branching node (Condition, For, ForEach)',
          },
          code: {
            type: 'string',
            description: 'JavaScript code (only for javascript nodeType)',
          },
          httpConfig: {
            type: 'object',
            description: 'HTTP configuration (only for http nodeType)',
            properties: {
              method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
              url: { type: 'string' },
              headers: { type: 'object' },
              body: { type: 'string' },
            },
          },
        },
        required: ['nodeType', 'name', 'connectAfter'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'insertNodeBetween',
      description: `Inserts a new node between two existing connected nodes.
Handles disconnecting the original edge and creating new connections.`,
      parameters: {
        type: 'object',
        properties: {
          nodeType: {
            type: 'string',
            enum: ['javascript', 'http'],
            description: 'Type of node to insert (must be sequential)',
          },
          name: {
            type: 'string',
            description: 'Name for the new node',
          },
          afterNode: {
            type: 'string',
            description: 'ID or name of the upstream node',
          },
          beforeNode: {
            type: 'string',
            description: 'ID or name of the downstream node',
          },
          handleName: {
            type: 'string',
            description: 'Handle name if afterNode is a branching node',
          },
          code: {
            type: 'string',
            description: 'JavaScript code (for javascript nodeType)',
          },
        },
        required: ['nodeType', 'name', 'afterNode', 'beforeNode'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'duplicateNode',
      description: `Creates a copy of an existing node with a new name.
Copies all configuration but does not copy connections.`,
      parameters: {
        type: 'object',
        properties: {
          sourceNode: {
            type: 'string',
            description: 'ID or name of the node to duplicate',
          },
          newName: {
            type: 'string',
            description: 'Name for the duplicate node',
          },
          connectAfter: {
            type: 'string',
            description: 'Optional: node to connect the duplicate after',
          },
        },
        required: ['sourceNode', 'newName'],
      },
    },
  },
];
```

**New composite executors in `tool-executor.ts`:**

```typescript
async function executeAddNodeToFlow(params: AddNodeToFlowParams): Promise<ToolResult> {
  const { nodeType, name, connectAfter, handleName, code, httpConfig } = params;

  // Step 1: Resolve the source node
  const sourceNode = await resolveNode(connectAfter);
  if (!sourceNode) {
    return { success: false, error: `Node "${connectAfter}" not found` };
  }

  // Step 2: Determine if handle is needed
  const isBranching = ['Condition', 'For', 'ForEach'].includes(sourceNode.type);
  if (isBranching && !handleName) {
    return {
      success: false,
      error: `Node "${sourceNode.name}" is a branching node. Please specify handleName: "then", "else", or "loop"`,
    };
  }

  // Step 3: Create the node
  let newNode;
  switch (nodeType) {
    case 'javascript':
      newNode = await createJsNode({ name, code: code || 'return ctx;' });
      break;
    case 'http':
      newNode = await createHttpNode({ name, ...httpConfig });
      break;
    case 'condition':
      newNode = await createConditionNode({ name });
      break;
    case 'for':
      newNode = await createForNode({ name });
      break;
    case 'forEach':
      newNode = await createForEachNode({ name });
      break;
  }

  if (!newNode.success) {
    return newNode;
  }

  // Step 4: Connect the nodes
  const connectResult = isBranching
    ? await connectBranchingNodes({
        sourceId: sourceNode.id,
        targetId: newNode.nodeId,
        handleName
      })
    : await connectSequentialNodes({
        sourceId: sourceNode.id,
        targetId: newNode.nodeId
      });

  if (!connectResult.success) {
    // Rollback: delete the created node
    await deleteNode({ nodeId: newNode.nodeId });
    return {
      success: false,
      error: `Created node but failed to connect: ${connectResult.error}`,
    };
  }

  return {
    success: true,
    nodeId: newNode.nodeId,
    nodeName: name,
    connectedTo: sourceNode.name,
    message: `Created ${nodeType} node "${name}" and connected it after "${sourceNode.name}"`,
  };
}

async function executeInsertNodeBetween(params: InsertNodeBetweenParams): Promise<ToolResult> {
  const { nodeType, name, afterNode, beforeNode, handleName, code } = params;

  // Step 1: Resolve both nodes
  const upstream = await resolveNode(afterNode);
  const downstream = await resolveNode(beforeNode);

  if (!upstream) return { success: false, error: `Node "${afterNode}" not found` };
  if (!downstream) return { success: false, error: `Node "${beforeNode}" not found` };

  // Step 2: Find and remove existing edge
  const edge = await findEdge(upstream.id, downstream.id, handleName);
  if (!edge) {
    return {
      success: false,
      error: `No connection found from "${upstream.name}" to "${downstream.name}"`,
    };
  }

  await disconnectNodes({ edgeId: edge.id });

  // Step 3: Create new node
  const newNode = await createNode(nodeType, { name, code });
  if (!newNode.success) {
    // Rollback: restore original edge
    await connectNodes(upstream.id, downstream.id, handleName);
    return newNode;
  }

  // Step 4: Connect upstream -> new node
  const upstreamConnect = await connectNodes(upstream.id, newNode.nodeId, handleName);
  if (!upstreamConnect.success) {
    await deleteNode({ nodeId: newNode.nodeId });
    await connectNodes(upstream.id, downstream.id, handleName);
    return { success: false, error: `Failed to connect upstream: ${upstreamConnect.error}` };
  }

  // Step 5: Connect new node -> downstream
  const downstreamConnect = await connectSequentialNodes({
    sourceId: newNode.nodeId,
    targetId: downstream.id,
  });
  if (!downstreamConnect.success) {
    await deleteNode({ nodeId: newNode.nodeId });
    await connectNodes(upstream.id, downstream.id, handleName);
    return { success: false, error: `Failed to connect downstream: ${downstreamConnect.error}` };
  }

  return {
    success: true,
    nodeId: newNode.nodeId,
    message: `Inserted "${name}" between "${upstream.name}" and "${downstream.name}"`,
  };
}
```

#### Acceptance Criteria

- [ ] `addNodeToFlow` composite tool implemented
- [ ] `insertNodeBetween` composite tool implemented
- [ ] `duplicateNode` composite tool implemented
- [ ] Rollback logic works when partial operations fail
- [ ] Old granular tools still available for edge cases

---

### Phase 5: Smart Tool Wrappers

**Effort:** Medium | **Impact:** High | **Files:** `tool-executor.ts`

Add intelligent pre-flight validation and automatic parameter inference.

#### Rationale

Many tool call failures are predictable:
- Missing required handle for branching nodes
- Node doesn't exist
- Handle already has a connection
- Invalid node type combinations

By catching these before execution, we can:
1. Provide better error messages
2. Suggest corrections
3. Auto-fix common mistakes

#### Implementation

**New file: `tool-validators.ts`**

```typescript
export interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: string;
  autoFix?: Record<string, any>; // Parameters to auto-correct
}

export async function validateConnectNodes(
  params: ConnectNodesParams,
  flowState: FlowState
): Promise<ValidationResult> {
  const { sourceId, targetId, handleName } = params;

  // Find source node
  const sourceNode = flowState.nodes.find(n =>
    n.id === sourceId || n.data.name === sourceId
  );

  if (!sourceNode) {
    return {
      valid: false,
      error: `Source node "${sourceId}" not found`,
      suggestion: `Available nodes: ${flowState.nodes.map(n => n.data.name).join(', ')}`,
    };
  }

  // Find target node
  const targetNode = flowState.nodes.find(n =>
    n.id === targetId || n.data.name === targetId
  );

  if (!targetNode) {
    return {
      valid: false,
      error: `Target node "${targetId}" not found`,
      suggestion: `Available nodes: ${flowState.nodes.map(n => n.data.name).join(', ')}`,
    };
  }

  // Check if source is branching
  const isBranching = ['Condition', 'For', 'ForEach'].includes(sourceNode.type);

  if (isBranching && !handleName) {
    // Suggest available handles
    const existingConnections = flowState.edges.filter(e => e.source === sourceNode.id);
    const usedHandles = existingConnections.map(e => e.sourceHandle);
    const availableHandles = getHandlesForType(sourceNode.type).filter(h => !usedHandles.includes(h));

    if (availableHandles.length === 1) {
      // Auto-fix: only one handle available
      return {
        valid: true,
        autoFix: { handleName: availableHandles[0] },
      };
    }

    return {
      valid: false,
      error: `"${sourceNode.data.name}" is a ${sourceNode.type} node and requires a handle`,
      suggestion: `Available handles: ${availableHandles.join(', ')}`,
    };
  }

  if (!isBranching && handleName) {
    // Auto-fix: remove unnecessary handle
    return {
      valid: true,
      autoFix: { handleName: undefined },
    };
  }

  // Check if handle already connected
  if (handleName) {
    const existingEdge = flowState.edges.find(e =>
      e.source === sourceNode.id && e.sourceHandle === handleName
    );

    if (existingEdge) {
      const existingTarget = flowState.nodes.find(n => n.id === existingEdge.target);
      return {
        valid: false,
        error: `Handle "${handleName}" is already connected to "${existingTarget?.data.name}"`,
        suggestion: `Use disconnectNodes first, or choose a different handle`,
      };
    }
  }

  return { valid: true };
}

export async function validateCreateNode(
  params: CreateNodeParams,
  flowState: FlowState
): Promise<ValidationResult> {
  const { name, type } = params;

  // Check for duplicate name
  const existingNode = flowState.nodes.find(n =>
    n.data.name.toLowerCase() === name.toLowerCase()
  );

  if (existingNode) {
    const suggestedName = `${name}_${Date.now().toString(36)}`;
    return {
      valid: false,
      error: `A node named "${name}" already exists`,
      suggestion: `Try "${suggestedName}" instead`,
      autoFix: { name: suggestedName },
    };
  }

  return { valid: true };
}

function getHandlesForType(nodeType: string): string[] {
  switch (nodeType) {
    case 'Condition':
      return ['then', 'else'];
    case 'For':
    case 'ForEach':
      return ['then', 'loop'];
    default:
      return [];
  }
}
```

**Modifications to `tool-executor.ts`:**

```typescript
export async function executeToolCall(
  toolCall: ToolCall,
  flowState: FlowState
): Promise<ToolResult> {
  const { name, arguments: args } = toolCall.function;
  const params = JSON.parse(args);

  // Pre-flight validation
  const validator = TOOL_VALIDATORS[name];
  if (validator) {
    const validation = await validator(params, flowState);

    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        suggestion: validation.suggestion,
      };
    }

    // Apply auto-fixes
    if (validation.autoFix) {
      Object.assign(params, validation.autoFix);
    }
  }

  // Execute with validated/fixed params
  return executeToolInternal(name, params);
}

const TOOL_VALIDATORS: Record<string, ValidatorFn> = {
  connectSequentialNodes: validateConnectNodes,
  connectBranchingNodes: validateConnectNodes,
  createJsNode: validateCreateNode,
  createHttpNode: validateCreateNode,
  createConditionNode: validateCreateNode,
  createForNode: validateCreateNode,
  createForEachNode: validateCreateNode,
};
```

#### Acceptance Criteria

- [ ] Validators implemented for connection tools
- [ ] Validators implemented for creation tools
- [ ] Auto-fix logic works for single-option cases
- [ ] Helpful suggestions returned in error messages
- [ ] Validation doesn't break existing functionality

---

### Phase 6: Feedback-Driven Verification

**Effort:** Medium | **Impact:** Medium | **Files:** `use-agent-chat.ts`, `tool-executor.ts`

Automatically verify state changes after mutations and report discrepancies.

#### Rationale

After mutations, the agent should:
1. Know exactly what changed
2. Detect unexpected side effects
3. Identify new errors or orphans
4. Decide if follow-up actions are needed

#### Implementation

**New file: `state-diff.ts`**

```typescript
export interface StateDiff {
  nodesAdded: NodeSummary[];
  nodesRemoved: NodeSummary[];
  nodesModified: NodeModification[];
  edgesAdded: EdgeSummary[];
  edgesRemoved: EdgeSummary[];
  newErrors: ErrorSummary[];
  resolvedErrors: ErrorSummary[];
  newOrphans: string[];
  resolvedOrphans: string[];
}

export interface NodeSummary {
  id: string;
  name: string;
  type: string;
}

export interface NodeModification {
  id: string;
  name: string;
  changes: Record<string, { old: any; new: any }>;
}

export interface EdgeSummary {
  sourceNode: string;
  targetNode: string;
  handle?: string;
}

export interface ErrorSummary {
  nodeId: string;
  nodeName: string;
  error: string;
}

export function computeStateDiff(
  before: FlowState,
  after: FlowState
): StateDiff {
  const diff: StateDiff = {
    nodesAdded: [],
    nodesRemoved: [],
    nodesModified: [],
    edgesAdded: [],
    edgesRemoved: [],
    newErrors: [],
    resolvedErrors: [],
    newOrphans: [],
    resolvedOrphans: [],
  };

  // Compute node changes
  const beforeNodeIds = new Set(before.nodes.map(n => n.id));
  const afterNodeIds = new Set(after.nodes.map(n => n.id));

  for (const node of after.nodes) {
    if (!beforeNodeIds.has(node.id)) {
      diff.nodesAdded.push({
        id: node.id,
        name: node.data.name,
        type: node.type,
      });
    }
  }

  for (const node of before.nodes) {
    if (!afterNodeIds.has(node.id)) {
      diff.nodesRemoved.push({
        id: node.id,
        name: node.data.name,
        type: node.type,
      });
    }
  }

  // Compute edge changes
  const edgeKey = (e: Edge) => `${e.source}-${e.sourceHandle || 'default'}-${e.target}`;
  const beforeEdgeKeys = new Set(before.edges.map(edgeKey));
  const afterEdgeKeys = new Set(after.edges.map(edgeKey));

  for (const edge of after.edges) {
    if (!beforeEdgeKeys.has(edgeKey(edge))) {
      const source = after.nodes.find(n => n.id === edge.source);
      const target = after.nodes.find(n => n.id === edge.target);
      diff.edgesAdded.push({
        sourceNode: source?.data.name || edge.source,
        targetNode: target?.data.name || edge.target,
        handle: edge.sourceHandle,
      });
    }
  }

  for (const edge of before.edges) {
    if (!afterEdgeKeys.has(edgeKey(edge))) {
      const source = before.nodes.find(n => n.id === edge.source);
      const target = before.nodes.find(n => n.id === edge.target);
      diff.edgesRemoved.push({
        sourceNode: source?.data.name || edge.source,
        targetNode: target?.data.name || edge.target,
        handle: edge.sourceHandle,
      });
    }
  }

  // Compute error changes
  const beforeErrorNodes = new Set(
    before.nodes.filter(n => n.data.state === 'error').map(n => n.id)
  );
  const afterErrorNodes = new Set(
    after.nodes.filter(n => n.data.state === 'error').map(n => n.id)
  );

  for (const node of after.nodes) {
    if (node.data.state === 'error' && !beforeErrorNodes.has(node.id)) {
      diff.newErrors.push({
        nodeId: node.id,
        nodeName: node.data.name,
        error: node.data.error || 'Unknown error',
      });
    }
  }

  for (const node of before.nodes) {
    if (node.data.state === 'error' && !afterErrorNodes.has(node.id)) {
      diff.resolvedErrors.push({
        nodeId: node.id,
        nodeName: node.data.name,
        error: node.data.error || 'Unknown error',
      });
    }
  }

  // Compute orphan changes
  const getOrphans = (state: FlowState) => {
    const connectedNodes = new Set<string>();
    for (const edge of state.edges) {
      connectedNodes.add(edge.source);
      connectedNodes.add(edge.target);
    }
    return state.nodes
      .filter(n => !connectedNodes.has(n.id) && n.type !== 'ManualStart')
      .map(n => n.data.name);
  };

  const beforeOrphans = new Set(getOrphans(before));
  const afterOrphans = new Set(getOrphans(after));

  diff.newOrphans = [...afterOrphans].filter(n => !beforeOrphans.has(n));
  diff.resolvedOrphans = [...beforeOrphans].filter(n => !afterOrphans.has(n));

  return diff;
}

export function formatStateDiff(diff: StateDiff): string {
  const lines: string[] = [];

  if (diff.nodesAdded.length > 0) {
    lines.push(`✅ Added nodes: ${diff.nodesAdded.map(n => n.name).join(', ')}`);
  }

  if (diff.nodesRemoved.length > 0) {
    lines.push(`🗑️ Removed nodes: ${diff.nodesRemoved.map(n => n.name).join(', ')}`);
  }

  if (diff.edgesAdded.length > 0) {
    lines.push(`🔗 Added connections: ${diff.edgesAdded.map(e =>
      `${e.sourceNode}${e.handle ? `[${e.handle}]` : ''} → ${e.targetNode}`
    ).join(', ')}`);
  }

  if (diff.edgesRemoved.length > 0) {
    lines.push(`✂️ Removed connections: ${diff.edgesRemoved.map(e =>
      `${e.sourceNode} → ${e.targetNode}`
    ).join(', ')}`);
  }

  if (diff.newErrors.length > 0) {
    lines.push(`❌ New errors: ${diff.newErrors.map(e =>
      `${e.nodeName}: ${e.error}`
    ).join('; ')}`);
  }

  if (diff.resolvedErrors.length > 0) {
    lines.push(`✅ Resolved errors: ${diff.resolvedErrors.map(e => e.nodeName).join(', ')}`);
  }

  if (diff.newOrphans.length > 0) {
    lines.push(`⚠️ New orphan nodes: ${diff.newOrphans.join(', ')}`);
  }

  if (diff.resolvedOrphans.length > 0) {
    lines.push(`✅ Connected orphans: ${diff.resolvedOrphans.join(', ')}`);
  }

  return lines.length > 0 ? lines.join('\n') : 'No changes detected.';
}
```

**Modifications to `use-agent-chat.ts`:**

```typescript
// In the tool execution loop
for (const toolCall of assistantMessage.tool_calls) {
  const beforeState = await captureFlowState();

  const result = await executeToolCall(toolCall);

  if (isMutation(toolCall)) {
    await refreshLayout();
    const afterState = await captureFlowState();

    // Compute and attach diff to result
    const diff = computeStateDiff(beforeState, afterState);
    result.stateChanges = formatStateDiff(diff);

    // Alert on concerning changes
    if (diff.newErrors.length > 0) {
      result.warning = `⚠️ This operation caused new errors`;
    }
    if (diff.newOrphans.length > 0) {
      result.warning = `⚠️ This operation created orphan nodes`;
    }
  }

  toolResults.push(result);
}
```

#### Acceptance Criteria

- [ ] `state-diff.ts` implemented with diff computation
- [ ] Diff attached to mutation tool results
- [ ] Formatted diff is human-readable
- [ ] Warnings for new errors/orphans
- [ ] LLM can use diff info to decide next actions

---

## Implementation Checklist

### Phase 1: Enhanced System Prompt ✅ COMPLETED
- [x] Add decision protocol to `context-builder.ts`
- [x] Add tool selection rules
- [ ] Test with various scenarios
- [ ] Measure improvement in decision quality

### Phase 2: Phase-Based Tool Filtering
- [ ] Create `agent-phases.ts`
- [ ] Add phase state to `use-agent-chat.ts`
- [ ] Implement tool filtering by phase
- [ ] Implement phase transitions
- [ ] Add phase indicator to UI (optional)

### Phase 3: Intent Classification
- [ ] Create `intent-classifier.ts`
- [ ] Integrate classification into message flow
- [ ] Map intents to tool subsets
- [ ] Test classification accuracy
- [ ] Optimize for cost/latency

### Phase 4: Composite Tools
- [ ] Add `addNodeToFlow` tool
- [ ] Add `insertNodeBetween` tool
- [ ] Add `duplicateNode` tool
- [ ] Implement rollback logic
- [ ] Update tool schemas

### Phase 5: Smart Wrappers
- [ ] Create `tool-validators.ts`
- [ ] Implement connection validators
- [ ] Implement creation validators
- [ ] Add auto-fix logic
- [ ] Integrate into `tool-executor.ts`

### Phase 6: State Verification
- [ ] Create `state-diff.ts`
- [ ] Implement diff computation
- [ ] Format diff for LLM consumption
- [ ] Attach diff to tool results
- [ ] Add warnings for concerning changes

---

## Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| Tool calls per task | ~5-8 | ~2-4 |
| Failed tool calls | ~20% | <5% |
| Token usage per task | ~4000 | ~2000 |
| User correction rate | ~30% | <10% |
| Time to complete task | Variable | 50% reduction |

---

## Notes

- Each phase builds on the previous
- Phase 1 can be shipped immediately with just prompt changes
- Phases 2-3 can be developed in parallel
- Phases 4-6 are additive improvements
- All changes should be backwards compatible
- Consider A/B testing each phase
