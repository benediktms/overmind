# ovr-396.15 — Verification Pipeline & Retry Semantics Spike

**Status:** Complete (Updated 2026-03-30)
**Type:** Spike (Research + Design)
**Brain Task:** ovr-396.15
**Blocks:** ovr-396.16 (Implement real verification pipeline)

---

## Phase 1 Recap — What's Built

Phase 1 was implemented in commits `f2bc3fb` and `7fb0cd8`. Current state:

### Verification Pipeline (`kernel/verification/`)
- **VerificationPipeline class** (`pipeline.ts`) — orchestrates strategies with retry loop
- **5 strategy types** (`strategies.ts`) — LSP, Build, Test, Agent, Composite
- **Retry state machine** (`retry.ts`) — exponential backoff + jitter + circuit breaker
- **Rich evidence types** (`types.ts`) — Diagnostic, EvidenceArtifact, TestResultSummary, BuildOutput
- **Tests** — `pipeline_test.ts` (6 tests), `retry_test.ts` (6 tests)

### Mode Integration
- **Swarm** (`kernel/modes/swarm.ts`) — `verifyWave()` uses VerificationPipeline when strategies configured, falls back to agent-based verification
- **Relay** (`kernel/modes/relay.ts`) — per-step agent-based verification via neural_link
- **Scout** — no verification (exploration only)

### Retry Semantics (Current)
- Exponential backoff: `baseDelayMs * exponentialBase^attempt ± jitter`
- Default: 3 attempts, 1s-30s delay, 2x exponential, 0.1 jitter
- Circuit breaker: opens after 5 consecutive failures, 60s reset timeout, 2 half-open attempts
- Wall-clock timeout: 600s (10 min) prevents infinite loops

### Fix-Loop Architecture (Current)
- **State machine**: `Pending → Running → Verifying ↔ Fixing → Completed/Failed`
- **Relay**: per-step verify-fix, max 3 retries per step
- **Swarm**: wave-based verify-fix, max 3 waves, selective fix-task dispatch based on failure titles
- **shouldRetry**: `ctx.iteration < ctx.max_iterations` (simple counter, no backoff between fix attempts)

---

## External Research

### OMC Patterns (oh-my-claudecode 4.7.9)

**Three-tier verification** — cost-optimized tier selection based on change metadata:

| Tier | Trigger | Model | Evidence Required | Cost |
|------|---------|-------|-------------------|------|
| LIGHT | <5 files, <100 lines, full test coverage | haiku | LSP diagnostics clean | 1x |
| STANDARD | Default | sonnet | diagnostics + build pass | 5x |
| THOROUGH | >20 files OR security/architectural changes | opus | Full review + all tests | 20x |

Selection: `hasSecurityImplications OR hasArchitecturalChanges → THOROUGH`, `filesChanged < 5 AND linesChanged < 100 → LIGHT`, else `STANDARD`. Estimated 40% cost reduction vs always-THOROUGH.

**Seven standard check types** — BUILD, TEST, LINT, FUNCTIONALITY, ARCHITECT, TODO, ERROR_FREE. 3 automated (have command), 4 manual. All required by default.

**Evidence staleness** — 5-minute TTL enforced at validation time. Stale evidence triggers re-run recommendation. Hard check in `checkEvidence()` → `validateChecklist()`.

**Execution modes** — parallel (Promise.allSettled, default) and sequential fail-fast (stops on first failure).

**Verdict state machine** — 4 states: `incomplete` (checks not yet run), `approved` (all required passed), `rejected` (any required failed). Checklist lifecycle: `pending → in_progress → complete | failed`.

**Ralph fix-loop** — max 3 architect verification attempts per completion claim. 6 regex rejection patterns (architect.*rejected, issues found, not complete, missing implementation, bug found, error found). Architect outputs `<architect-approved>VERIFIED_COMPLETE</architect-approved>` on approval.

**UltraQA cycle-based fix-loop** — max 5 cycles. Same-failure circuit breaker: 3 consecutive identical normalized failures → exit. Failure normalization strips timestamps, line:col, timing, whitespace. Terminal outcomes: `goal_met`, `max_cycles_reached`, `not_active`. Mutual exclusion with Ralph.

