import { EventBus, EventType } from "./events.ts";
import type { KernelEvent } from "./events.ts";
import { ConfigLoader } from "./config.ts";
import { TriggerEngine, DEFAULT_TRIGGERS } from "./triggers.ts";
import { AdapterRegistry } from "./adapters.ts";
import type { KernelConfig, RunContext } from "./types.ts";
import { Mode, RunState } from "./types.ts";
import { OvermindError } from "./errors.ts";
import { createRunContext } from "./modes/shared.ts";
import { executeScout } from "./modes/scout.ts";
import { executeRelay } from "./modes/relay.ts";
import { executeSwarm } from "./modes/swarm.ts";

export interface KernelOptions {
  registry?: AdapterRegistry;
}

export class Kernel {
  private eventBus: EventBus;
  private configLoader: ConfigLoader;
  private triggerEngine: TriggerEngine;
  private adapterRegistry: AdapterRegistry | null = null;
  private injectedRegistry: AdapterRegistry | null = null;
  private config: KernelConfig | null = null;
  private running = false;

  constructor(options?: KernelOptions) {
    this.eventBus = new EventBus();
    this.configLoader = new ConfigLoader();
    this.triggerEngine = new TriggerEngine();
    this.injectedRegistry = options?.registry ?? null;
  }

  async start(): Promise<void> {
    if (this.running) throw new OvermindError("Kernel already running");

    const cfg = await this.configLoader.load();
    this.config = this.configLoader.toKernelConfig(cfg);

    for (const trigger of DEFAULT_TRIGGERS) {
      this.triggerEngine.addTrigger(trigger);
    }

    this.adapterRegistry = this.injectedRegistry ?? new AdapterRegistry(this);
    if (!this.injectedRegistry) {
      await this.adapterRegistry.connect();
    }

    this.running = true;
    this.emit(EventType.KernelStarting);
    this.emit(EventType.KernelReady);
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.emit(EventType.KernelShutdown);
    if (this.adapterRegistry) {
      await this.adapterRegistry.disconnect();
    }
    this.running = false;
  }

  getConfig(): KernelConfig {
    if (!this.config) throw new OvermindError("Kernel not started");
    return this.config;
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getTriggerEngine(): TriggerEngine {
    return this.triggerEngine;
  }

  getAdapterRegistry(): AdapterRegistry | null {
    return this.adapterRegistry;
  }

  async receiveObjective(objective: string): Promise<void> {
    if (!this.running) throw new OvermindError("Kernel not running");
    this.emit(EventType.ObjectiveReceived, { objective });
  }

  async executeMode(mode: Mode, objective: string): Promise<RunContext> {
    return await this.executeModeImpl(mode, objective);
  }

  private async executeModeImpl(mode: Mode, objective: string): Promise<RunContext> {
    if (!this.adapterRegistry) throw new OvermindError("Kernel not started");

    this.emit(EventType.ModeSwitched, { mode });

    const config = this.getConfig();
    const modeSettings = config.modes[mode];
    const maxIterations = modeSettings?.maxFixCycles ?? 3;

    const ctx = createRunContext({
      run_id: `run-${crypto.randomUUID()}`,
      mode,
      objective,
      workspace: Deno.cwd(),
      brain_task_id: "",
      room_id: "",
      max_iterations: maxIterations,
    });

    const brain = this.adapterRegistry.getBrain();
    const neuralLink = this.adapterRegistry.getNeuralLink();

    switch (mode) {
      case Mode.Scout:
        return await executeScout(ctx, brain, neuralLink);
      case Mode.Relay:
        return await executeRelay(ctx, brain, neuralLink);
      case Mode.Swarm:
        return await executeSwarm(ctx, brain, neuralLink);
    }
  }

  private emit(type: EventType, payload: Record<string, unknown> = {}): void {
    const event: KernelEvent = { type, timestamp: new Date(), payload };
    this.eventBus.emit(event);
    this.triggerEngine.fire(event).catch((err) => {
      console.error(`Trigger engine error for ${type}:`, err);
    });
  }
}
