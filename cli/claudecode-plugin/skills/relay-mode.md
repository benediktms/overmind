---
name: relay-mode
description: Sequential pipeline execution mode for Overmind. Use when work must pass verification gates step-by-step before progressing.
triggers:
  - sequential execution
  - pipeline mode
  - verification gates
  - step then verify
  - relay mode instructions
---

# Relay Mode

<Purpose>
Relay mode executes work as a sequential pipeline with verification gates.
Each step must pass verification before the next step begins.

Unlike scout mode (parallel context gathering), relay mode is explicitly sequential:
every step depends on successful output from the previous step.

Pipeline contract:
Plan → Execute → Verify → Fix (if needed) → Next step.

This skill is a living specification for relay orchestration behavior and acceptance checks.
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
</Purpose>

<Use_When>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
- The objective is clear and benefits from ordered, dependent execution.
- A failed intermediate step would invalidate downstream work.
- You need strict acceptance criteria after each execution unit.
- You want deterministic progress with explicit verify/fix gates.
- You need a traceable step-by-step pipeline rather than broad parallel discovery.
</Use_When>

<Do_Not_Use_When>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
- The primary need is wide discovery across unknown systems (use scout mode instead).
- Steps are independent and should be executed in parallel.
- The task is a trivial single-change operation with no meaningful gate checks.
- The objective is mostly exploratory and acceptance criteria are not yet defined.
- You cannot define clear verification conditions for each stage.
</Do_Not_Use_When>

<Steps>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
1. Lead analyzes objective and creates a sequential task chain in brain.
2. Lead opens a neural_link room for the pipeline.
3. For each step, lead dispatches the appropriate agent:
   - Cortex for planning/architecture reasoning
   - Probe for investigation and codebase evidence
   - Liaison for UI-oriented implementation and review
4. After each step, verify output against explicit acceptance criteria.
5. If verification fails, enter a fix loop:
   - Dispatch agent to correct the failed step
   - Re-run verification for that same step
   - Do not proceed until gate passes
6. On completion, close room and record outcome to brain.

Execution notes:
- Keep one active pipeline step at a time to preserve order.
- Persist acceptance criteria near each step so verification is objective.
- Require concrete evidence for pass/fail (tests, diagnostics, build output, or artifact).
- If a step is partially complete but fails a gate, status remains failed until re-verified.
- Capture fix-loop attempts so repeated failures are visible and actionable.
- Promote only gate-passed outputs downstream.
</Steps>

<Examples>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
Example A — Backend feature with dependency chain:
- Step 1: Plan API contract (Cortex) → verify schema and compatibility.
- Step 2: Implement handler + persistence (Probe/Cortex) → verify tests pass.
- Step 3: Wire client integration (Liaison) → verify end-to-end behavior.
- Step 4: Final checks → verify build and diagnostics are clean.

Example B — Bugfix requiring safe progression:
- Step 1: Reproduce and isolate failure (Probe) → verify failing test exists.
- Step 2: Implement fix (Cortex) → verify target tests pass.
- Step 3: Regression sweep (Probe) → verify no related breakage.
- Step 4: Release readiness summary (Lead) → verify acceptance checklist complete.

Example C — UI flow correction with strict gates:
- Step 1: Define expected UX/state transitions (Liaison) → verify criteria documented.
- Step 2: Implement UI/state updates (Liaison) → verify component tests and behavior.
- Step 3: Validate accessibility and edge states (Probe/Liaison) → verify no blockers.
- Step 4: Consolidate outcomes (Lead) → verify evidence attached for each gate.
</Examples>

<Escalation_And_Stop_Conditions>
<!-- STATUS: PLANNED — Not yet implemented. Planned for ovr-396.3 -->
Escalate when:
- Verification criteria are ambiguous or contested for the current step.
- The same step fails verification repeatedly without narrowing root cause.
- A required dependency for the next step is blocked or unavailable.
- A fix loop introduces regression risk beyond the current step scope.
- Security, compliance, or data integrity concerns are discovered at any gate.

Stop pipeline execution when:
- A critical gate cannot be satisfied with available information or authority.
- Upstream assumptions are invalidated, requiring chain replanning.
- External blockers prevent continued execution with confidence.

Resume only after:
- Gate criteria are clarified and agreed.
- Blocking dependency is resolved.
- The failed step is re-verified successfully.
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- Frontmatter is valid YAML with `name`, `description`, and list-form `triggers`.
- Relay behavior is explicitly sequential and contrasted from scout's parallel model.
- Steps enforce Plan → Execute → Verify → Fix → Next-step discipline.
- Every step includes acceptance verification before progression.
- Fix loop behavior is defined and blocks downstream execution until pass.
- All aspirational sections include planned-status marker for ovr-396.3.
- Completion includes room closure and outcome recording to brain.
</Final_Checklist>
