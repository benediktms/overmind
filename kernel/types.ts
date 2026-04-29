export type { AgentRole, BaseAgentRole } from "./agents/roles.ts";
import type { AgentRole } from "./agents/roles.ts";

export { MessageKind } from "../adapters/neural_link/adapter.ts";
export type {
  MessageSendParams,
  RoomOpenParams,
} from "../adapters/neural_link/adapter.ts";
import type {
  MessageSendParams,
  RoomOpenParams,
} from "../adapters/neural_link/adapter.ts";

export enum Mode {
  Scout = "scout",
  Relay = "relay",
  Swarm = "swarm",
}

export enum RunState {
  Pending = "pending",
  Running = "running",
  Verifying = "verifying",
  Fixing = "fixing",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

export enum EventType {
  KernelStarting = "kernel_starting",
  KernelReady = "kernel_ready",
  ObjectiveReceived = "objective_received",
  AgentRegistered = "agent_registered",
  AgentStartedWorking = "agent_started_working",
  AgentFinished = "agent_finished",
  AgentError = "agent_error",
  TaskCreated = "task_created",
  TaskUpdated = "task_updated",
  TaskCompleted = "task_completed",
  RoomOpened = "room_opened",
  RoomClosed = "room_closed",
  SkillInjected = "skill_injected",
  ModeSwitched = "mode_switched",
  ExternalDiscovery = "external_discovery",
  DecisionMade = "decision_made",
  KernelShutdown = "kernel_shutdown",
  // External hook event delivered via the kernel's HTTP /event endpoint.
  // Payload carries `body`: the raw JSON the hook POSTed. Hook scripts post
  // arbitrary shapes so we deliberately don't pre-flatten — subscribers
  // filter on body fields if they need a specific event kind. The kernel-
  // observed timestamp lives on the KernelEvent's own `timestamp` field.
  ExternalHookEvent = "external_hook_event",
}

export interface KernelConfig {
  mode: Mode;
  agents: Record<string, AgentConfig>;
  brain: BrainConfig;
  neuralLink: NeuralLinkConfig;
  skills: SkillsConfig;
  modes: ModesConfig;
  dispatcher: DispatcherConfig;
}

export interface ModeRequest {
  type: "mode_request";
  run_id: string;
  mode: Mode;
  objective: string;
  workspace: string;
  config_override?: {
    max_fix_cycles?: number;
  };
}

export interface CancelRequest {
  type: "cancel_request";
  run_id: string;
}

export interface DrainDispatchesRequest {
  type: "drain_dispatches";
  run_id: string;
}

export type SocketRequest =
  | ModeRequest
  | CancelRequest
  | DrainDispatchesRequest;

export interface SocketResponse {
  status: "accepted" | "error";
  run_id: string;
  error: string | null;
}

export interface RunContext {
  run_id: string;
  mode: Mode;
  objective: string;
  workspace: string;
  state: RunState;
  brain_task_id: string;
  room_id: string;
  iteration: number;
  max_iterations: number;
  created_at: string;
  /** Guard to prevent concurrent verification runs. */
  isVerifying: boolean;
  /** AbortSignal for cooperative cancellation. */
  signal?: AbortSignal;
}

export interface RelayStep {
  title: string;
  description: string;
  agentRole: AgentRole;
}

export interface SwarmTask {
  /**
   * Stable identifier used for dependency resolution. When a SwarmTask is
   * built from a TaskGraph, this is the TaskNode.id (matching the contract of
   * planner/topologicalSort). When using the built-in default tasks, the id
   * defaults to the title.
   */
  id: string;
  title: string;
  description: string;
  agentRole: AgentRole;
  /** Other SwarmTask ids this task depends on. */
  dependencies: string[];
}

export interface AgentConfig {
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
}

export interface BrainConfig {
  enabled: boolean;
  brainName: string;
  taskPrefix: string;
}

export interface NeuralLinkConfig {
  enabled: boolean;
  httpUrl: string;
  roomTtlSeconds: number;
}

export interface WaitForMessage {
  message_id: string;
  from: string;
  kind: string;
  summary: string;
  body?: string;
  thread_id?: string;
  sequence: number;
}

export interface InboxMessage extends WaitForMessage {
  to?: string;
  created_at: string;
}

export interface RoomSummary {
  decisions: string[];
  open_questions: string[];
  blockers: string[];
  participant_count: number;
  message_count: number;
}

export interface SkillsConfig {
  autoInject: boolean;
  projectOverrides: boolean;
}

/**
 * Selects which AgentDispatcher implementation the daemon uses.
 *
 * - "subprocess" (default): the daemon spawns one `claude --print`
 *   subprocess per agent dispatch. Works for any caller (CLI, CI,
 *   OpenCode, Claude Code) because the daemon does the spawning.
 *   Costs: ~150-300 MB RAM and 60-90s cold start per worker; full env
 *   inheritance; --permission-mode bypassPermissions on each worker;
 *   prompt visible in argv (ps -ef); per-worker MCP server re-handshake.
 *
 * - "client_side": the daemon queues dispatch requests; the calling
 *   session must drain them via overmind_pending_dispatches and spawn
 *   teammates via its own Agent tool with team_name + name +
 *   subagent_type. Teammates run in-process — no fork, no env leak,
 *   no argv leak, no bypassPermissions. Requires the caller to be a
 *   Claude Code session with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1.
 *   Headless callers (CLI, CI) will silently fail because the queue
 *   never gets drained.
 */
export type DispatcherMode = "subprocess" | "client_side";

export interface DispatcherConfig {
  mode: DispatcherMode;
}

export interface ModeSettings {
  description: string;
  maxAdjuncts?: number;
  maxParallel?: number;
  allowFixLoop?: boolean;
  maxFixCycles?: number;
}

export interface ModesConfig {
  default: Mode;
  scout?: ModeSettings;
  relay?: ModeSettings;
  swarm?: ModeSettings;
}

export interface OvermindConfig {
  name: string;
  version: string;
  modes: ModesConfig;
  agents: Record<string, AgentConfig>;
  brain: BrainConfig;
  neuralLink: NeuralLinkConfig;
  skills: SkillsConfig;
  dispatcher: DispatcherConfig;
}

export interface NeuralLinkPort {
  // Room lifecycle
  roomOpen(params: RoomOpenParams): Promise<string | null>;
  roomJoin(
    roomId: string,
    participantId: string,
    displayName: string,
    role?: string,
  ): Promise<boolean>;
  roomLeave(
    roomId: string,
    participantId: string,
    timeoutMs?: number,
  ): Promise<boolean>;
  roomClose(roomId: string, resolution: string): Promise<boolean>;

  // Messaging
  messageSend(params: MessageSendParams): Promise<boolean>;
  inboxRead(roomId: string, participantId: string): Promise<InboxMessage[]>;
  messageAck(
    roomId: string,
    participantId: string,
    messageIds: string[],
  ): Promise<boolean>;
  waitFor(
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<WaitForMessage | null>;

  // Introspection
  threadSummarize(
    roomId: string,
    threadId?: string,
  ): Promise<RoomSummary | null>;

  // Connection
  isConnected(): boolean;
}