**Pipeline orchestrator** — 4-stage linear pipeline: `RALPLAN → EXECUTION → RALPH → QA`. Stage statuses: `pending → active → complete | failed | skipped`. Max 100 verification iterations.

**Parallel reviewer pattern** (RALPH stage) — 3 independent reviewers in parallel:
1. Functional Completeness (opus) — all requirements met per spec
2. Security Review (opus) — OWASP Top 10, auth, injection, secrets
3. Code Quality Review (opus) — structure, patterns, error handling, coverage

Any rejection → collect reasons → fix → re-verify up to maxIterations.

**Verifier agent protocol** — DEFINE → EXECUTE (parallel: tests + LSP + build + grep) → GAP ANALYSIS (per-criterion: VERIFIED / PARTIAL / MISSING) → VERDICT (binary PASS/FAIL). Hard rejection triggers: hedging words, no fresh test output, claims without results, no type check for TS, no build for compiled.

### Open-Source Tools

**oh-my-openagent (OMA)** — Oracle pattern: independent verifier agent re-evaluates output. On failure, the parent session retries (not a new top-level task), preserving context. `is_verifying` boolean prevents double-verification storms.

**mini-SWE-agent** — >74% SWE-bench verified with no explicit retry logic. Fix-loops emerge from model self-observation of tool output, bounded only by `step_limit` and `cost_limit: $3.0`. Fresh-context approach.

**OpenHands** — Most mature verification architecture: typed observation event stream (`CmdOutputObservation | ErrorObservation | AgentStateChangedObservation`), StuckDetector, explicit `RUNNING|PAUSED|FINISHED|ERROR` state machine, LLM API retries via tenacity (exponential backoff, max 5 attempts). 100 default max_iterations.

