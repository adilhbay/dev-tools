# Workflow Agent Specification

> Claude Code for Workflows - A chat-powered workflow builder that lets users create, modify, and debug workflows through natural language conversation.

## Table of Contents

1. [Vision](#vision)
2. [Core Concepts](#core-concepts)
3. [Architecture](#architecture)
4. [Existing Infrastructure](#existing-infrastructure)
5. [Tool Definitions](#tool-definitions)
6. [Context Injection Strategy](#context-injection-strategy)
7. [MD Templates](#md-templates)
8. [User Experience](#user-experience)
9. [Implementation Decisions](#implementation-decisions)
10. [Next Steps](#next-steps)

---

## Vision

Build a **Claude Code-like experience for workflows**. The chat interface is the expert when it comes to building any kind of workflow - creating nodes, discovering paths, debugging issues, and iterating until the user is satisfied.

### Key Principles

- **Freeform interaction**: User describes what they want, agent figures out how
- **Model agnostic**: Support Claude, GPT, and other models via same tool interface
- **Minimal prompting**: Automatic context injection where useful
- **Iterate until done**: Like Claude Code - conversation continues until user is satisfied
- **Configurable autonomy**: User can choose human-in-the-loop or autonomous mode

---

## Core Concepts

### The "Core" Node

Two node types serve as the universal building blocks:

1. **JS Node** (`NODE_KIND_JS`): Executes JavaScript code
   - User describes logic → Claude generates the code
   - Has access to: `fetch`, workflow SDK, variables/secrets

2. **HTTP Node** (`NODE_KIND_HTTP`): Makes HTTP requests
   - User describes the API call → Claude configures the request
   - Supports headers, query params, body (raw, form-data, url-encoded)

### MD Templates

Markdown files that provide Claude with context on how to implement common patterns:

- One MD file per node type/template
- Contains: purpose, available APIs, input/output contracts, example implementations, constraints
- User-creatable + community registry
- Templates are stable; users add additional instructions on top

### Conversation Model

- Chat state persists per workflow (user controls when to clear)
- Claude has access to: workflow graph, node details, execution history, previous conversation
- Refinement happens through continued conversation (like Claude Code)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         Web Client                            │
│   ┌─────────────┐    ┌─────────────────────────────┐         │
│   │  Workflow   │    │       Chat Panel            │         │
│   │  Canvas     │◄──►│  (Agent conversation)       │         │
│   └─────────────┘    └──────────────┬──────────────┘         │
└──────────────────────────────────────┼───────────────────────┘
                                       │ WebSocket / HTTP streaming
                                       ▼
┌──────────────────────────────────────────────────────────────┐
│              Agent Service (NEW - TypeScript)                 │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  LLM SDK (Vercel AI SDK / Anthropic SDK / OpenAI SDK)   │ │
│  │  - Model agnostic                                        │ │
│  │  - Streaming built-in                                    │ │
│  │  - Tool calling abstracted                               │ │
│  └─────────────────────────────────────────────────────────┘ │
│                            │                                  │
│  ┌─────────────────────────▼─────────────────────────────┐   │
│  │  Tool Implementations                                  │   │
│  │  - Maps agent tool calls to gRPC service calls         │   │
│  │  - Manages conversation state                          │   │
│  │  - Handles streaming responses                         │   │
│  └───────────────────────────────────────────────────────┘   │
│                            │                                  │
└────────────────────────────┼──────────────────────────────────┘
                             │ gRPC-Web / Connect
                             ▼
┌──────────────────────────────────────────────────────────────┐
│              Existing Go Server (unchanged)                   │
│                FlowService, HTTPService, etc.                 │
└──────────────────────────────────────────────────────────────┘
```

### Why TypeScript for Agent Service?

- LLM SDKs are significantly more mature in TypeScript
- Vercel AI SDK provides model-agnostic abstraction out of the box
- Client is already TypeScript (shared types)
- Easier to iterate on prompts and tool definitions
- Can start as serverless, scale later

### Why Separate Service?

- Single responsibility: Agent service handles LLM, Go server handles workflow execution
- Iterate fast: Change prompts/tools without touching Go code
- Scale independently: Agent service can be serverless
- Auth later: Agent service passes through user tokens to Go backend

---

## Existing Infrastructure

### FlowService gRPC APIs (Already Built)

The client UI already uses these APIs. The agent calls the **same APIs**.

#### Flow Management
| API | Purpose |
|-----|---------|
| `FlowCollection` | List all workflows |
| `FlowInsert` | Create new workflow |
| `FlowUpdate` | Rename, modify workflow |
| `FlowDelete` | Remove workflow |
| `FlowDuplicate` | Copy existing workflow |
| `FlowRun` | Execute workflow |
| `FlowStop` | Stop running workflow |

#### Node Management
| API | Purpose |
|-----|---------|
| `NodeCollection` | List all nodes |
| `NodeInsert` | Create node (kind: HTTP, JS, CONDITION, FOR, FOR_EACH) |
| `NodeUpdate` | Move, rename, modify node |
| `NodeDelete` | Remove node |

#### Specialized Node Types
| API | Purpose |
|-----|---------|
| `NodeJsInsert` | Create JS node with code |
| `NodeJsUpdate` | Update JS node code |
| `NodeHttpInsert` | Link node to HTTP request |
| `NodeConditionInsert` | Create if/else branch |
| `NodeForInsert` | Create for-loop |
| `NodeForEachInsert` | Create forEach over array |

#### Edge (Connection) Management
| API | Purpose |
|-----|---------|
| `EdgeCollection` | List all edges |
| `EdgeInsert` | Connect two nodes (handles: THEN, ELSE, LOOP) |
| `EdgeUpdate` | Modify connection |
| `EdgeDelete` | Remove connection |

#### Variables
| API | Purpose |
|-----|---------|
| `FlowVariableCollection` | List flow variables |
| `FlowVariableInsert` | Add workflow variable |
| `FlowVariableUpdate` | Modify variable |
| `FlowVariableDelete` | Remove variable |

### Key Data Types

```typescript
// Node kinds
enum NodeKind {
  UNSPECIFIED = 0,
  MANUAL_START = 1,
  HTTP = 2,
  CONDITION = 3,
  FOR = 4,
  FOR_EACH = 5,
  JS = 6,
}

// Edge handle types (which output port)
enum HandleKind {
  UNSPECIFIED = 0,
  THEN = 1,      // success path
  ELSE = 2,      // failure path
  LOOP = 3,      // loop iteration
}

// Execution state
enum FlowItemState {
  UNSPECIFIED = 0,
  RUNNING = 1,
  SUCCESS = 2,
  FAILURE = 3,
  CANCELED = 4,
}
```

### Proto/Server Locations

- **Proto definitions**: `packages/spec/dist/protobuf/api/flow/v1/flow.proto`
- **TypeScript generated**: `packages/spec/dist/buf/typescript/api/flow/v1/flow_pb.ts`
- **Server implementations**: `packages/server/internal/api/rflowv2/`

---

## Tool Definitions

### Categories

#### 1. Exploration Tools (Read-Only)

Claude uses these to understand the current state.

| Tool | Purpose | Maps To |
|------|---------|---------|
| `getWorkflowGraph` | See full workflow structure | `FlowCollection` + `NodeCollection` + `EdgeCollection` |
| `getNodeDetails` | Inspect specific node config/code | `NodeCollection` filtered |
| `getNodeTemplate` | Read an MD template | File system / DB |
| `searchTemplates` | Find relevant templates | Search index |
| `getExecutionHistory` | See past workflow runs | Execution logs |
| `getExecutionLogs` | Detailed logs from a run | Execution logs |

#### 2. Mutation Tools (Changes State)

Claude uses these to build/modify workflows.

| Tool | Purpose | Maps To |
|------|---------|---------|
| `createJsNode` | Create a JavaScript node | `NodeInsert` + `NodeJsInsert` |
| `createHttpNode` | Create an HTTP request node | `NodeInsert` + `NodeHttpInsert` |
| `createConditionNode` | Create if/else branch | `NodeInsert` + `NodeConditionInsert` |
| `createForNode` | Create for-loop | `NodeInsert` + `NodeForInsert` |
| `createForEachNode` | Create forEach loop | `NodeInsert` + `NodeForEachInsert` |
| `updateNodeCode` | Modify JS node code | `NodeJsUpdate` |
| `updateNodeConfig` | Modify node properties | `NodeUpdate` |
| `connectNodes` | Create edge between nodes | `EdgeInsert` |
| `disconnectNodes` | Remove edge | `EdgeDelete` |
| `deleteNode` | Remove a node | `NodeDelete` |
| `createVariable` | Add workflow variable | `FlowVariableInsert` |
| `updateVariable` | Modify variable | `FlowVariableUpdate` |

#### 3. Execution Tools (Test/Run)

Claude uses these to verify the workflow works.

| Tool | Purpose | Maps To |
|------|---------|---------|
| `runWorkflow` | Execute the workflow | `FlowRun` |
| `stopWorkflow` | Stop running workflow | `FlowStop` |
| `validateWorkflow` | Check for errors, missing connections | Custom validation |

---

## Context Injection Strategy

### Hybrid Approach (Recommended)

**Inject lightweight summary at conversation start:**
```
Current workflow: "User Onboarding Flow"
Nodes: 6 (1 start, 3 HTTP, 1 JS, 1 condition)
Status: not running
Last run: 2 hours ago, success
```

**Claude calls tools for details:**
- `getWorkflowGraph()` - when it needs the full picture
- `getNodeDetails(nodeId)` - when working on a specific node
- After mutations, call `getWorkflowGraph()` again to see updated state

### Why This Works

1. **Lean system prompt** - fast, cheap, doesn't waste tokens
2. **Fresh data** - Claude always sees current state when it asks
3. **Claude controls depth** - quick tasks don't need full graph
4. **Mirrors Claude Code** - familiar mental model

---

## MD Templates

### Structure

```markdown
# [Template Name]

## Purpose
What this node pattern does.

## Available APIs
- `fetch(url, options)` - standard fetch
- `workflow.getVariable(name)` - access workflow variables
- `workflow.getSecret(name)` - access secrets (resolved at runtime)
- `node.log(message)` - emit logs visible in execution history

## Input Contract
What data this node expects from upstream.

## Output Contract
What data this node should return for downstream.

## Examples

### [Example Name]
```javascript
async function execute(input) {
  // implementation
}
```

## Constraints
- Timeout limits
- Rate limits
- Other restrictions
```

### Example: HTTP Aggregator Template

```markdown
# HTTP Aggregator Node

## Purpose
Combines multiple HTTP responses into a single output.

## Available APIs
- `fetch(url, options)` - standard fetch
- `workflow.getVariable(name)` - access workflow variables
- `node.log(message)` - emit logs

## Input Contract
Expects an array of URLs or request configs from upstream.

## Output Contract
Returns aggregated/transformed data for downstream.

## Examples

### Basic parallel fetch
```javascript
async function execute(input) {
  const responses = await Promise.all(
    input.urls.map(url => fetch(url).then(r => r.json()))
  );
  return { data: responses };
}
```

### With error handling
```javascript
async function execute(input) {
  const results = await Promise.allSettled(
    input.urls.map(url => fetch(url).then(r => r.json()))
  );
  return {
    successful: results.filter(r => r.status === 'fulfilled').map(r => r.value),
    failed: results.filter(r => r.status === 'rejected').map(r => r.reason.message)
  };
}
```

## Constraints
- Timeout: 30s max
- Max concurrent requests: 10
```

---

## User Experience

### Interaction Flow

1. User opens workflow in editor
2. Chat panel available (side panel or modal)
3. User types natural language: "Add a node that fetches user data from the API and transforms it"
4. Claude:
   - Calls `getWorkflowGraph()` if needed
   - Creates nodes via `createJsNode` / `createHttpNode`
   - Connects them via `connectNodes`
   - Explains what it did
5. User sees changes reflected in canvas (real-time via sync streams)
6. User can iterate: "Make it handle errors better"
7. Claude updates the node code
8. Continue until user is satisfied

### Permissions Model (Configurable)

- **Ask before mutations**: "I'm about to create 3 nodes, ok?" (default)
- **Auto-approve**: Just do it (sandbox mode)
- **Per-action trust**: User approves certain action types once

### Model Selection

User can switch between:
- **Claude Opus/Sonnet/Haiku**: Different capability/cost tradeoffs
- **GPT-4/GPT-4o**: Alternative provider
- **Other models**: Via Vercel AI SDK abstraction

Same tools, same prompts - just different "brain" processing.

---

## Implementation Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Service language | TypeScript | Best LLM SDK support, shared types with client |
| Architecture | Separate agent service | Single responsibility, iterate fast, scale independently |
| LLM SDK | Vercel AI SDK (primary) | Model agnostic, streaming, tool calling abstracted |
| Context injection | Hybrid (light summary + tools) | Lean prompts, fresh data, mirrors Claude Code |
| Permissions | Configurable | Flexibility for different user preferences |
| MD templates | User-creatable + registry | Extensibility, community contributions |
| Conversation state | Per-workflow, persisted | Resume across sessions/devices |

---

## Next Steps

### Phase 1: Validate Design (No Code)

1. **Write complete tool definitions** (JSON Schema)
2. **Write system prompt**
3. **Test in Anthropic Console**:
   - Paste system prompt
   - Add tool definitions
   - Have conversations as a user would
   - Manually execute tool calls against real backend
   - Feed results back
4. **Iterate on design** until the flow feels right

### Phase 2: Build Agent Service

1. Set up TypeScript project with Vercel AI SDK
2. Implement tool handlers (map to gRPC calls)
3. Implement conversation state management
4. Add streaming support

### Phase 3: Integrate with Client

1. Add chat panel UI to workflow editor
2. Connect to agent service via WebSocket/HTTP streaming
3. Handle real-time workflow updates (already have sync streams)

### Phase 4: Polish

1. Add MD template system (storage, retrieval, search)
2. Add permissions UI
3. Add model selection
4. Community template registry

---

## Open Questions

1. **Execution feedback loop**: Should workflow execution errors automatically feed back into the conversation for self-correction? (Deferred - keep it simple first)

2. **Isolated VM execution**: Security sandboxing for generated JS code (Deferred - not priority now)

3. **Versioning**: How do generated node code changes interact with workflow history?

---

## File References

### Existing Code

- Proto definitions: `packages/spec/dist/protobuf/api/flow/v1/flow.proto`
- TypeScript types: `packages/spec/dist/buf/typescript/api/flow/v1/flow_pb.ts`
- Server flow APIs: `packages/server/internal/api/rflowv2/`
- Client flow editor: `packages/client/src/features/flow/`
- HAR import (reference): `packages/server/pkg/translate/harv2/`

### New Code (To Be Created)

- Agent service: `packages/agent/` (proposed)
- MD templates: `packages/agent/templates/` or database
- Tool definitions: `packages/agent/src/tools/`

---

*Document created: January 2025*
*Last updated: January 2025*
