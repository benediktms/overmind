import type { BrainConfig } from "../../kernel/types.ts";

export interface MockCall {
  method: string;
  args: unknown[];
}

export class MockBrainAdapter {
  calls: MockCall[] = [];
  connected = false;
  nextTaskId: string | null = "BRN-MOCK-1";
  taskCreateResult: string | null = "BRN-MOCK-1";
  taskUpdateResult = true;
  taskCompleteResult = true;
  taskCommentResult = true;
  taskAddExternalIdResult = true;
  taskSetPriorityResult = true;
  memoryEpisodeResult = true;

  async connect(config: BrainConfig): Promise<void> {
    this.calls.push({ method: "connect", args: [config] });
    this.connected = config.enabled;
  }

  async disconnect(): Promise<void> {
    this.calls.push({ method: "disconnect", args: [] });
    this.connected = false;
  }

  isConnected(): boolean {
    this.calls.push({ method: "isConnected", args: [] });
    return this.connected;
  }

  async taskCreate(params: {
    title: string;
    description?: string;
    priority?: number;
    taskType?: string;
    parentTaskId?: string;
  }): Promise<string | null> {
    this.calls.push({ method: "taskCreate", args: [params] });
    return this.taskCreateResult;
  }

  async taskUpdate(params: {
    taskId: string;
    status?: string;
    priority?: number;
  }): Promise<boolean> {
    this.calls.push({ method: "taskUpdate", args: [params] });
    return this.taskUpdateResult;
  }

  async taskComplete(taskId: string): Promise<boolean> {
    this.calls.push({ method: "taskComplete", args: [taskId] });
    return this.taskCompleteResult;
  }

  async taskComment(taskId: string, comment: string): Promise<boolean> {
    this.calls.push({ method: "taskComment", args: [taskId, comment] });
    return this.taskCommentResult;
  }

  async taskAddExternalId(taskId: string, externalId: string): Promise<boolean> {
    this.calls.push({ method: "taskAddExternalId", args: [taskId, externalId] });
    return this.taskAddExternalIdResult;
  }

  async taskSetPriority(taskId: string, priority: number): Promise<boolean> {
    this.calls.push({ method: "taskSetPriority", args: [taskId, priority] });
    return this.taskSetPriorityResult;
  }

  async memoryEpisode(params: {
    goal: string;
    actions: string;
    outcome: string;
    tags?: string[];
    importance?: number;
  }): Promise<boolean> {
    this.calls.push({ method: "memoryEpisode", args: [params] });
    return this.memoryEpisodeResult;
  }
}
