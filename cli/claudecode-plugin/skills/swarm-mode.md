---
name: swarm-mode
description: Parallel execution mode for Overmind with coordinated verify/fix loops. Use when independent subtasks can run concurrently but must converge through repeated integration verification.
triggers:
  - parallel implementation
  - multi-agent work
  - verify fix loop
  - concurrent agents
  - swarm mode instructions
---

# Swarm Mode

<Purpose>
Swarm mode maximizes parallel throughput by running multiple agents simultaneously on independent subtasks,
coordinated through neural_link, then enforcing integration verification after each execution wave.

Key differentiator:
- Parallel like scout mode, but with verify/fix loop discipline like relay mode.
- This makes swarm the highest-throughput and most operationally complex mode.

Core contract:
Parallel execution wave → verification pass → fix wave (if needed) → re-verify.

This skill is a living specification for swarm behavior and acceptance constraints.
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
</Purpose>

<Use_When>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
- The objective can be decomposed into independent subtasks with minimal overlap.
- You need throughput beyond sequential relay-style execution.
- Integration quality requires explicit verify/fix loops after parallel work.
- Multiple subsystems can progress concurrently but must converge safely.
- You want coordinated multi-agent execution with evidence-backed iteration.
</Use_When>

<Do_Not_Use_When>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
- The task is small, single-threaded, or trivial enough for direct execution.
- Work items are strongly coupled and cannot be meaningfully parallelized.
- Verification criteria are undefined, subjective, or unavailable.
- Coordination overhead would exceed expected throughput gains.
- The objective is mostly exploratory context gathering (prefer scout mode first).
</Do_Not_Use_When>

<Steps>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
1. Lead decomposes objective into independent subtasks.
2. Lead creates brain tasks with dependency graph.
3. Lead opens neural_link room, dispatches N agents in parallel.
4. Agents work independently, reporting via neural_link findings.
5. After all agents finish: verification pass (Cortex reviews integration).
6. If failures found: fix loop — dispatch agents to fix, re-verify.
7. Loop until all verifications pass or max iterations reached.
8. Record outcome, close room.

Execution notes:
- Keep subtask boundaries explicit to prevent duplicate edits and merge conflicts.
- Require every agent handoff to include concrete artifacts (file paths, diagnostics, test outputs).
- Track wave number and verification result so progress is observable across iterations.
- Treat verification as a gate on the integrated system, not isolated subtask success.
- Limit iteration count to avoid uncontrolled looping; escalate when convergence stalls.
- Persist major decisions and blockers to brain-linked task comments during each wave.
</Steps>

<Examples>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
Example A — Feature spanning API, domain logic, and tests:
- Wave 1 parallel: API contract updates, domain implementation, test scaffolding.
- Verification: integration tests + diagnostics across changed modules.
- Fix loop: targeted patch wave for failing integration points.
- Exit: all verification gates pass and artifacts are recorded.

Example B — Broad bugfix with multiple suspected failure surfaces:
- Wave 1 parallel: reproduction hardening, root-cause patch, observability updates.
- Verification: failing case resolved, no regression in related test suites.
- Fix loop: assign agents to residual failures by component ownership.
- Exit: failure eliminated and regression checks remain green.

Example C — Cross-cutting refactor with safety gates:
- Wave 1 parallel: call-site updates, type/schema adjustments, migration-safe tests.
- Verification: build, typecheck, diagnostics, and compatibility checks.
- Fix loop: iterative correction on conflicts and integration drift.
- Exit: refactor converges with no unresolved blockers.
</Examples>

<Escalation_And_Stop_Conditions>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
Escalate when:
- Subtasks cannot be kept independent and repeated overlap causes churn.
- Verification fails repeatedly without narrowing root cause.
- A critical dependency blocks one or more parallel lanes.
- Cross-agent outputs conflict and cannot be reconciled from evidence.
- Security, compliance, or data-integrity risk appears during a wave.

Stop swarm execution when:
- Max iteration threshold is reached without convergence.
- Required verification signals are unavailable or non-deterministic.
- Scope mutation invalidates existing decomposition and dependency graph.

Resume only after:
- Objective is re-scoped into valid independent subtasks.
- Verification criteria are explicit and measurable.
- Blocking dependencies are resolved and reassigned.
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- Frontmatter is valid YAML with `name`, `description`, and list-form `triggers`.
- Trigger list includes all canonical swarm phrases and uses YAML list syntax.
- Swarm is described as parallel throughput plus verify/fix loop convergence.
- Steps include decomposition, brain task graphing, neural_link dispatch, verification, and closure.
- Aspirational sections include planned-status marker for ovr-396.3.
- Verification/fix loop has explicit termination and escalation conditions.
- Outcome recording and room closure are defined before completion.
</Final_Checklist>
