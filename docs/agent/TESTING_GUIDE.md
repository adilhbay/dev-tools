# Phase 1 Testing Guide

This guide explains how to validate the Workflow Agent design using the Anthropic Console before writing any implementation code.

## Overview

The goal of Phase 1 is to **validate the design** by simulating conversations with the agent. You'll:
1. Load the system prompt and tools into the Anthropic Console
2. Have conversations as a user would
3. Manually execute tool calls against the real backend
4. Feed results back to the model
5. Iterate on the design until the flow feels natural

## Prerequisites

- Access to [Anthropic Console](https://console.anthropic.com/)
- A running instance of the dev-tools backend (for executing tool calls)
- A test workspace with sample workflows

## Setup

### 1. Open the Anthropic Console

Go to [console.anthropic.com](https://console.anthropic.com/) and navigate to the **Workbench**.

### 2. Configure the System Prompt

Copy the contents of `system-prompt.md` into the **System** field.

### 3. Add Tool Definitions

1. Click **Add tools** in the Workbench
2. Copy each tool from `tools.json` and add them
3. Alternatively, use the API directly with the full tools array

### 4. Add Context Injection

Before starting a conversation, inject workflow context. Add this as the first message (simulating what the agent service would inject):

```
Current workflow: "Test Workflow"
Flow ID: abc123-def456-...
Nodes: 3 (1 start, 1 HTTP, 1 JS)
Edges: 2
Variables: 2 (API_KEY, BASE_URL)
Status: not running
Last run: never
```

## Testing Scenarios

### Scenario 1: Create a Simple Workflow

**Goal**: Test node creation and connection flow.

**User prompt**:
> "Create a workflow that fetches data from https://api.example.com/users and logs the count"

**Expected behavior**:
1. Agent calls `getWorkflowGraph()` to understand current state
2. Agent explains the approach
3. Agent calls `createJsNode()` for fetch
4. Agent calls `createJsNode()` for logging
5. Agent calls `connectNodes()` to link them
6. Agent offers to test

**Manual execution**:
When the agent calls a tool, you need to manually execute it and return the result:

```json
// Tool call: getWorkflowGraph
// Execute in your backend, return:
{
  "flowId": "abc123",
  "name": "Test Workflow",
  "nodes": [
    {
      "nodeId": "node-1",
      "name": "Start",
      "kind": "MANUAL_START",
      "position": { "x": 100, "y": 100 }
    }
  ],
  "edges": [],
  "variables": []
}
```

### Scenario 2: Debug a Failed Workflow

**Goal**: Test debugging and iteration flow.

**User prompt**:
> "The workflow failed. Can you help?"

**Expected behavior**:
1. Agent calls `getExecutionHistory()` to see recent runs
2. Agent calls `getExecutionLogs()` to get details
3. Agent identifies the problem
4. Agent proposes a fix
5. Agent calls appropriate update tool
6. Agent offers to re-run

**Mock failed execution**:
```json
// Tool call: getExecutionLogs
// Return:
{
  "executionId": "exec-123",
  "nodeExecutions": [
    {
      "nodeId": "node-1",
      "name": "Fetch Users",
      "state": "SUCCESS",
      "output": { "data": { "users": [...] } }
    },
    {
      "nodeId": "node-2",
      "name": "Transform Data",
      "state": "FAILURE",
      "error": "Cannot read property 'items' of undefined",
      "input": { "data": { "users": [...] } }
    }
  ]
}
```

### Scenario 3: Add Conditional Logic

**Goal**: Test condition node creation and multi-path flows.

**User prompt**:
> "Add error handling - if the API returns an error, log it; otherwise process the data"

**Expected behavior**:
1. Agent understands the requirement for branching
2. Agent calls `createConditionNode()` with appropriate condition
3. Agent creates two paths (success/error handlers)
4. Agent connects using THEN/ELSE handles

### Scenario 4: Create a Loop

**Goal**: Test loop node creation for batch operations.

**User prompt**:
> "Iterate over all users and send each one a welcome email"

**Expected behavior**:
1. Agent calls `createForEachNode()` with iterator path
2. Agent creates the email-sending node inside the loop
3. Agent connects using LOOP handle
4. Agent discusses error handling options

### Scenario 5: Use a Template

**Goal**: Test template discovery and usage.

**User prompt**:
> "I need to fetch data from multiple APIs at once"

**Expected behavior**:
1. Agent calls `searchTemplates()` to find relevant patterns
2. Agent calls `getNodeTemplate()` for "http-aggregator"
3. Agent uses the template guidance to create the node
4. Agent explains the pattern used

## Evaluation Criteria

### Does It Feel Natural?

- [ ] Does the agent ask good clarifying questions?
- [ ] Does it explain its approach before acting?
- [ ] Does it build incrementally rather than all at once?
- [ ] Does it offer to test after making changes?

### Is It Effective?

- [ ] Does it call the right tools in the right order?
- [ ] Does it understand the workflow structure?
- [ ] Does it write correct JS code?
- [ ] Does it handle errors gracefully?

### Is It Helpful?

- [ ] Does it explain what each node does?
- [ ] Does it help the user learn?
- [ ] Does it catch potential issues?
- [ ] Does it suggest improvements?

## Iteration Process

After each test session:

1. **Document friction points**: Where did the conversation feel awkward?
2. **Identify missing tools**: Did you wish for a tool that doesn't exist?
3. **Review tool responses**: Are the return schemas useful?
4. **Update system prompt**: Refine instructions based on observations
5. **Add examples**: Include good interaction patterns in the prompt

## Tool Response Mocking

Here are example responses for each tool to use during testing:

### getWorkflowGraph Response

```json
{
  "flowId": "flow-123",
  "name": "User Onboarding",
  "nodes": [
    {
      "nodeId": "node-1",
      "name": "Start",
      "kind": "MANUAL_START",
      "position": { "x": 100, "y": 200 },
      "state": "UNSPECIFIED"
    },
    {
      "nodeId": "node-2",
      "name": "Fetch User",
      "kind": "HTTP",
      "position": { "x": 300, "y": 200 },
      "state": "UNSPECIFIED"
    }
  ],
  "edges": [
    {
      "edgeId": "edge-1",
      "sourceId": "node-1",
      "targetId": "node-2",
      "sourceHandle": "THEN"
    }
  ],
  "variables": [
    {
      "variableId": "var-1",
      "name": "API_KEY",
      "value": "***",
      "enabled": true
    }
  ]
}
```

### createJsNode Response

```json
{
  "success": true,
  "nodeId": "node-new-123",
  "message": "JS node 'Transform Data' created successfully"
}
```

### runWorkflow Response

```json
{
  "success": true,
  "executionId": "exec-456",
  "message": "Workflow execution started"
}
```

### getExecutionLogs Response

```json
{
  "executionId": "exec-456",
  "flowId": "flow-123",
  "status": "SUCCESS",
  "startedAt": "2025-01-13T10:00:00Z",
  "completedAt": "2025-01-13T10:00:02Z",
  "duration": 2000,
  "nodeExecutions": [
    {
      "nodeId": "node-1",
      "name": "Start",
      "state": "SUCCESS",
      "startedAt": "2025-01-13T10:00:00Z",
      "completedAt": "2025-01-13T10:00:00Z"
    },
    {
      "nodeId": "node-2",
      "name": "Fetch User",
      "state": "SUCCESS",
      "input": {},
      "output": { "user": { "id": 1, "name": "John" } },
      "startedAt": "2025-01-13T10:00:00Z",
      "completedAt": "2025-01-13T10:00:02Z"
    }
  ]
}
```

## Tracking Changes

Keep a changelog of design iterations:

| Date | Change | Reason |
|------|--------|--------|
| 2025-01-13 | Initial tool definitions | Phase 1 kickoff |
| | | |

## Next Steps

Once you've validated the design through manual testing:

1. Document any changes needed to tools or system prompt
2. Finalize the tool schemas
3. Proceed to Phase 2: Build Agent Service

## Files Reference

- `tools.json` - Complete tool definitions
- `system-prompt.md` - System prompt for the agent
- `templates/` - Example MD templates
- `WORKFLOW_AGENT_SPEC.md` - Full specification document
