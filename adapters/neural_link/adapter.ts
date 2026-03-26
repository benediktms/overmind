import type { NeuralLinkConfig } from "../../kernel/types.ts";
import { NeuralLinkError } from "../../kernel/errors.ts";

export enum MessageKind {
  Finding = "finding",
  Handoff = "handoff",
  Blocker = "blocker",
  Decision = "decision",
  Question = "question",
  Answer = "answer",
  ReviewRequest = "review_request",
  ReviewResult = "review_result",
  ArtifactRef = "artifact_ref",
  Summary = "summary",
  Challenge = "challenge",
  Proposal = "proposal",
  Escalation = "escalation",
}

export interface RoomOpenParams {
  title: string;
  participantId: string;
  displayName: string;
  purpose?: string;
  externalRef?: string;
  tags?: string;
  brains?: string;
  interactionMode?: string;
}

export interface MessageSendParams {
  roomId: string;
  from: string;
  kind: MessageKind;
  summary: string;
  to?: string;
  body?: string;
  threadId?: string;
  persistHint?: string;
}

export class NeuralLinkAdapter {
  private config: NeuralLinkConfig | null = null;
  private connected = false;
  private sessionId: string | null = null;

  async connect(config: NeuralLinkConfig): Promise<void> {
    if (!config.enabled) return;

    this.config = config;

    try {
      const response = await fetch(`${config.httpUrl}/health`);
      if (response.ok) {
        this.connected = true;
      }
    } catch (err) {
      console.warn("neural_link not available, running without coordination:", err);
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async roomOpen(params: RoomOpenParams): Promise<string | null> {
    if (!this.connected) return null;

    const response = await fetch(`${this.config!.httpUrl}/room/open`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify({
        title: params.title,
        participant_id: params.participantId,
        display_name: params.displayName,
        purpose: params.purpose ?? "",
        external_ref: params.externalRef ?? "",
        tags: params.tags ?? "",
        brains: params.brains ?? "",
        interaction_mode: params.interactionMode ?? "",
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as { room_id?: string; session_id?: string };
    if (data.session_id) this.sessionId = data.session_id;
    return data.room_id ?? null;
  }

  async roomJoin(
    roomId: string,
    participantId: string,
    displayName: string,
    role = "member",
  ): Promise<boolean> {
    if (!this.connected) return false;

    const response = await fetch(`${this.config!.httpUrl}/room/join`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify({
        room_id: roomId,
        participant_id: participantId,
        display_name: displayName,
        role,
      }),
    });

    return response.ok;
  }

  async messageSend(params: MessageSendParams): Promise<boolean> {
    if (!this.connected) return false;

    const response = await fetch(`${this.config!.httpUrl}/message/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify({
        room_id: params.roomId,
        from: params.from,
        kind: params.kind,
        summary: params.summary,
        to: params.to ?? "",
        body: params.body ?? "",
        thread_id: params.threadId ?? "",
        persist_hint: params.persistHint ?? "",
      }),
    });

    return response.ok;
  }

  async inboxRead(roomId: string, participantId: string): Promise<unknown[]> {
    if (!this.connected) return [];

    const response = await fetch(
      `${this.config!.httpUrl}/inbox/${participantId}?room_id=${roomId}`,
      {
        headers: {
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
      },
    );

    if (!response.ok) return [];
    const data = await response.json() as { messages?: unknown[] };
    return data.messages ?? [];
  }

  async messageAck(roomId: string, participantId: string, messageIds: string): Promise<boolean> {
    if (!this.connected) return false;

    const response = await fetch(`${this.config!.httpUrl}/message/ack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify({
        room_id: roomId,
        participant_id: participantId,
        message_ids: messageIds,
      }),
    });

    return response.ok;
  }

  async roomClose(roomId: string, resolution: string): Promise<boolean> {
    if (!this.connected) return false;

    const response = await fetch(`${this.config!.httpUrl}/room/close`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify({
        room_id: roomId,
        resolution,
      }),
    });

    return response.ok;
  }

  async waitFor(
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<unknown | null> {
    if (!this.connected) return null;

    const params = new URLSearchParams({
      room_id: roomId,
      participant_id: participantId,
      timeout_ms: String(timeoutMs),
    });
    if (kinds) params.set("kinds", kinds.join(","));
    if (from) params.set("from", from.join(","));

    const response = await fetch(
      `${this.config!.httpUrl}/wait_for?${params}`,
      {
        headers: {
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
      },
    );

    if (!response.ok) return null;
    const data = await response.json();
    return data.message ?? null;
  }
}
