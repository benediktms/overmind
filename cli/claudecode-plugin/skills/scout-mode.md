---
name: scout-mode
description: Parallel context-gathering mode for Overmind. Use when you need broad, fast understanding of an unfamiliar objective before implementation.
triggers:
  - context gathering
  - investigate codebase
  - map dependencies
  - understand architecture
  - scout mode instructions
---

# Scout Mode

<Purpose>
Scout mode dispatches parallel explore agents (adjuncts) to gather context from multiple angles simultaneously.
The lead coordinates findings into a unified understanding before proceeding with implementation or planning.

This skill defines expected coordination behavior, communication patterns, and synthesis outputs so exploration is fast,
traceable, and reusable across sessions.
</Purpose>

<Use_When>
- The objective is broad, ambiguous, or touches multiple subsystems.
- You need to map dependencies before changing code.
- You need architecture understanding across files, services, or boundaries.
- You want parallel investigation to reduce discovery time.
- You need a consolidated analysis artifact before execution.
</Use_When>

<Do_Not_Use_When>
- The task is a trivial single-file edit with obvious scope.
- The implementation path is already known and low-risk.
- You need immediate direct execution rather than discovery.
- The objective is blocked on a single missing external input.
- You are already in a focused fix loop where parallel discovery adds noise.
</Do_Not_Use_When>

<Steps>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
1. Lead analyzes the objective and identifies 3-5 investigation angles.
2. Lead opens a neural_link room for coordination.
3. Lead dispatches parallel explore subagents (Probe agents), each investigating one angle.
4. Agents report findings via neural_link `finding` messages.
5. Lead synthesizes findings, records to brain memory.
6. Lead presents consolidated analysis to user.

Execution notes:
- Assign one clear angle per Probe to avoid duplicated exploration.
- Require concrete evidence in every finding (file path, command output, or API reference).
- Keep thread IDs stable when multiple topics run in one room.
- Prefer breadth first, then depth where conflicts or uncertainty remain.
- Capture unknowns explicitly so follow-up work is scoped, not improvised.
</Steps>

<Examples>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
Example A — New feature in unfamiliar module:
- Angles: domain model, API surface, persistence, tests, runtime wiring.
- Probe outputs: entity map, endpoint touchpoints, migration requirements, test gaps.
- Lead output: one-page readiness summary with implementation risks and suggested order.

Example B — Architecture investigation before refactor:
- Angles: coupling graph, dependency hotspots, side effects, performance-sensitive paths.
- Probe outputs: import graph notes, cross-module call chains, benchmark-sensitive functions.
- Lead output: refactor safety constraints and staged rollout proposal.

Example C — Incident follow-up discovery:
- Angles: failure path, observability gaps, retry/circuit logic, data integrity checks.
- Probe outputs: timeline-relevant code paths, missing telemetry points, guardrail gaps.
- Lead output: root-cause context package for fix planning and regression prevention.
</Examples>

<Escalation_And_Stop_Conditions>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
Escalate when:
- Two or more Probe findings conflict and cannot be reconciled from available evidence.
- Critical files are inaccessible, missing, or generated from unknown sources.
- The objective appears to span independent domains requiring separate workstreams.
- Security, compliance, or data-loss risk is discovered during scouting.

Stop scouting and transition to execution when:
- Core architecture map is stable and major unknowns are bounded.
- Required dependency paths are identified with concrete file-level evidence.
- Risks are documented with clear mitigations or follow-up tasks.
- Lead can state a confident implementation sequence without speculative gaps.
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- Frontmatter is valid YAML with `name`, `description`, and list-form `triggers`.
- Investigation angles are explicit, non-overlapping, and evidence-driven.
- neural_link communication uses correct message kinds (`finding`, `question`, `handoff`, `decision`).
- Consolidated synthesis captures findings, contradictions, risks, and next actions.
- Brain memory recording includes durable context that is not obvious from code alone.
- Handoff to execution is clear, bounded, and includes verification expectations.
</Final_Checklist>
