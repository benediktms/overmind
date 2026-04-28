---
name: delegate
description: Hands off an objective to the Overmind kernel for coordinated execution in scout, relay, or swarm mode. Use when the task spans multiple files, needs parallel investigation, or needs a verify/fix loop — and direct single-pass work would be insufficient.
triggers:
  - delegate to overmind
  - hand off work
  - orchestrate task
  - overmind delegate
  - multi-file implementation
---

<when_to_use> Delegate when the objective is too broad, too coupled, or too
risky for a single direct pass. Signals: spans multiple files, needs parallel
investigation, or needs a verify/fix loop.

Work directly when the change is trivial, local, and obvious: a one-line fix, a
small clarification, or a single command. If you can finish confidently without
coordination overhead, do not delegate. </when_to_use>

<protocol>
Call `mcp__overmind__overmind_delegate` with the objective and mode:

```
mcp__overmind__overmind_delegate(objective: string, mode?: "scout"|"relay"|"swarm", priority?: 0-4)
```

State the outcome you want, not just the file names. Include success criteria,
known constraints, and priority.

Mode selection:

- **scout** — unknown territory; shape of the work is still unclear.
- **relay** — clear requirements; solution path is known and should move through
  ordered plan/execute/verify steps.
- **swarm** — large scope with independent subtasks; work can be split and
  verified after parallel execution.

Companion endpoints:

- `mcp__overmind__overmind_status` — inspect current orchestration state.
- `mcp__overmind__overmind_cancel(objective_id)` — stop an active run.
  </protocol>

<examples>
- "Update the API, client, and tests in parallel" → swarm, priority 1.
- "Investigate why this import chain fails" → scout, priority 2.
- "Implement the approved fix and verify it step by step" → relay, priority 1.
</examples>

<constraints>
Priority scale: 0 critical, 1 high, 2 medium, 3 low, 4 backlog. Reserve 0 for work that should interrupt everything else.

Good delegation is specific, bounded, and testable. If the objective cannot be
described clearly enough to verify, gather more context with scout first.
</constraints>
