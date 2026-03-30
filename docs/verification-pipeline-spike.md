# ovr-396.15 — Verification Pipeline Spike

**Status:** Complete
**Type:** Spike (Research + Design)
**Brain Task:** ovr-396.24
**Blocks:** ovr-396.16 (Implement real verification pipeline)

## Research Summary

Compared Overmind's verification against OMO/OMA Atlas executor. Key findings:

| Gap | OMO/OMA Has | Overmind Lacks |
|-----|-------------|----------------|
| **LSP Diagnostics** | 6 LSP tools for semantic verification | ❌ No LSP integration |
| **Build/Test Verification** | Bash commands for tests/builds | ❌ No automated build verification |
| **Quality Hooks** | `commentChecker`, `emptyTaskResponseDetector`, `thinkingBlockValidator` | ❌ No pre-write validation hooks |
| **Exponential Backoff** | Model-level fallback chain | ❌ Iteration only, no backoff |
| **Circuit Breaker** | Not documented in OMO/OMA | ❌ No circuit breaker |
| **Wisdom Accumulation** | `.sisyphus/notepads/` with 5 categories | ❌ No persistent learnings |
| **Evidence Structure** | Notepads + progress + session history | ❌ Brain comments only |

## Current Architecture

### Mode Verification Flow

```
relay.ts / swarm.ts:
  1. Execute step(s)
  2. Send ReviewRequest (kind: "review_request") to "verifier"
  3. Wait for ReviewResult (kind: "review_result")
  4. Parse result: { passed, details, failedTasks[] }
  5. If failed && shouldRetry → Fix loop
  6. If failed && !shouldRetry → Fail
```

### Shared Retry Logic (shared.ts)

```typescript
function shouldRetry(ctx: RunContext): boolean {
  return ctx.iteration < ctx.max_iterations;
}
```

**Problems:**
- No exponential backoff between fix attempts
- No jitter to prevent thundering herd
- No circuit breaker pattern
- No retry budget tracking
- Verifier agent is a placeholder with no actual implementation

## OMO/OMA Reference Findings

### Verification Patterns
- **LSP Diagnostics**: Primary semantic verification via `lsp_diagnostics`
- **Session Idle Detection**: 10s+ idle + output + no incomplete todos
- **Quality Control Hooks**: `commentChecker`, `emptyTaskResponseDetector`, `thinkingBlockValidator`
- **Todo Continuation Enforcer**: Forces completion when todos remain open

### Retry Semantics
- **Model Fallback Chain**: Iterates through fallback models on error (not exponential backoff)
- **Retryable Errors**: 429, 529, timeout, 503, context overflow
- **Non-Retryable**: 400, 401, 403, agent not found
- **Concurrency Slot First**: Releases slot BEFORE aborting to prevent blocking
- **No Exponential Backoff**: Immediate requeue after slot release

### Evidence Collection
- **Notepad System**: `.sisyphus/notepads/` stores learnings, decisions, issues, verification, problems
- **Progress Object**: Tracks `toolCalls`, `lastUpdate` during execution
- **Session History**: `session_read`, `session_info` for reviewing prior work

## Proposed Verification Pipeline Design

### Core Interfaces

```typescript
// Verification trigger
interface VerificationTrigger {
  type: "manual" | "automated" | "scheduled";
  source: "agent" | "lsp" | "build" | "test";
}

// Evidence collected during verification
interface VerificationEvidence {
  trigger: VerificationTrigger;
  timestamp: string;
  duration_ms: number;
  artifacts: EvidenceArtifact[];
  diagnostics: Diagnostic[];
  testResults?: TestResultSummary;
  buildOutput?: BuildOutput;
}

interface EvidenceArtifact {
  type: "file" | "diagnostic" | "test" | "build";
  path?: string;
  content?: string;
  summary: string;
}

interface Diagnostic {
  severity: "error" | "warning" | "info";
  source: string;
  message: string;
  file?: string;
  line?: number;
}

// Verification result with rich evidence
interface VerificationResult {
  passed: boolean;
  confidence: number; // 0.0 - 1.0
  details: string;
  evidence: VerificationEvidence;
  failedTasks: FailedTask[];
  recommendations: string[];
}

interface FailedTask {
  taskId: string;
  reason: string;
  evidence: EvidenceArtifact[];
}
```

### Retry Semantics

```typescript
interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  exponentialBase: number;
  jitterFactor: number;
  circuitBreaker?: CircuitBreakerConfig;
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

interface RetryState {
  attempt: number;
  totalDelayMs: number;
  lastAttempt: string;
  circuitState: "closed" | "open" | "half-open";
}
```

**Default Policy:**
```typescript
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  exponentialBase: 2,
  jitterFactor: 0.1,
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 60000,
    halfOpenMaxAttempts: 2,
  },
};
```

### Verification Strategies

```typescript
type VerificationStrategy = 
  | { type: "lsp"; files: string[] }
  | { type: "build"; command: string; cwd?: string }
  | { type: "test"; command: string; cwd?: string; coverage?: boolean }
  | { type: "agent"; agentRole: string; prompt: string }
  | { type: "composite"; strategies: VerificationStrategy[]; mode: "all" | "any" };

interface VerificationPipeline {
  strategies: VerificationStrategy[];
  retry: RetryPolicy;
  evidenceCollection: EvidenceCollectionConfig;
}
```

### Evidence Collection

```typescript
interface EvidenceCollectionConfig {
  collectLsp: boolean;
  collectBuild: boolean;
  collectTests: boolean;
  collectAgentReview: boolean;
  maxEvidenceItems: number;
  evidenceRetention: "session" | "run" | "permanent";
}
```

## Implementation Phases

### Phase 1: Verification Pipeline Core (ovr-396.16)
- [ ] `VerificationPipeline` class
- [ ] `RetryState` machine with exponential backoff + jitter
- [ ] `CircuitBreaker` implementation
- [ ] Basic evidence types (Diagnostic, EvidenceArtifact)

### Phase 2: Strategy Implementations
- [ ] LSP verification strategy (read diagnostics from LSP)
- [ ] Build verification strategy (run build command)
- [ ] Test verification strategy (run test command)
- [ ] Agent-based verification (delegate to verifier agent)

### Phase 3: Integration
- [ ] Replace swarm.ts `verifyWave()` with pipeline
- [ ] Replace relay.ts inline verification with pipeline
- [ ] Add evidence to Brain task comments
- [ ] Persist verification evidence to state

### Phase 4: Advanced
- [ ] Composite verification (all/any modes)
- [ ] Parallel strategy execution
- [ ] Verification history + trending
- [ ] Smart retry based on failure patterns

## Key Design Decisions

1. **Evidence > Boolean** - Verification always returns rich evidence, even on success
2. **Strategies are composable** - Complex verification via composite strategies
3. **Retry is configurable** - Per-pipeline retry policy, not global setting
4. **Circuit breaker per pipeline** - Prevents cascading failures across verifications
5. **Evidence is first-class** - Stored, searchable, linkable to Brain tasks

## Risks

1. **Performance overhead** - Multiple verification strategies may slow execution
2. **Flaky tests** - Test strategy may produce non-deterministic results
3. **LSP availability** - LSP may not be available in all environments

## Open Questions

1. Should verification be blocking (synchronous) or non-blocking (async)?
2. Should evidence be stored in Brain memory or filesystem?
3. How to handle verification timeout vs. verification failure?
4. Should we support verification pre-flight checks before execution?
