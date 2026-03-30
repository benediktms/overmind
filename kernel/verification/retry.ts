import type { CircuitState, RetryPolicy, RetryState } from "./types.ts";

export function createRetryState(): RetryState {
  return {
    attempt: 0,
    totalDelayMs: 0,
    totalWallClockMs: 0,
    lastAttempt: new Date().toISOString(),
    circuitState: "closed",
    consecutiveFailures: 0,
  };
}

export function computeDelayMs(state: RetryState, policy: RetryPolicy): number {
  const exponentialDelay = policy.baseDelayMs * Math.pow(policy.exponentialBase, state.attempt);
  const jitter = exponentialDelay * policy.jitterFactor * (Math.random() * 2 - 1);
  const withJitter = Math.max(0, exponentialDelay + jitter);
  return Math.min(withJitter, policy.maxDelayMs);
}

export function shouldRetry(state: RetryState, policy: RetryPolicy): boolean {
  if (state.attempt >= policy.maxAttempts) {
    return false;
  }
  if (state.circuitState === "open") {
    return false;
  }
  return true;
}

export function recordSuccess(state: RetryState): RetryState {
  return {
    ...state,
    consecutiveFailures: 0,
    circuitState: "closed",
  };
}

export function recordFailure(state: RetryState, policy: RetryPolicy): RetryState {
  const newFailures = state.consecutiveFailures + 1;
  let newCircuitState: CircuitState = state.circuitState;

  if (state.circuitState === "half-open") {
    newCircuitState = "open";
  } else if (policy.circuitBreaker && newFailures >= policy.circuitBreaker.failureThreshold) {
    newCircuitState = "open";
  }

  return {
    ...state,
    consecutiveFailures: newFailures,
    circuitState: newCircuitState,
  };
}

export function canAttemptFromHalfOpen(state: RetryState, policy: RetryPolicy): boolean {
  if (state.circuitState !== "half-open") {
    return true;
  }
  if (!policy.circuitBreaker) {
    return true;
  }
  return state.attempt < policy.circuitBreaker.halfOpenMaxAttempts;
}

export function shouldAttemptNow(state: RetryState, policy: RetryPolicy, lastAttemptTime: number): boolean {
  if (state.circuitState === "open") {
    if (!policy.circuitBreaker) {
      return false;
    }
    const elapsed = Date.now() - lastAttemptTime;
    return elapsed >= policy.circuitBreaker.resetTimeoutMs;
  }
  return true;
}

export function transitionToHalfOpen(state: RetryState): RetryState {
  if (state.circuitState !== "open") {
    return state;
  }
  return {
    ...state,
    circuitState: "half-open",
  };
}

export function incrementAttempt(state: RetryState): RetryState {
  return {
    ...state,
    attempt: state.attempt + 1,
    lastAttempt: new Date().toISOString(),
  };
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
