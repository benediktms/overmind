import { assertEquals, assertGreater } from "@std/assert";
import {
  computeDelayMs,
  createRetryState,
  incrementAttempt,
  recordFailure,
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
