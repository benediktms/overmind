import { EventBus, EventType } from "./events.ts";
import type { KernelEvent } from "./events.ts";
import { ConfigLoader } from "./config.ts";
import { TriggerEngine, DEFAULT_TRIGGERS } from "./triggers.ts";
import { AdapterRegistry } from "./adapters.ts";
import type { KernelConfig } from "./types.ts";
import { Mode } from "./types.ts";
import { OvermindError } from "./errors.ts";

export class Kernel {
  private eventBus: EventBus;
  private configLoader: ConfigLoader;
  private triggerEngine: TriggerEngine;
  private adapterRegistry: AdapterRegistry | null = null;
  private config: KernelConfig | null = null;
  private running = false;

  constructor() {
    this.eventBus = new EventBus();
    this.configLoader = new ConfigLoader();
    this.triggerEngine = new TriggerEngine();
  }

  async start(): Promise<void> {
    if (this.running) throw new OvermindError("Kernel already running");

    const cfg = await this.configLoader.load();
    this.config = this.configLoader.toKernelConfig(cfg);

    for (const trigger of DEFAULT_TRIGGERS) {
      this.triggerEngine.addTrigger(trigger);
    }

    this.adapterRegistry = new AdapterRegistry(this);
    await this.adapterRegistry.connect();

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

  async executeMode(mode: Mode, objective: string): Promise<void> {
    switch (mode) {
      case Mode.Scout:
        await this.executeScout(objective);
        break;
      case Mode.Relay:
        await this.executeRelay(objective);
        break;
      case Mode.Swarm:
        await this.executeSwarm(objective);
        break;
    }
  }

  private async executeScout(objective: string): Promise<void> {
    this.emit(EventType.ModeSwitched, { mode: Mode.Scout });
  }

  private async executeRelay(objective: string): Promise<void> {
    this.emit(EventType.ModeSwitched, { mode: Mode.Relay });
  }

  private async executeSwarm(objective: string): Promise<void> {
    this.emit(EventType.ModeSwitched, { mode: Mode.Swarm });
  }

  private emit(type: EventType, payload: Record<string, unknown> = {}): void {
    const event: KernelEvent = { type, timestamp: new Date(), payload };
    this.eventBus.emit(event);
    this.triggerEngine.fire(event).catch((err) => {
      console.error(`Trigger engine error for ${type}:`, err);
    });
  }
}