**Aider** — Lint-fix loop lacks maximum retry cap (issue #1090) — documented bug causing unbounded token consumption when lint errors are unfixable. **Canonical anti-pattern to avoid.**

**Spotify background agents** — Dual-verifier architecture: deterministic build/test gate first, then LLM-as-judge on clean diff. LLM judge vetoes ~25% of sessions. Agents self-correct ~50% of the time after rejection. Thousands of sessions in production.

### Academic Findings

**arxiv:2511.00197** — Failed agent trajectories are 12–82% longer than successful ones. Agents continue exploring wrong paths after identifying them, lacking effective early-stopping criteria.

**Universal gap** — No surveyed tool implements a "partial success" outcome state (5/5 tools reviewed). All treat task completion as binary pass/fail, creating pressure for agents to over-claim success.

### Retry Strategy Taxonomy (Three Layers)

| Layer | Purpose | Pattern |
|-------|---------|---------|
| L1 — LLM API | Transient infra failures | Exponential backoff + jitter, 3-7 attempts, retry 429/5xx only |
| L2 — Action/tool | Step-level execution failures | Append error as context observation; let model decide |
| L3 — Task-level | Full task re-attempt | Fresh context window + same task description; avoids context contamination |

---

## Gap Analysis & Proposed Designs

### Gap 1: Tiered Verification

**Problem:** Overmind always runs the same verification regardless of change size. A 1-line typo fix gets the same treatment as a 50-file architectural refactor. Wastes compute and time.

**Evidence:** OMC tier-selector.js — LIGHT=1x, STANDARD=5x, THOROUGH=20x cost ratio. Estimated 40% cost reduction vs always-THOROUGH.

**Proposed design:**
```typescript
type VerificationTier = "light" | "standard" | "thorough";

interface TierSelectionInput {
  filesChanged: number;
  linesChanged: number;
  fileTypes: string[];
  securitySensitivePaths: boolean;
  architecturalChanges: boolean;
}

function selectTier(input: TierSelectionInput): VerificationTier {
  if (input.securitySensitivePaths || input.architecturalChanges) return "thorough";
  if (input.filesChanged > 20) return "thorough";
  if (input.filesChanged < 5 && input.linesChanged < 100) return "light";
  return "standard";
}

// Per-tier strategy presets:
const TIER_STRATEGIES: Record<VerificationTier, VerificationStrategy[]> = {
  light:    [{ type: "lsp", files: [] }],
  standard: [{ type: "lsp", files: [] }, { type: "build", command: "" }, { type: "test", command: "" }],
  thorough: [{ type: "lsp", files: [] }, { type: "build", command: "" }, { type: "test", command: "" },
             { type: "agent", agentRole: "verifier", prompt: "" }],
};
```

**Files:** new `kernel/verification/tier_selector.ts`, `kernel/verification/pipeline.ts`

**Acceptance criteria:**
- [ ] `selectTier()` correctly classifies change metadata into tiers
- [ ] Pipeline uses tier-appropriate strategies
- [ ] Unit tests cover all tier boundaries

### Gap 2: Evidence Staleness TTL

**Problem:** Verification evidence has no expiration. Evidence from 30 minutes ago is treated identically to evidence collected just now. Stale evidence can mask regressions introduced since the last check.

**Evidence:** OMC `index.js` lines 232-236 — hard 5-minute TTL, stale evidence triggers re-run recommendation in `checkEvidence()`.

**Proposed design:**
```typescript
// Add to VerificationPipelineConfig:
maxEvidenceAgeMs?: number; // default 300_000 (5 min)

function isEvidenceStale(evidence: VerificationEvidence, maxAgeMs: number): boolean {
  const age = Date.now() - new Date(evidence.timestamp).getTime();
  return age > maxAgeMs;
}

// In pipeline.verify(), before returning cached/previous results:
if (previousEvidence && isEvidenceStale(previousEvidence, config.maxEvidenceAgeMs ?? 300_000)) {
  // Re-run verification, add recommendation: "Previous evidence was stale"
}
```

**Files:** `kernel/verification/types.ts`, `kernel/verification/pipeline.ts`

**Acceptance criteria:**
- [ ] Evidence older than TTL is flagged as stale
- [ ] Stale evidence triggers re-verification
- [ ] TTL is configurable per-pipeline

### Gap 3: Same-Failure Detection

**Problem:** When a fix-loop produces the same error repeatedly, the system wastes all retry budget on an unfixable problem. No mechanism detects that retries are making no progress.

**Evidence:** OMC UltraQA `SAME_FAILURE_THRESHOLD = 3` with failure normalization. Aider issue #1090 — unbounded lint-fix loop is the canonical anti-pattern. Academic finding: failed trajectories 12-82% longer than successful ones due to agents continuing on wrong paths.

**Proposed design:**
```typescript
// Add to RetryPolicy:
sameFailureThreshold?: number; // default 3

// Add to RetryState:
recentNormalizedFailures: string[];

function normalizeFailure(details: string): string {
  return details
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<TS>")     // ISO timestamps
    .replace(/\d+:\d+/g, "<LOC>")                            // line:col
    .replace(/\d+(\.\d+)?ms/g, "<DUR>")                      // timing
    .replace(/\s+/g, " ")                                     // extra whitespace
    .trim();
}

function isStuckOnSameFailure(state: RetryState, policy: RetryPolicy): boolean {
  const threshold = policy.sameFailureThreshold ?? 3;
  if (state.recentNormalizedFailures.length < threshold) return false;
  const recent = state.recentNormalizedFailures.slice(-threshold);
  return recent.every(f => f === recent[0]);
}
```

**Files:** `kernel/verification/retry.ts`, `kernel/verification/types.ts`

**Acceptance criteria:**
- [ ] Failure normalization strips volatile content
- [ ] 3 consecutive identical normalized failures triggers early stop
- [ ] Pipeline returns `outcome: "stuck"` when detected
- [ ] Threshold is configurable

### Gap 4: Deterministic-First Strategy Ordering

**Problem:** Current pipeline executes strategies sequentially in config order. If an agent review (expensive, ~$0.50) runs before a build check (cheap, ~$0.01), we waste money when the build would have caught the error.

**Evidence:** Spotify dual-verifier — deterministic gates first, LLM-as-judge second. LLM judge vetoes ~25% of sessions, meaning 75% of agent reviews are unnecessary when deterministic gates pass.

**Proposed design:**
```typescript
// Add to VerificationPipelineConfig:
failFast?: boolean; // default true

// In pipeline.ts executeStrategies():
function partitionStrategies(strategies: VerificationStrategy[]) {
  const deterministic = strategies.filter(s =>
    s.type === "lsp" || s.type === "build" || s.type === "test"
  );
  const agent = strategies.filter(s => s.type === "agent");
  const composite = strategies.filter(s => s.type === "composite");
  return { deterministic, agent, composite };
}

// Execution order:
// Phase 1 (parallel): deterministic strategies (LSP, Build, Test)
// Phase 2 (sequential): agent strategies — only if Phase 1 passes and failFast=true
// Phase 3: composite strategies
```

**Files:** `kernel/verification/pipeline.ts`

**Acceptance criteria:**
- [ ] Deterministic strategies always run before agent strategies
- [ ] Agent strategies are skipped when deterministic gates fail and failFast=true
- [ ] Existing behavior preserved when failFast=false

### Gap 5: Richer Outcome Model

**Problem:** `VerificationResult.passed` is a boolean. No way to distinguish timeout from active failure, or partial success from total failure. This forces binary thinking and loses nuance about verification progress.

**Evidence:** No surveyed tool implements partial success (0/5 tools). All suffer from agents over-claiming success due to binary pressure. OpenHands has `RUNNING|PAUSED|FINISHED|ERROR` state machine — richer than boolean but still no partial.

**Proposed design:**
```typescript
type VerificationOutcome = "passed" | "failed" | "partial" | "timeout" | "stuck";

// Extend VerificationResult:
interface VerificationResult {
  passed: boolean;              // backward-compatible: true iff outcome === "passed"
  outcome: VerificationOutcome; // NEW — richer signal
  confidence: number;           // 0.0-1.0
  details: string;
  evidence: VerificationEvidence;
  failedTasks: FailedTask[];
  recommendations: string[];
}

// Outcome determination:
// "passed"  — all strategies passed
// "failed"  — one or more strategies actively failed
// "partial" — some strategies passed, some failed (composite "any" mode)
// "timeout" — maxTotalTimeMs exceeded before completion
// "stuck"   — same-failure detection triggered (Gap 3)
```

**Files:** `kernel/verification/types.ts`, `kernel/verification/pipeline.ts`

**Acceptance criteria:**
- [ ] `outcome` field is always set alongside `passed`
- [ ] `passed === (outcome === "passed")` invariant holds
- [ ] Swarm/relay modes can branch on specific outcomes (e.g., don't fix-loop on `stuck`)
- [ ] Backward-compatible — existing `passed` checks still work

### Gap 6: Fresh-Context Retry

**Problem:** When fix-loops retry with accumulated context, the model may be contaminated by previous failed approaches. The same wrong reasoning gets replicated. mini-SWE-agent achieves >74% SWE-bench without explicit retry — fresh context is key.

**Evidence:** mini-SWE-agent — emergent fix-loops from clean context + cost_limit. OMA Oracle — parent-session retry preserving session (not task) context. Academic: failed trajectories continue exploring wrong paths.

**Proposed design:**
```typescript
// Add to RetryPolicy:
retryMode?: "in-context" | "fresh-context"; // default "in-context"

// When retryMode === "fresh-context", swarm dispatches fix tasks with:
interface FreshContextFixInput {
  originalObjective: string;
  failureSummary: string;     // brief, not full history
  failedFiles: string[];
  previousAttempts: number;
}

// In swarm.ts dispatchFixTasks():
// If fresh-context: construct FreshContextFixInput from last verification result
// Agent receives clean prompt with only: what to do, what failed (briefly), which files
// No accumulated conversation history from previous attempts
```

**Files:** `kernel/verification/types.ts`, `kernel/modes/swarm.ts`

**Acceptance criteria:**
- [ ] Fresh-context fix tasks receive only objective + failure summary + file list
- [ ] In-context mode preserves current behavior
- [ ] Configurable per RetryPolicy

### Gap 7: In-Flight Verification Guard

**Problem:** Concurrent triggers (e.g., multiple agents completing simultaneously in swarm) could launch duplicate verifications, wasting resources and producing race conditions.

**Evidence:** OMA `is_verifying` boolean prevents double-verification storms.

**Proposed design:**
```typescript
// Add to RunContext:
isVerifying: boolean; // default false

// In pipeline.verify() or mode-level verifyWave():
if (ctx.isVerifying) {
  return {
    passed: false,
    outcome: "skipped" as VerificationOutcome,  // or add "skipped" to outcome type
    details: "Verification already in flight",
    // ... minimal evidence
  };
}
ctx.isVerifying = true;
try {
  // ... run verification
} finally {
  ctx.isVerifying = false;
}
```

**Files:** `kernel/types.ts`, `kernel/verification/pipeline.ts`, `kernel/modes/shared.ts`

**Acceptance criteria:**
- [ ] Concurrent verification calls are rejected with clear signal
- [ ] Guard is always released (finally block)
- [ ] No deadlock if verification throws

### Gap 8: Parallel Strategy Execution

**Problem:** Current pipeline runs strategies sequentially. Independent deterministic checks (LSP, Build, Test) could run in parallel, reducing wall-clock verification time.

**Evidence:** OMC runs checks with `Promise.allSettled()` in parallel mode. OpenHands verifier agent runs test + LSP + build in parallel during EXECUTE phase.

**Proposed design:**
```typescript
// In pipeline.ts executeStrategies():
async function executeStrategies(): Promise<VerificationResult> {
  const { deterministic, agent, composite } = partitionStrategies(this.config.strategies);

  // Phase 1: run deterministic strategies in parallel
  const deterministicResults = await Promise.allSettled(
    deterministic.map(s => this.executeSingleStrategy(s))
  );

  const deterministicParsed = deterministicResults.map(r =>
    r.status === "fulfilled" ? r.value : errorResult(r.reason)
  );

  // Fail-fast check
  if (this.config.failFast && deterministicParsed.some(r => !r.passed)) {
    return mergeResults(deterministicParsed); // skip agent phase
  }

  // Phase 2: run agent strategies sequentially
  const agentResults: VerificationResult[] = [];
  for (const s of agent) {
    agentResults.push(await this.executeSingleStrategy(s));
  }

  return mergeResults([...deterministicParsed, ...agentResults]);
}
```

**Files:** `kernel/verification/pipeline.ts`, `kernel/verification/strategies.ts`

**Acceptance criteria:**
- [ ] Independent deterministic strategies execute in parallel
- [ ] Agent strategies wait for deterministic phase
- [ ] Wall-clock time reduced compared to sequential for multi-strategy pipelines
- [ ] Error in one parallel strategy doesn't crash others (allSettled)

---

## Open Questions — Resolved

### 1. Blocking vs non-blocking verification?

**Decision:** Blocking for relay mode (per-step gates must pass before next step). Swarm mode can prepare the next wave's task list while verification runs, but must await the result before dispatching fix tasks.

**Rationale:** Relay is sequential by design — non-blocking adds complexity with no benefit. Swarm benefits from overlap: while verification runs, the system can pre-compute which tasks to re-dispatch if verification fails.

### 2. Evidence storage?

**Decision:** Dual-write pattern:
- **Brain memory** — `memory_write_episode` for persistence and semantic search across runs
- **RunContext state** — in-memory for fast access during the current run
- **Brain task comments** — `[verify:pass]` / `[verify:fail]` with details for human visibility

**Rationale:** Already in place. Brain provides persistence + searchability. RunContext provides speed. Task comments provide observability.

### 3. Timeout vs failure handling?

**Decision:** Distinct `VerificationOutcome` values with different retry semantics:
- `timeout` — transient, retryable with same strategy (may be infra issue)
- `failed` — needs fix-loop (code issue)
- `stuck` — terminal, stop retrying (unfixable with current approach)

**Rationale:** Conflating these loses information. A timeout doesn't mean the code is wrong. A stuck loop doesn't benefit from more retries.

### 4. Pre-flight checks?

**Decision:** Implement as the first group in deterministic-first ordering (Gap 4). Lightweight checks (changed files exist, syntax parses, no merge conflict markers) run before any expensive verification.

**Rationale:** Catches obvious problems before burning compute. Fits naturally into the parallel deterministic phase.

---

## Implementation Phases

### Phase 2: Strategy Execution (Gaps 4, 8)

**Scope:** Deterministic-first ordering with fail-fast + parallel execution of independent strategies.

**Files:**
- `kernel/verification/pipeline.ts` — `partitionStrategies()`, parallel execution, fail-fast logic
- `kernel/verification/strategies.ts` — no changes needed

**Acceptance criteria:**
- Deterministic strategies run in parallel before agent strategies
- Fail-fast skips agent strategies when deterministic gates fail
- Wall-clock time measurably reduced for multi-strategy pipelines
- All existing tests pass

### Phase 3: Reliability (Gaps 2, 3, 7)

**Scope:** Evidence staleness, same-failure detection, in-flight guard.

**Files:**
- `kernel/verification/retry.ts` — `normalizeFailure()`, `isStuckOnSameFailure()`, `recentNormalizedFailures` tracking
- `kernel/verification/types.ts` — `sameFailureThreshold`, `maxEvidenceAgeMs` fields
- `kernel/verification/pipeline.ts` — staleness check, in-flight guard
- `kernel/types.ts` — `isVerifying` on RunContext
- `kernel/modes/shared.ts` — guard integration

**Acceptance criteria:**
- Stale evidence (>5 min) triggers re-verification
- 3 identical normalized failures triggers `stuck` outcome
- Concurrent verification calls are rejected cleanly
- Aider anti-pattern (unbounded loop) is impossible

### Phase 4: Tiered Verification (Gap 1)

**Scope:** TierSelector and per-tier strategy presets.

**Files:**
- New `kernel/verification/tier_selector.ts` — `selectTier()`, `TIER_STRATEGIES`
- `kernel/verification/pipeline.ts` — tier-aware strategy selection
- `kernel/verification/mod.ts` — export tier_selector

**Acceptance criteria:**
- Tier selection based on change metadata
- LIGHT/STANDARD/THOROUGH produce correct strategy sets
- Tier is recorded in evidence for auditability
- Cost reduction measurable in multi-run scenarios

### Phase 5: Advanced Outcomes (Gaps 5, 6)

**Scope:** Rich outcome model + fresh-context retry.

**Files:**
- `kernel/verification/types.ts` — `VerificationOutcome`, updated `VerificationResult`
- `kernel/verification/pipeline.ts` — outcome determination logic
- `kernel/modes/swarm.ts` — branch on outcome, fresh-context fix dispatch
- `kernel/modes/relay.ts` — branch on outcome for step-level decisions

**Acceptance criteria:**
- `outcome` field always set alongside `passed`
- `passed === (outcome === "passed")` invariant
- Swarm mode uses `stuck` to avoid useless fix-loops
- Fresh-context mode produces clean fix prompts

---

## Sources

| Source | URL / Path | Used For |
|--------|-----------|----------|
| OMC 4.7.9 verification module | `~/.claude/plugins/cache/omc/oh-my-claudecode/4.7.9/dist/features/verification/` | Tiers, checks, staleness, verdicts |
| OMC tier-selector | `dist/verification/tier-selector.js` | Cost-optimized tier selection |
| OMC Ralph verifier | `dist/hooks/ralph/verifier.js` | Fix-loop with architect approval |
| OMC UltraQA | `dist/hooks/ultraqa/index.js` | Same-failure detection |
| OMC pipeline | `dist/hooks/autopilot/pipeline.js` | 4-stage orchestration |
| oh-my-openagent | github.com/code-yeongyu/oh-my-openagent | Oracle pattern, in-flight guard |
| mini-SWE-agent | github.com/SWE-agent/mini-swe-agent | Fresh-context, emergent fix-loops |
| OpenHands | github.com/OpenHands/OpenHands | Typed observations, StuckDetector |
| Aider lint issue | github.com/paul-gauthier/aider/issues/1090 | Anti-pattern: unbounded fix-loop |
| Spotify agents | engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3 | Dual-verifier, empirical data |
| Agent behavior study | arxiv.org/abs/2511.00197 | Failed trajectory length analysis |
