export interface KernelConfig {
  mode: "scout" | "relay" | "swarm";
  agents: Record<string, AgentConfig>;
  brain: BrainConfig;
  neuralLink: NeuralLinkConfig;
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
