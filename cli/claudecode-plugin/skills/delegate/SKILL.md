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
Call `mcp__overmind__overmind_delegate` with the objective, mode, and a
`dispatcher_mode` declaring how this caller will fulfill agent dispatches:

```
mcp__overmind__overmind_delegate(
  objective: string,
  mode?: "scout"|"relay"|"swarm",
  priority?: 0-4,
  dispatcher_mode?: "subprocess"|"client_side"
)
```

**You are running inside Claude Code, so always pass
`dispatcher_mode: "client_side"`** — and run the Phase-1 drain-and-spawn
protocol below. Without that, the daemon either queues dispatches that
nobody pulls (silent timeout) or returns an actionable error. State the
outcome you want, not just the file names. Include success criteria,
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

Claude Code sessions invoke `overmind_delegate` with
`dispatcher_mode: "client_side"`, which tells the daemon to queue agent
dispatches in-process. The calling session is then responsible for
draining the queue and spawning teammates via its own `Agent` tool. This
gives ~0s bootstrap (no subprocess fork, no MCP re-handshake) and keeps
permissions/env scoped to the caller. The legacy
`OVERMIND_CLIENT_DISPATCHER=1` env var still works as a per-process
override but is no longer the recommended path — declare capability per
request instead.

### Coordination modes

Two distinct channels carry messages in an Overmind run; which one matters
depends on the dispatcher mode:

| Mode | Agent ↔ agent | Agent ↔ kernel |
|---|---|---|
| `client_side` (Claude Code teams) | Team mailbox (`SendMessage`) — fast, in-process | neural_link (kernel listens here for handoffs) |
| `subprocess` (CLI/CI/OpenCode/headless) | neural_link only | neural_link |

In team mode, prefer the team mailbox for ad-hoc lead↔teammate steering.
The kernel still observes neural_link for state-machine signals
(handoffs, review_results), so anything that needs to advance the run's
state must go through neural_link too.

### Protocol sequence — drain LOOP, not one-shot

The lead enters a coordination loop after delegating. **Re-drain whenever
the run advances** — the kernel queues new dispatches at every step
transition (verify, fix, next-step), and skipping a re-drain is the most
common way to wedge a relay/swarm/scout run with no diagnostic.

1. **Delegate the objective** — call `mcp__overmind__overmind_delegate` with
   your objective, mode (scout/relay/swarm), and
   `dispatcher_mode: "client_side"`. It returns `{run_id, mode}`. If the
   daemon doesn't have a client_side dispatcher available, you'll get
   `success: false` with an actionable error instead of a silent hang.

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

4. **Wait for teammates to settle** — teammates report completion via the
   team mailbox (idle notifications + their handoff text appears in your
   conversation). The kernel observes their neural_link `handoff` messages
   and queues the next step's dispatches.

5. **RE-DRAIN** — call `overmind_pending_dispatches({run_id})` again. If
   the array is non-empty, the run has advanced (verify step, next plan
   step, fix iteration, next swarm wave). Go back to step 3 and spawn
   the new teammates. **Do not assume drain is one-shot.** A typical
   relay run drains 3+ times (initial step, verifier, optional fix,
   next step…); a swarm drains once per wave plus verify; a scout drains
   once for the angle fan-out plus optionally a synthesis pass.

6. **Exit** — when a re-drain returns an empty array AND the kernel has
   closed the room (you'll see the run no longer appears active), the
   run is complete. Synthesize results from the teammates' handoff
   summaries.

If the FIRST drain returns empty, the run was routed through subprocess
mode (ClaudeCodeDispatcher) — either you passed
`dispatcher_mode: "subprocess"` or omitted `dispatcher_mode` entirely and
the daemon defaulted. No caller action needed in that case; the daemon
spawns workers itself.

### Lead steering responsibility

You are the **only entity with full context** — the original objective,
the user's intent, the prior steps' artifacts. The kernel is a state
machine: it advances on handoffs and review_results but cannot judge
"agent went off-task" vs "agent solved it differently than expected."
That judgment is yours. Do not treat the kernel as authoritative; treat
it as your dispatcher.

**When to intervene:**

- **Teammate goes silent / aborts** — idles without producing a handoff,
  or its turn ends with an error. Read the lead's neural_link inbox via
  `mcp__neural_link__inbox_read({room_id, participant_id: "overmind-<mode>-lead"})`
  to see what they posted before stopping. Either redirect with a
  `decision`/`proposal` message and re-spawn, or `overmind_cancel` and
  re-delegate with a sharper brief.
- **Teammate deviates from the brief** — they're solving the wrong
  problem, or the right problem the wrong way. Don't wait for the verify
  step to fail; that wastes a fix iteration. Send a correction now via
  `SendMessage(to=teammate_name, …)` (team mode) or `message_send`
  (subprocess mode).
- **Teammate reports a `blocker`** (kind in inbox or via SendMessage) —
  the kernel won't unblock for you. Resolve with a `decision` message,
  or escalate to the user.

**Channels by mode:**

- `client_side`: lead → teammate via `SendMessage(to=teammate_name, …)`;
  teammate → lead via team mailbox (auto-delivered to your turn).
  Reserve neural_link for messages the kernel needs to observe.
- `subprocess`: everything via neural_link `message_send` /
  `inbox_read` — the team mailbox doesn't reach spawned subprocesses.

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
  priority=1,
  dispatcher_mode="client_side"
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
