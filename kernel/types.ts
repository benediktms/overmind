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
}

export interface KernelConfig {
  mode: Mode;
  agents: Record<string, AgentConfig>;
  brain: BrainConfig;
  neuralLink: NeuralLinkConfig;
  skills: SkillsConfig;
  modes: ModesConfig;
}

export interface SocketRequest {
  type: "mode_request";
  run_id: string;
  mode: Mode;
  objective: string;
  workspace: string;
  config_override?: {
    max_fix_cycles?: number;
  };
}

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
}

export interface RelayStep {
  title: string;
  description: string;
  agentRole: string;
}

export interface SwarmTask {
  title: string;
  description: string;
  agentRole: string;
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

export interface SkillsConfig {
  autoInject: boolean;
  projectOverrides: boolean;
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
  neural_link: NeuralLinkConfig;
  skills: SkillsConfig;
}
