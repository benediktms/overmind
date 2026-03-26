---
name: delegate
description: Delegation skill for Overmind orchestration. Use when work should be handed off to scout, relay, or swarm instead of being done directly.
triggers:
  - delegate to overmind
  - hand off work
  - orchestrate task
  - overmind delegate
  - multi-file implementation
---

# Delegate

## When to delegate (vs direct work)

Delegate when the objective is too broad, too coupled, or too risky for a single direct pass.
Use Overmind when the task spans multiple files, needs parallel investigation, or needs a verify/fix loop.

Work directly when the change is trivial, local, and obvious: a one-line fix, a small clarification, or a single command.
If you can finish confidently without coordination overhead, do not delegate.

## How to delegate (MCP tool usage)

Use the Overmind MCP tool to hand off the objective:

```text
mcp__overmind__overmind_delegate(objective: string, mode?: "scout"|"relay"|"swarm", priority?: 0-4)
```

State the outcome you want, not just the file names.
Include the success criteria, any known constraints, and the priority so the orchestration layer can schedule appropriately.

If you need status or need to stop the work, use the companion MCP endpoints:
- `mcp__overmind__overmind_status`
- `mcp__overmind__overmind_cancel`

## Mode selection guide

- Unknown territory → Scout
- Clear requirements → Relay
- Large scope, independent subtasks → Swarm

Scout gathers context first, so use it when the shape of the work is still uncertain.
Relay is best when the solution path is known and should move through ordered plan/execute/verify steps.
Swarm is best when the work can be split cleanly and verified after parallel execution.

## Priority scale

- 0 — critical
- 1 — high
- 2 — medium
- 3 — low
- 4 — backlog

Use the smallest priority that still reflects urgency.
Reserve 0 for work that should interrupt everything else.

## Examples

- "Delegate to Overmind to update the API, client, and tests in parallel" → Swarm, priority 1.
- "Hand off work to investigate why this import chain fails" → Scout, priority 2.
- "Orchestrate task: implement the approved fix and verify it step by step" → Relay, priority 1.

Good delegation is specific, bounded, and testable.
If the objective cannot be described clearly enough to verify, gather more context first.
