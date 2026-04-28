import { EventType } from "./types.ts";
import type { KernelEvent } from "./events.ts";

export interface TriggerAction {
  type: string;
  params: Record<string, unknown>;
}

export interface Trigger {
  event: EventType;
  condition?: (event: KernelEvent) => boolean;
  actions: Array<TriggerAction | string>;
}

export class TriggerEngine {
  private triggers: Trigger[] = [];
  private adapters: Map<
    string,
    (params: Record<string, unknown>) => Promise<void>
  > = new Map();

  registerAdapter(
    name: string,
    fn: (params: Record<string, unknown>) => Promise<void>,
  ): void {
    this.adapters.set(name, fn);
  }

  addTrigger(trigger: Trigger): void {
    this.triggers.push(trigger);
  }

  async fire(event: KernelEvent): Promise<void> {
    for (const trigger of this.triggers) {
      if (trigger.event !== event.type) continue;
      if (trigger.condition && !trigger.condition(event)) continue;

      for (const action of trigger.actions) {
        if (typeof action === "string") {
          const adapter = this.adapters.get(action);
          if (adapter) {
            await adapter(event.payload);
          }
        } else {
          const adapter = this.adapters.get(action.type);
          if (adapter) {
            await adapter(action.params);
          }
        }
      }
    }
  }

  clear(): void {
    this.triggers = [];
  }
}

export const DEFAULT_TRIGGERS: Trigger[] = [
  {
    event: EventType.ObjectiveReceived,
    actions: [
      { type: "brain_task_create", params: {} },
      { type: "neural_link_room_open", params: {} },
    ],
  },
  {
    event: EventType.AgentStartedWorking,
    actions: [
      { type: "brain_task_update", params: {} },
    ],
  },
  {
    event: EventType.AgentFinished,
    actions: [
      { type: "brain_task_complete", params: {} },
    ],
  },
  {
    event: EventType.ExternalDiscovery,
    actions: [
      { type: "brain_memory_episode", params: {} },
    ],
  },
  {
    event: EventType.DecisionMade,
    actions: [
      { type: "brain_memory_episode", params: {} },
    ],
  },
  {
    event: EventType.KernelShutdown,
    actions: [
      { type: "neural_link_room_close", params: {} },
    ],
  },
];
