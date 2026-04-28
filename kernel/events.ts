import { EventType } from "./types.ts";

export { EventType };

export interface KernelEvent {
  type: EventType;
  timestamp: Date;
  payload: Record<string, unknown>;
}

export class EventBus {
  private listeners: Map<EventType, Array<(event: KernelEvent) => void>> =
    new Map();
  private history: KernelEvent[] = [];
  private maxHistory = 100;

  on(event: EventType, handler: (event: KernelEvent) => void): () => void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
    return () => {
      const h = this.listeners.get(event) ?? [];
      this.listeners.set(event, h.filter((x) => x !== handler));
    };
  }

  once(event: EventType, handler: (event: KernelEvent) => void): () => void {
    const off = this.on(event, (e) => {
      handler(e);
      off();
    });
    return off;
  }

  emit(event: KernelEvent): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    const handlers = this.listeners.get(event.type) ?? [];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error(`Error in event handler for ${event.type}:`, err);
      }
    }
  }

  getHistory(): KernelEvent[] {
    return [...this.history];
  }
}
