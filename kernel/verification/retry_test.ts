import { assertEquals, assertGreater } from "@std/assert";
import {
  computeDelayMs,
  createRetryState,
  incrementAttempt,
  isEvidenceStale,
  isStuckOnSameFailure,
  normalizeFailure,
  recordFailure,
  recordNormalizedFailure,
  recordSuccess,
  shouldRetry,
} from "./retry.ts";
import { DEFAULT_RETRY_POLICY } from "./types.ts";

Deno.test("createRetryState returns initial state", () => {
  const state = createRetryState();
  assertEquals(state.attempt, 0);
  assertEquals(state.totalDelayMs, 0);
  assertEquals(state.totalWallClockMs, 0);
  assertEquals(state.circuitState, "closed");
  assertEquals(state.consecutiveFailures, 0);
});

Deno.test("computeDelayMs returns exponential backoff with jitter", () => {
  const state = createRetryState();
  const delay1 = computeDelayMs(state, DEFAULT_RETRY_POLICY);
  const delay2 = computeDelayMs({ ...state, attempt: 1 }, DEFAULT_RETRY_POLICY);
  const delay3 = computeDelayMs({ ...state, attempt: 2 }, DEFAULT_RETRY_POLICY);

  assertGreater(delay1, 0);
  assertGreater(delay2, delay1);
  assertGreater(delay3, delay2);
});

Deno.test("computeDelayMs respects maxDelayMs", () => {
  const state = createRetryState();
  const delay = computeDelayMs({ ...state, attempt: 100 }, DEFAULT_RETRY_POLICY);
  const jitterRange = DEFAULT_RETRY_POLICY.maxDelayMs * DEFAULT_RETRY_POLICY.jitterFactor;
  assertEquals(delay >= DEFAULT_RETRY_POLICY.maxDelayMs - jitterRange, true);
  assertEquals(delay <= DEFAULT_RETRY_POLICY.maxDelayMs + jitterRange, true);
});

Deno.test("shouldRetry returns false when maxAttempts reached", () => {
  const state = { ...createRetryState(), attempt: 3 };
  assertEquals(shouldRetry(state, DEFAULT_RETRY_POLICY), false);
});

Deno.test("shouldRetry returns false when circuit is open", () => {
  const state = { ...createRetryState(), circuitState: "open" as const };
  assertEquals(shouldRetry(state, DEFAULT_RETRY_POLICY), false);
});

Deno.test("shouldRetry returns true when within limits", () => {
  const state = createRetryState();
  assertEquals(shouldRetry(state, DEFAULT_RETRY_POLICY), true);
});

Deno.test("recordSuccess resets consecutiveFailures and circuitState", () => {
  const state = { ...createRetryState(), consecutiveFailures: 5, circuitState: "open" as const };
  const newState = recordSuccess(state);
  assertEquals(newState.consecutiveFailures, 0);
  assertEquals(newState.circuitState, "closed");
});

Deno.test("recordFailure increments consecutiveFailures", () => {
  const state = createRetryState();
  const newState = recordFailure(state, DEFAULT_RETRY_POLICY);
  assertEquals(newState.consecutiveFailures, 1);
});

Deno.test("recordFailure opens circuit after threshold", () => {
  const state = { ...createRetryState(), consecutiveFailures: 4 };
  const newState = recordFailure(state, DEFAULT_RETRY_POLICY);
  assertEquals(newState.consecutiveFailures, 5);
  assertEquals(newState.circuitState, "open");
});

Deno.test("incrementAttempt increases attempt counter", () => {
  const state = createRetryState();
  const newState = incrementAttempt(state);
  assertEquals(newState.attempt, 1);
});

Deno.test("normalizeFailure strips timestamps, line numbers, timing, whitespace", () => {
  const raw = "Error at 2026-03-30T14:30:29Z in file.ts 42:10  took 123.5ms  extra   spaces";
  const normalized = normalizeFailure(raw);
  assertEquals(normalized, "Error at <TS> in file.ts <LOC> took <DUR> extra spaces");
});

Deno.test("normalizeFailure returns stable output for identical errors", () => {
  const err1 = "Build failed at 2026-03-30T10:00:00Z line 5:3 in 200ms";
  const err2 = "Build failed at 2026-03-30T11:00:00Z line 5:3 in 350ms";
  assertEquals(normalizeFailure(err1), normalizeFailure(err2));
});

Deno.test("isStuckOnSameFailure returns false below threshold", () => {
  let state = createRetryState();
  state = recordNormalizedFailure(state, "error A");
  state = recordNormalizedFailure(state, "error A");
  assertEquals(isStuckOnSameFailure(state, DEFAULT_RETRY_POLICY), false);
});

Deno.test("isStuckOnSameFailure returns true at threshold", () => {
  let state = createRetryState();
  state = recordNormalizedFailure(state, "error A");
  state = recordNormalizedFailure(state, "error A");
  state = recordNormalizedFailure(state, "error A");
  assertEquals(isStuckOnSameFailure(state, { ...DEFAULT_RETRY_POLICY, sameFailureThreshold: 3 }), true);
});

Deno.test("isStuckOnSameFailure returns false with different failures", () => {
  let state = createRetryState();
  state = recordNormalizedFailure(state, "error A");
  state = recordNormalizedFailure(state, "error B");
  state = recordNormalizedFailure(state, "error A");
  assertEquals(isStuckOnSameFailure(state, { ...DEFAULT_RETRY_POLICY, sameFailureThreshold: 3 }), false);
});

Deno.test("isEvidenceStale returns true for old evidence", () => {
  const oldTimestamp = new Date(Date.now() - 400_000).toISOString();
  assertEquals(isEvidenceStale(oldTimestamp, 300_000), true);
});

Deno.test("isEvidenceStale returns false for fresh evidence", () => {
  const freshTimestamp = new Date().toISOString();
  assertEquals(isEvidenceStale(freshTimestamp, 300_000), false);
});

Deno.test("recordNormalizedFailure appends to recentNormalizedFailures", () => {
  let state = createRetryState();
  assertEquals(state.recentNormalizedFailures.length, 0);
  state = recordNormalizedFailure(state, "error at 2026-03-30T10:00:00Z");
  assertEquals(state.recentNormalizedFailures.length, 1);
  state = recordNormalizedFailure(state, "error at 2026-03-30T11:00:00Z");
  assertEquals(state.recentNormalizedFailures.length, 2);
  // Both should normalize to the same string
  assertEquals(state.recentNormalizedFailures[0], state.recentNormalizedFailures[1]);
});

Deno.test("createRetryState initializes recentNormalizedFailures", () => {
  const state = createRetryState();
  assertEquals(state.recentNormalizedFailures, []);
});
