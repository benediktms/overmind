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
Invoke via `mcp__overmind__overmind_delegate` with `mode: "scout"`:

```
mcp__overmind__overmind_delegate(objective: string, mode: "scout", priority?: 0-4)
```

The kernel:

1. Creates a brain task with title prefix `[overmind:scout]`.
2. Opens a neural_link room (interaction mode: `informative`).
3. Derives 3 default investigation angles from the objective (or N angles from a
   planner TaskGraph).
4. Dispatches one Probe agent per angle via `mcp__neural_link__message_send` +
   `AgentDispatcher`.
5. Collects `handoff` messages from each Probe (30 s timeout per agent).
6. Synthesizes findings into a brain memory episode.
7. Closes the room and marks the task complete.

Cancellation: signal via `mcp__overmind__overmind_cancel`; the kernel closes the
room and marks the run `cancelled`.
</protocol>

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
