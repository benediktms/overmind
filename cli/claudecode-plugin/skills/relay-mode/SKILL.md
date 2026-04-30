---
name: relay-mode
description: Sequential pipeline execution mode for Overmind. Runs work through ordered Plan → Execute → Verify → Fix gates; each step must pass verification before the next begins. Use when requirements are clear, step order matters, and a failed intermediate step would invalidate downstream work. Trigger phrases: "relay mode", "sequential execution", "pipeline mode", "step then verify", "verification gates".
triggers:
  - sequential execution
  - pipeline mode
  - verification gates
  - step then verify
  - relay mode instructions
---

<when_to_use> Use relay mode when:

- The objective is clear and benefits from ordered, dependent execution.
- A failed intermediate step would invalidate downstream work.
- Strict acceptance criteria are needed after each execution unit.
- A deterministic, traceable pipeline is preferred over parallel throughput.

Do not use when: the primary need is wide discovery across unknown systems (use
scout first), steps are independent and can run in parallel (use swarm), or
acceptance criteria are not yet defined. </when_to_use>

<protocol>
Invoke via `mcp__overmind__overmind_delegate` with `mode: "relay"` and
`dispatcher_mode: "client_side"` (you are running inside Claude Code and
will drain the dispatch queue yourself — see Phase-1 protocol below):

```
mcp__overmind__overmind_delegate(
  objective: string,
  mode: "relay",
  priority?: 0-4,
  dispatcher_mode: "client_side"
)
```

The kernel executes a three-step default pipeline (cortex → probe → liaison) or
a planner-supplied TaskGraph in topological order. For each step:

1. Dispatches the step agent via neural_link `finding` message +
   `AgentDispatcher`.
2. Waits for a `handoff` message (180 s timeout per agent).
3. Dispatches a `verifier` agent via `review_request` message.
4. Waits for a `review_result` message.
5. If verification passes, proceeds to the next step.
6. If verification fails with outcome `failed`: enters a fix loop — dispatches
   the step agent again, re-verifies. Exits the fix loop only on pass or when
   `max_iterations` is reached.
7. If outcome is `stuck` or `timeout`: marks the run `failed` immediately
   (retrying won't help).

Room interaction mode: `supervisory`. Brain task title prefix:
`[overmind:relay]`.

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
   with `mode: "relay"` and `dispatcher_mode: "client_side"`. Returns
   `{run_id, mode}` on success or `{success: false, error}` if the daemon
   has no client_side dispatcher available.

2. **Drain pending dispatches** — immediately call
   `mcp__overmind__overmind_pending_dispatches({run_id})`. Returns
   `{run_id, dispatches}` — the queued spawn requests for the relay's
   first step.

3. **Spawn teammates** — for each dispatch, spawn a teammate via the
   `Agent` tool:
   ```
   Agent(
     subagent_type: "overmind:<role>",   # e.g. "overmind:cortex"
     team_name: <run_id>,
     name: <participant_id>,
     prompt: <dispatch.prompt>
   )
   ```

4. **Wait for teammates to settle** — teammates report completion via
   the team mailbox; the kernel observes neural_link handoffs and queues
   the next step's dispatches (verifier first, then either next-step
   cortex/probe/liaison or a fix-iteration cortex).

5. **RE-DRAIN** — `overmind_pending_dispatches({run_id})` again. **A relay
   run drains 4+ times for a clean 3-step pipeline** (step 1 cortex →
   verifier → step 2 probe → verifier → step 3 liaison → verifier), more
   on fix loops. Skipping a re-drain wedges the run: the kernel queues
   verifier/fix dispatches you never spawn, exhausts max_iterations, and
   ends in failure with no diagnostic.

6. **Exit** — empty re-drain + closed room = done. Synthesize from the
   step handoff summaries.

### Lead steering

The kernel is a state machine; **you have full context** (the objective,
prior step outputs). If a teammate aborts, deviates, or reports a
blocker, intervene via `SendMessage(to=teammate_name, …)` (team mode)
or `mcp__neural_link__message_send` (subprocess mode). The verify step
will eventually catch deviation but burns a fix iteration to do it —
correct early via direct steering instead. See the `delegate` skill for
the full lead-steering protocol and the role → subagent_type mapping
table.
</phase_1_protocol>

<examples>
**Backend feature with dependency chain:**
- Step 1: Plan API contract (cortex) → verify schema and compatibility.
- Step 2: Implement handler + persistence (probe) → verify tests pass.
- Step 3: Wire client integration (liaison) → verify end-to-end behavior.

**Bugfix requiring safe progression:**

- Step 1: Reproduce and isolate failure (probe) → verify failing test exists.
- Step 2: Implement fix (cortex) → verify target tests pass.
- Step 3: Regression sweep (probe) → verify no related breakage.
  </examples>

<constraints>
- Keep one active pipeline step at a time to preserve order.
- Require concrete evidence for pass/fail (tests, diagnostics, build output, or artifact).
- Escalate when the same step fails verification repeatedly without narrowing root cause, when a required dependency for the next step is blocked, or when security, compliance, or data-integrity risk is discovered during execution.
- Resume only after gate criteria are clarified and the failed step is re-verified successfully.
</constraints>
