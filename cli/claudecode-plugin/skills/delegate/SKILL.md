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

<phase_1_protocol>

## Phase 1 — Client-side dispatch protocol

When `OVERMIND_CLIENT_DISPATCHER=1` is set, the daemon uses an in-process queue
instead of spawning subprocesses. The calling Claude Code session is responsible
for draining and spawning teammates.

### Protocol sequence

1. **Delegate the objective** — call `mcp__overmind__overmind_delegate` with
   your objective and mode (scout/relay/swarm). It returns `{run_id, mode}`.

2. **Drain pending dispatches** — immediately call
   `mcp__overmind__overmind_pending_dispatches({run_id})`. Returns
   `{run_id, dispatches}` where `dispatches` is an array of pending agent
   requests.

3. **Spawn teammates** — for each dispatch in the array, spawn a teammate via
   the `Agent` tool. Each dispatch has:
   - `role`: the agent type (e.g., "probe", "drone", "archivist")
   - `participant_id`: unique identifier for neural_link coordination
   - `prompt`: the bootstrap prompt containing room_id and coordination protocol
   - `room_id`: the shared coordination room for this run
   - `workspace`: the working directory

   Spawn with:
   ```
   Agent(
     subagent_type: "overmind:<role>",         # e.g. "overmind:probe"
     team_name: <run_id>,                      # all teammates of one run share a team
     name: <participant_id>,                   # matches neural_link identity
     prompt: <prompt>                          # contains room_id + coordination details
   )
   ```

4. **Wait for handoffs** — the kernel's executor watches the room for teammate
   handoff messages and synthesizes results automatically. No further action
   needed in Phase 1.

5. **Exit** — once all teammates have sent handoffs and left the room, the
   kernel closes the room and returns synthesis.

If `dispatches` is empty, the daemon is using subprocess mode
(ClaudeCodeDispatcher) — no caller action needed.

### Role → subagent_type mapping

Map dispatch.role to the overmind agent. Numeric suffixes (e.g., "probe-2")
preserve the suffix on the teammate name.

| Role           | Subagent Type           |
| -------------- | ----------------------- |
| probe          | overmind:probe          |
| archivist      | overmind:archivist      |
| cortex         | overmind:cortex         |
| drone          | overmind:drone          |
| weaver         | overmind:weaver         |
| guardian       | overmind:guardian       |
| scribe         | overmind:scribe         |
| evolver        | overmind:evolver        |
| liaison        | overmind:liaison        |
| verifier       | overmind:verifier       |
| planner        | overmind:planner        |
| architect      | overmind:architect      |
| debugger       | overmind:debugger       |
| code-reviewer  | overmind:code-reviewer  |
| sentinel       | overmind:sentinel       |
| style-reviewer | overmind:style-reviewer |
| gauge          | overmind:gauge          |

### Worked example

Delegate a scout investigation and spawn the resulting dispatches:

```
// 1. Delegate
result = mcp__overmind__overmind_delegate(
  "Investigate why the database migration fails in test",
  mode="scout",
  priority=1
)
// result: {run_id: "run-abc123...", mode: "scout"}

// 2. Drain
dispatches_result = mcp__overmind__overmind_pending_dispatches({run_id: "run-abc123..."})
// dispatches_result: {run_id: "run-abc123...", dispatches: [
//   {role: "probe", participant_id: "p1", room_id: "room_xyz", prompt: "You are an Overmind worker...", workspace: "/path"},
//   {role: "probe", participant_id: "p2", room_id: "room_xyz", prompt: "You are an Overmind worker...", workspace: "/path"},
//   {role: "archivist", participant_id: "a1", room_id: "room_xyz", prompt: "You are an Overmind worker...", workspace: "/path"}
// ]}

// 3. Spawn teammates
for (dispatch of dispatches_result.dispatches) {
  Agent(
    subagent_type: f"overmind:{dispatch.role}",
    team_name: dispatches_result.run_id,
    name: dispatch.participant_id,
    prompt: dispatch.prompt
  )
}
// Spawns 3 teammates: two probes and one archivist, all in the same team.
// Each joins the coordination room and begins the bootstrap protocol.

// 4. Wait — kernel synthesizes automatically
// 5. Results returned
```

</phase_1_protocol>
