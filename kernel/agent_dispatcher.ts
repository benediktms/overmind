import type { AgentRole } from "./agents/roles.ts";

/** Describes an agent to be spawned. */
export interface AgentDispatchRequest {
  /** Unique ID for this agent instance within the run. */
  agentId: string;
  /** The role this agent should assume. */
  role: AgentRole;
  /** The prompt/objective for this agent. */
  prompt: string;
  /** The neural_link room to join. */
  roomId: string;
  /** The participant ID to use when joining. */
  participantId: string;
  /** Working directory. */
  workspace: string;
}

/** Result of an agent dispatch attempt. */
export interface AgentDispatchResult {
  /** Whether the agent was successfully launched. */
  launched: boolean;
  /** Error message if launch failed. */
  error?: string;
}

/**
 * Pluggable interface for spawning agents.
 * Platform adapters (Claude Code, OpenCode, subprocess) implement this.
 */
export interface AgentDispatcher {
  /** Spawn an agent. The agent is expected to join the neural_link room and send a handoff when done. */
  dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult>;

  /** Check if the dispatcher is available/configured. */
  isAvailable(): boolean;

  /**
   * Best-effort cancel of all in-flight agents belonging to a run. Called by
   * the kernel when `cancelRun` fires. Implementations that have no
   * resources to release (noop, mock) can ignore. Should not throw.
   */
  cancelRun?(runId: string): void;
}

/**
 * No-op dispatcher that logs dispatch requests but doesn't spawn anything.
 * Used when no platform adapter is configured — falls back to the current
 * "message-and-hope" behavior where an external system must handle the messages.
 */
export class NoopDispatcher implements AgentDispatcher {
  readonly dispatched: AgentDispatchRequest[] = [];

  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.dispatched.push(request);
    // In noop mode, we don't actually spawn anything.
    // The neural_link message has already been sent by the mode executor.
    // An external system (or manually joined agent) must handle it.
    return { launched: false, error: "No agent dispatcher configured" };
  }

  isAvailable(): boolean {
    return false;
  }
}

/**
 * Mock dispatcher for testing — records dispatches and simulates success.
 */
export class MockDispatcher implements AgentDispatcher {
  readonly dispatched: AgentDispatchRequest[] = [];

  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.dispatched.push(request);
    return { launched: true };
  }

  isAvailable(): boolean {
    return true;
  }
}

/**
 * Wraps `dispatcher.dispatch` so a thrown error becomes a structured
 * AgentDispatchResult instead of an unhandled promise rejection. Mode
 * executors use this to fan out launches without each one being able to
 * crash the run.
 */
export async function safeDispatch(
  dispatcher: AgentDispatcher,
  request: AgentDispatchRequest,
): Promise<AgentDispatchResult> {
  try {
    return await dispatcher.dispatch(request);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(
      `[overmind] dispatcher.dispatch threw for agent ${request.agentId} (role=${request.role}): ${error}`,
    );
    return { launched: false, error };
  }
}
