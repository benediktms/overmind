import { MessageKind } from "../../adapters/neural_link/adapter.ts";
import type { NeuralLinkConfig } from "../../kernel/types.ts";

import type { MockCall } from "./mock_brain.ts";

export { MessageKind };

export class MockNeuralLinkAdapter {
  calls: MockCall[] = [];
  connected = false;
  sessionId: string | null = null;
  nextRoomId: string | null = "room-mock-1";
  roomOpenResult: string | null = "room-mock-1";
  roomJoinResult = true;
  messageSendResult = true;
  inboxReadResult: unknown[] = [];
  messageAckResult = true;
  roomCloseResult = true;
  waitForResult: unknown | null = null;

  async connect(config: NeuralLinkConfig): Promise<void> {
    this.calls.push({ method: "connect", args: [config] });
    this.connected = config.enabled;
  }

  isConnected(): boolean {
    this.calls.push({ method: "isConnected", args: [] });
    return this.connected;
  }

  getSessionId(): string | null {
    this.calls.push({ method: "getSessionId", args: [] });
    return this.sessionId;
  }

  async roomOpen(params: {
    title: string;
    participantId: string;
    displayName: string;
    purpose?: string;
    externalRef?: string;
    tags?: string;
    brains?: string;
    interactionMode?: string;
  }): Promise<string | null> {
    this.calls.push({ method: "roomOpen", args: [params] });
    return this.roomOpenResult;
  }

  async roomJoin(
    roomId: string,
    participantId: string,
    displayName: string,
    role = "member",
  ): Promise<boolean> {
    this.calls.push({ method: "roomJoin", args: [roomId, participantId, displayName, role] });
    return this.roomJoinResult;
  }

  async messageSend(params: {
    roomId: string;
    from: string;
    kind: MessageKind;
    summary: string;
    to?: string;
    body?: string;
    threadId?: string;
    persistHint?: string;
  }): Promise<boolean> {
    this.calls.push({ method: "messageSend", args: [params] });
    return this.messageSendResult;
  }

  async inboxRead(roomId: string, participantId: string): Promise<unknown[]> {
    this.calls.push({ method: "inboxRead", args: [roomId, participantId] });
    return this.inboxReadResult;
  }

  async messageAck(roomId: string, participantId: string, messageIds: string): Promise<boolean> {
    this.calls.push({ method: "messageAck", args: [roomId, participantId, messageIds] });
    return this.messageAckResult;
  }

  async roomClose(roomId: string, resolution: string): Promise<boolean> {
    this.calls.push({ method: "roomClose", args: [roomId, resolution] });
    return this.roomCloseResult;
  }

  async waitFor(
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<unknown | null> {
    this.calls.push({ method: "waitFor", args: [roomId, participantId, timeoutMs, kinds, from] });
    return this.waitForResult;
  }
}
