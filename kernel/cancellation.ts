/**
 * Manages cancellation for active runs.
 * Maps run_id → AbortController.
 */
export class CancellationRegistry {
  private controllers = new Map<string, AbortController>();

  register(runId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return controller.signal;
  }

  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(runId);
    return true;
  }

  unregister(runId: string): void {
    this.controllers.delete(runId);
  }

  isRegistered(runId: string): boolean {
    return this.controllers.has(runId);
  }
}

/**
 * Thrown by mode executors when an AbortSignal fires mid-run. Distinct from
 * generic Error so the executor can convert it into a Cancelled run state
 * rather than reporting it as a failure.
 */
export class CancellationError extends Error {
  constructor(message = "Run cancelled") {
    super(message);
    this.name = "CancellationError";
  }
}

/**
 * Throws CancellationError when the supplied signal has fired. No-op when the
 * signal is undefined or not yet aborted. Mode executors call this at safe
 * loop boundaries (between waves, after waitFor returns) so cancellation
 * takes effect at the next checkpoint without leaving the run in a
 * half-stepped state.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CancellationError();
  }
}
