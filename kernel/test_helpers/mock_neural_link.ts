import { MessageKind } from "../../adapters/neural_link/adapter.ts";
import type { NeuralLinkConfig, WaitForMessage, InboxMessage, RoomSummary } from "../../kernel/types.ts";

import type { MockCall } from "./mock_brain.ts";

export { MessageKind };

export class MockNeuralLinkAdapter {
  calls: MockCall[] = [];
  connected = false;
  sessionId: string | null = null;
  nextRoomId: string | null = "room-mock-1";
  roomOpenResult: string | null = "room-mock-1";
  roomJoinResult = true;
  roomLeaveResult = true;
  messageSendResult = true;
  inboxReadResult: InboxMessage[] = [];
  messageAckResult = true;
  roomCloseResult = true;
  waitForResult: WaitForMessage | null = null;
  threadSummarizeResult: RoomSummary | null = null;

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

  async roomLeave(
    roomId: string,
    participantId: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    this.calls.push({ method: "roomLeave", args: [roomId, participantId, timeoutMs] });
    return this.roomLeaveResult;
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

  async inboxRead(roomId: string, participantId: string): Promise<InboxMessage[]> {
    this.calls.push({ method: "inboxRead", args: [roomId, participantId] });
    return this.inboxReadResult;
  }

  async messageAck(roomId: string, participantId: string, messageIds: string[]): Promise<boolean> {
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
  ): Promise<WaitForMessage | null> {
    this.calls.push({ method: "waitFor", args: [roomId, participantId, timeoutMs, kinds, from] });
    return this.waitForResult;
  }

  async threadSummarize(
    roomId: string,
    threadId?: string,
  ): Promise<RoomSummary | null> {
    this.calls.push({ method: "threadSummarize", args: [roomId, threadId] });
    return this.threadSummarizeResult;
  }
}
