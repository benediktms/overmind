---
name: swarm-mode
description: Parallel execution mode for Overmind with wave-based dispatch and coordinated verify/fix loops. Decomposes an objective into independent subtasks, runs them in dependency-ordered waves, then enforces integration verification after each wave. Use when work can be split into independent lanes that must converge through repeated integration checks. Trigger phrases: "swarm mode", "parallel implementation", "multi-agent work", "verify fix loop", "concurrent agents".
triggers:
  - parallel implementation
  - multi-agent work
  - verify fix loop
  - concurrent agents
  - swarm mode instructions
---

<when_to_use> Use swarm mode when:

- The objective decomposes into independent subtasks with minimal overlap.
- Throughput matters and sequential relay-style execution is too slow.
- Integration quality requires explicit verify/fix loops after parallel work.
- Multiple subsystems can progress concurrently but must converge safely.

Do not use when: tasks are strongly coupled and cannot be meaningfully
parallelized, verification criteria are undefined, coordination overhead would
exceed throughput gains, or the objective is primarily exploratory (use scout
first). </when_to_use>

<protocol>
Invoke via `mcp__overmind__overmind_delegate` with `mode: "swarm"`:

```
mcp__overmind__overmind_delegate(objective: string, mode: "swarm", priority?: 0-4)
```

The kernel:

1. Creates a brain task with title prefix `[overmind:swarm]`.
2. Opens a neural_link room (interaction mode: `informative`).
3. Decomposes the objective into SwarmTasks with dependency edges (or uses a
   planner TaskGraph).
4. Computes dependency-ordered waves; dispatches all tasks in each wave in
   parallel.
5. Collects `handoff` messages from each agent (30 s timeout per agent).
6. After all waves: runs a verification pass (agent-based via `verifier`, or a
   pipeline of LSP/bash strategies).
7. If verification passes: records a brain memory episode, closes the room,
   marks the task complete.
8. If verification fails with outcome `failed`: enters a fix loop — dispatches
   only the failed-task agents, re-verifies. Repeats until pass or
   `max_iterations` reached.
9. If outcome is `stuck` or `timeout`: marks the run `failed` immediately.

Cancellation: signal via `mcp__overmind__overmind_cancel`; the kernel closes the
room and marks the run `cancelled`.
</protocol>

<examples>
**Feature spanning API, domain logic, and tests:**
- Wave 1 (parallel): API contract updates, domain implementation, test scaffolding.
- Verification: integration tests + diagnostics across changed modules.
- Fix loop: targeted patch wave for failing integration points.

**Broad bugfix with multiple suspected failure surfaces:**

- Wave 1 (parallel): reproduction hardening, root-cause patch, observability
  updates.
- Verification: failing case resolved, no regression in related test suites.
- Fix loop: assign agents to residual failures by component ownership.

**Cross-cutting refactor with safety gates:**

- Wave 1 (parallel): call-site updates, type/schema adjustments, migration-safe
  tests.
- Verification: build, typecheck, diagnostics, and compatibility checks.
- Fix loop: iterative correction on conflicts and integration drift.
  </examples>

<constraints>
- Keep subtask boundaries explicit to prevent duplicate edits across agents.
- Every agent handoff must include concrete artifacts (file paths, diagnostics, test outputs).
- Track wave number and verification result so progress is observable across iterations.
- Verification gates the integrated system, not isolated subtask success.
- Escalate when subtasks cannot be kept independent and repeated overlap causes churn, or when verification fails repeatedly without narrowing root cause.
</constraints>
