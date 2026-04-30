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
Invoke via `mcp__overmind__overmind_delegate` with `mode: "swarm"` and
`dispatcher_mode: "client_side"` (you are running inside Claude Code and
will drain the dispatch queue yourself — see Phase-1 protocol below):

```
mcp__overmind__overmind_delegate(
  objective: string,
  mode: "swarm",
  priority?: 0-4,
  dispatcher_mode: "client_side"
)
```

The kernel:

1. Creates a brain task with title prefix `[overmind:swarm]`.
2. Opens a neural_link room (interaction mode: `informative`).
3. Decomposes the objective into SwarmTasks with dependency edges (or uses a
   planner TaskGraph).
4. Computes dependency-ordered waves; dispatches all tasks in each wave in
   parallel.
5. Collects `handoff` messages from each agent (180 s timeout per agent).
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

<phase_1_protocol>

## Phase 1 — Client-side dispatch protocol

Claude Code sessions pass `dispatcher_mode: "client_side"`, which tells the
daemon to queue agent dispatches for in-process spawn rather than forking
`claude --print` subprocesses. The calling session must drain the queue
and spawn each agent as a teammate. Skip this protocol and the run
silently times out at 180s with zero handoffs.

### Protocol sequence

1. **Delegate the objective** — call `mcp__overmind__overmind_delegate`
   with `mode: "swarm"` and `dispatcher_mode: "client_side"`. Returns
   `{run_id, mode}` on success or `{success: false, error}` if the daemon
   has no client_side dispatcher available.

2. **Drain pending dispatches** — immediately call
   `mcp__overmind__overmind_pending_dispatches({run_id})`. Returns
   `{run_id, dispatches}` — the queued spawn requests for the swarm's
   first wave.

3. **Spawn teammates** — for each dispatch in the wave, spawn a teammate
   via the `Agent` tool, in parallel:
   ```
   Agent(
     subagent_type: "overmind:<role>",   # e.g. "overmind:drone"
     team_name: <run_id>,
     name: <participant_id>,
     prompt: <dispatch.prompt>
   )
   ```

4. **Wait for wave handoffs** — teammates settle via the team mailbox;
   the kernel observes neural_link handoffs and queues the next wave's
   dispatches (or moves to verify, then fix on failure).

5. **RE-DRAIN** — `overmind_pending_dispatches({run_id})` again. **A swarm
   run drains once per wave plus once for verification** (and again per
   fix iteration). For a 3-wave swarm with one fix cycle, expect ~5
   drains. Skipping re-drains wedges the run: the kernel queues
   verifier/fix dispatches you never spawn, exhausts max_iterations,
   ends in failure with no diagnostic.

6. **Exit** — empty re-drain + closed room = done. Synthesize from the
   wave handoff summaries.

### Lead steering

The kernel is a state machine; **you have full context** (the objective,
each wave's outputs). If a teammate aborts, deviates, or reports a
blocker, intervene via `SendMessage(to=teammate_name, …)` (team mode)
or `mcp__neural_link__message_send` (subprocess mode). For swarms,
deviations within a wave compound: catch them before the wave's verify
gate to avoid having to re-dispatch the entire wave. See the `delegate`
skill for the full lead-steering protocol and the role → subagent_type
mapping table.
</phase_1_protocol>

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
- Escalate when subtasks cannot be kept independent and repeated overlap causes churn, when verification fails repeatedly without narrowing root cause, or when security, compliance, or data-integrity risk is discovered during a wave.
</constraints>
