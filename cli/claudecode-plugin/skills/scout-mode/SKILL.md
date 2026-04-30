---
name: scout-mode
description: Parallel context-gathering mode for Overmind. Dispatches Probe agents to investigate multiple angles simultaneously, synthesizes findings into brain memory, and delivers a consolidated analysis artifact. Use when the objective is broad, ambiguous, or touches multiple subsystems before any implementation begins. Trigger phrases: "scout mode", "investigate codebase", "map dependencies", "understand architecture", "gather context".
triggers:
  - context gathering
  - investigate codebase
  - map dependencies
  - understand architecture
  - scout mode instructions
---

<when_to_use> Use scout mode when:

- The objective is broad, ambiguous, or spans multiple subsystems.
- Dependencies must be mapped before changing code.
- Architecture understanding across files, services, or boundaries is needed.
- A consolidated analysis artifact is required before execution.

Do not use when: the implementation path is already known, the task is a trivial
single-file edit, or immediate execution is preferred over discovery.
</when_to_use>

<protocol>
Invoke via `mcp__overmind__overmind_delegate` with `mode: "scout"` and
`dispatcher_mode: "client_side"` (you are running inside Claude Code and
will drain the dispatch queue yourself — see Phase-1 protocol below):

```
mcp__overmind__overmind_delegate(
  objective: string,
  mode: "scout",
  priority?: 0-4,
  dispatcher_mode: "client_side"
)
```

The kernel:

1. Creates a brain task with title prefix `[overmind:scout]`.
2. Opens a neural_link room (interaction mode: `informative`).
3. Derives 3 default investigation angles from the objective (or N angles from a
   planner TaskGraph).
4. Dispatches one Probe agent per angle via `mcp__neural_link__message_send` +
   `AgentDispatcher`.
5. Collects `handoff` messages from each Probe (180 s timeout per agent).
6. Synthesizes findings into a brain memory episode.
7. Closes the room and marks the task complete.

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
   with `mode: "scout"` and `dispatcher_mode: "client_side"`. Returns
   `{run_id, mode}` on success or `{success: false, error}` if the daemon
   has no client_side dispatcher available.

2. **Drain pending dispatches** — immediately call
   `mcp__overmind__overmind_pending_dispatches({run_id})`. Returns
   `{run_id, dispatches}` — one entry per investigation angle (typically
   3 Probes by default).

3. **Spawn teammates** — for each dispatch, spawn a teammate via the
   `Agent` tool, in parallel:
   ```
   Agent(
     subagent_type: "overmind:<role>",   # typically "overmind:probe"
     team_name: <run_id>,
     name: <participant_id>,
     prompt: <dispatch.prompt>
   )
   ```

4. **Wait for handoffs** — when all Probes have posted findings and left
   the room, the scout executor synthesizes the brain memory episode and
   closes the room.

5. **Exit** — the run completes when the room closes; the synthesis is
   available via the brain memory episode.

See the `delegate` skill for the role → subagent_type mapping table.
</phase_1_protocol>

<examples>
**New feature in unfamiliar module** — angles: domain model, API surface, persistence, tests, runtime wiring. Lead output: readiness summary with implementation risks and suggested order.

**Architecture investigation before refactor** — angles: coupling graph,
dependency hotspots, side effects, performance-sensitive paths. Lead output:
refactor safety constraints and staged rollout proposal.

**Incident follow-up** — angles: failure path, observability gaps, retry/circuit
logic, data integrity. Lead output: root-cause context package for fix planning.
</examples>

<constraints>
- Each Probe covers one non-overlapping angle.
- Every finding must cite concrete evidence (file path, command output, or API reference).
- Transition to relay or swarm only when the core architecture map is stable and major unknowns are bounded.
- Escalate to the user when two Probe findings conflict and cannot be reconciled from available evidence, or when security/data-loss risk is discovered during scouting.
</constraints>
