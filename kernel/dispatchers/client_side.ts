import type {
  AgentDispatcher,
  AgentDispatchRequest,
  AgentDispatchResult,
} from "../agent_dispatcher.ts";

/**
 * Extract the run_id from an agentId. The kernel encodes agentIds as
 * `${runId}-${suffix}`. The runId itself starts with `run-` and
 * contains a UUID, so we anchor on that prefix.
 *
 * Duplicated from claude_code.ts intentionally — ovr-509.5 will extract this
 * to a shared location.
 */
function extractRunId(agentId: string): string {
  const match = agentId.match(
    /^(run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
  );
  if (!match) {
    return agentId;
  }
  return match[1];
}

/**
 * Queue-based dispatcher for client-side (browser/UI) mode.
 *
 * Instead of spawning subprocesses, dispatch requests are queued per runId.
 * The UI polls via `drainPending` to pull the next batch and spawn agents
 * on the client side. This dispatcher never throws and always reports
 * `launched: true` to allow the kernel to proceed normally.
 */
export class ClientSideDispatcher implements AgentDispatcher {
  private readonly pending = new Map<string, AgentDispatchRequest[]>();

  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    const runId = extractRunId(request.agentId);
    const queue = this.pending.get(runId) ?? [];
    queue.push(request);
    this.pending.set(runId, queue);
    return { launched: true };
  }

  isAvailable(): boolean {
    return true;
  }

  cancelRun(runId: string): void {
    this.pending.delete(runId);
  }

  /** Returns and clears the pending queue for a runId. */
  drainPending(runId: string): AgentDispatchRequest[] {
    const queue = this.pending.get(runId) ?? [];
    this.pending.delete(runId);
    return queue;
  }

  /** Returns the number of queued requests for a runId without draining. */
  getPendingCount(runId: string): number {
    return this.pending.get(runId)?.length ?? 0;
  }
}
