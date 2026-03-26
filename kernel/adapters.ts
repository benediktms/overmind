import { Kernel } from "./kernel.ts";
import { BrainAdapter, TaskCreateParams, TaskUpdateParams, MemoryEpisodeParams } from "../adapters/brain/adapter.ts";
import { NeuralLinkAdapter, MessageKind } from "../adapters/neural_link/adapter.ts";
import { EventType } from "./types.ts";

export class AdapterRegistry {
  private brain: BrainAdapter;
  private neuralLink: NeuralLinkAdapter;
  private kernel: Kernel;
  private currentRoomId: string | null = null;

  constructor(kernel: Kernel) {
    this.kernel = kernel;
    this.brain = new BrainAdapter();
    this.neuralLink = new NeuralLinkAdapter();
  }

  async connect(): Promise<void> {
    const config = this.kernel.getConfig();
    await Promise.all([
      this.brain.connect(config.brain),
      this.neuralLink.connect(config.neuralLink),
    ]);
    this.registerTriggerAdapters();
  }

  async disconnect(): Promise<void> {
    await Promise.all([
      this.brain.disconnect(),
    ]);
    this.currentRoomId = null;
  }

  private registerTriggerAdapters(): void {
    const engine = this.kernel.getTriggerEngine();

    engine.registerAdapter("brain_task_create", async (params) => {
      const p = params as unknown as TaskCreateParams;
      await this.brain.taskCreate({
        title: p.title ?? "Untitled",
        description: p.description as string | undefined,
        priority: p.priority as number | undefined,
        taskType: p.taskType as string | undefined,
        parentTaskId: p.parentTaskId as string | undefined,
      });
    });

    engine.registerAdapter("brain_task_update", async (params) => {
      const p = params as unknown as TaskUpdateParams;
      await this.brain.taskUpdate({
        taskId: p.taskId ?? "",
        status: p.status as string | undefined,
        priority: p.priority as number | undefined,
      });
    });

    engine.registerAdapter("brain_task_complete", async (params) => {
      const taskId = params.taskId as string;
      if (taskId) await this.brain.taskComplete(taskId);
    });

    engine.registerAdapter("brain_memory_episode", async (params) => {
      const p = params as unknown as MemoryEpisodeParams;
      await this.brain.memoryEpisode({
        goal: p.goal ?? "",
        actions: p.actions ?? "",
        outcome: p.outcome ?? "",
        tags: p.tags as string[] | undefined,
        importance: p.importance as number | undefined,
      });
    });

    engine.registerAdapter("neural_link_room_open", async (params) => {
      const config = this.kernel.getConfig();
      const p = params as { roomId?: string; title?: string; participantId?: string; displayName?: string };
      if (this.currentRoomId) return;

      const roomId = await this.neuralLink.roomOpen({
        title: p.title ?? `overmind-${Date.now()}`,
        participantId: p.participantId ?? "overmind-lead",
        displayName: p.displayName ?? "Overmind Lead",
      });

      if (roomId) {
        this.currentRoomId = roomId;
        this.kernel.getEventBus().emit({
          type: EventType.RoomOpened,
          timestamp: new Date(),
          payload: { roomId },
        });
      }
    });

    engine.registerAdapter("neural_link_room_close", async () => {
      if (this.currentRoomId) {
        await this.neuralLink.roomClose(this.currentRoomId, "completed");
        this.kernel.getEventBus().emit({
          type: EventType.RoomClosed,
          timestamp: new Date(),
          payload: { roomId: this.currentRoomId },
        });
        this.currentRoomId = null;
      }
    });

    engine.registerAdapter("neural_link_message", async (params) => {
      const p = params as { roomId?: string; from?: string; kind?: MessageKind; summary?: string; body?: string; to?: string };
      if (!this.currentRoomId) return;
      await this.neuralLink.messageSend({
        roomId: p.roomId ?? this.currentRoomId,
        from: p.from ?? "overmind",
        kind: p.kind ?? MessageKind.Finding,
        summary: p.summary ?? "",
        body: p.body ?? "",
        to: p.to,
      });
    });
  }

  getBrain(): BrainAdapter {
    return this.brain;
  }

  getNeuralLink(): NeuralLinkAdapter {
    return this.neuralLink;
  }

  getCurrentRoomId(): string | null {
    return this.currentRoomId;
  }
}
