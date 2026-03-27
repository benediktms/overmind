import { McpStdioClient } from "./stdio_client.ts";
import { McpError, McpErrorCode } from "./mcp_protocol.ts";
import type { BrainConfig } from "../../kernel/types.ts";
import { BrainError } from "../../kernel/errors.ts";

export interface TaskCreateParams {
  title: string;
  description?: string;
  priority?: number;
  taskType?: string;
  parentTaskId?: string;
}

export interface TaskUpdateParams {
  taskId: string;
  status?: string;
  priority?: number;
}

export interface MemoryEpisodeParams {
  goal: string;
  actions: string;
  outcome: string;
  tags?: string[];
  importance?: number;
}

export class BrainAdapter {
  private client: McpStdioClient | null = null;
  private config: BrainConfig | null = null;
  private connected = false;

  async connect(config: BrainConfig): Promise<void> {
    if (!config.enabled) return;

    this.config = config;
    this.client = new McpStdioClient();

    try {
      await this.client.connect({
        command: ["brain", "mcp"],
        env: {},
      });
      this.connected = true;
    } catch (err) {
      console.warn("Brain MCP connection failed, running without brain:", err);
      this.connected = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async taskCreate(params: TaskCreateParams): Promise<string | null> {
    if (!this.connected || !this.client) return null;
    try {
      const result = await this.client.callTool("tasks_create", {
        title: params.title,
        description: params.description,
        priority: params.priority,
        task_type: params.taskType,
        parent: params.parentTaskId,
      }) as { task_id?: string };
      return result?.task_id ?? null;
    } catch (err) {
      console.error("Brain task_create failed:", err);
      return null;
    }
  }

  async taskUpdate(params: TaskUpdateParams): Promise<boolean> {
    if (!this.connected || !this.client) return false;
    try {
      const statusMap: Record<string, string> = {
        in_progress: "in_progress",
        done: "done",
        blocked: "blocked",
        open: "open",
      };
      await this.client.callTool("tasks_apply_event", {
        task_id: params.taskId,
        event_type: "status_changed",
        payload: { new_status: statusMap[params.status ?? ""] ?? params.status },
      });
      return true;
    } catch (err) {
      console.error("Brain task_update failed:", err);
      return false;
    }
  }

  async taskComplete(taskId: string): Promise<boolean> {
    if (!this.connected || !this.client) return false;
    try {
      await this.client.callTool("tasks_close", { task_ids: taskId });
      return true;
    } catch (err) {
      console.error("Brain task_complete failed:", err);
      return false;
    }
  }

  async taskComment(taskId: string, comment: string): Promise<boolean> {
    if (!this.connected || !this.client) return false;
    try {
      await this.client.callTool("tasks_apply_event", {
        task_id: taskId,
        event_type: "comment_added",
        payload: { body: comment },
      });
      return true;
    } catch (err) {
      console.error("Brain task_comment failed:", err);
      return false;
    }
  }

  async taskAddExternalId(taskId: string, externalId: string): Promise<boolean> {
    if (!this.connected || !this.client) return false;
    try {
      await this.client.callTool("tasks_apply_event", {
        task_id: taskId,
        event_type: "external_id_added",
        payload: {
          source: this.config?.brainName ?? "overmind",
          external_id: externalId,
        },
      });
      return true;
    } catch (err) {
      console.error("Brain task_add_external_id failed:", err);
      return false;
    }
  }

  async taskSetPriority(taskId: string, priority: number): Promise<boolean> {
    if (!this.connected || !this.client) return false;
    try {
      await this.client.callTool("tasks_apply_event", {
        task_id: taskId,
        event_type: "task_updated",
        payload: { priority },
      });
      return true;
    } catch (err) {
      console.error("Brain task_set_priority failed:", err);
      return false;
    }
  }

  async memoryEpisode(params: MemoryEpisodeParams): Promise<boolean> {
    if (!this.connected || !this.client) return false;
    try {
      await this.client.callTool("memory_write_episode", {
        goal: params.goal,
        actions: params.actions,
        outcome: params.outcome,
        tags: params.tags ?? [],
        importance: params.importance ?? 1,
      });
      return true;
    } catch (err) {
      console.error("Brain memory_episode failed:", err);
      return false;
    }
  }
}
