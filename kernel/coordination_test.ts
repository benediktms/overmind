import { assertEquals, assertRejects } from "@std/assert";
import {
  drainInbox,
  waitAndProcessInbox,
  withParticipation,
} from "./coordination.ts";
import type {
  CoordinationPort,
  InboxMessage,
  WaitForMessage,
} from "./coordination.ts";
import { MessageKind } from "../adapters/neural_link/adapter.ts";

// ---------------------------------------------------------------------------
// Mock CoordinationPort
// ---------------------------------------------------------------------------

interface MockCall {
  method: string;
  args: unknown[];
}

class MockCoordinationPort implements CoordinationPort {
  calls: MockCall[] = [];
  connected = true;
  inboxMessages: InboxMessage[] = [];
  messageAckResult = true;
  messageSendResult = true;
  roomJoinResult = true;
  roomLeaveResult = true;
  // Queue of waitFor results — each call pops from the front
  waitForQueue: Array<WaitForMessage | null> = [];

  isConnected(): boolean {
    this.calls.push({ method: "isConnected", args: [] });
    return this.connected;
  }

  async inboxRead(roomId: string, participantId: string): Promise<InboxMessage[]> {
    this.calls.push({ method: "inboxRead", args: [roomId, participantId] });
    return this.inboxMessages;
  }

  async messageAck(roomId: string, participantId: string, messageIds: string[]): Promise<boolean> {
    this.calls.push({ method: "messageAck", args: [roomId, participantId, messageIds] });
    return this.messageAckResult;
  }

  async messageSend(params: {
    roomId: string;
    from: string;
    kind: MessageKind;
    summary: string;
    to?: string;
    body?: string;
    threadId?: string;
  }): Promise<boolean> {
    this.calls.push({ method: "messageSend", args: [params] });
    return this.messageSendResult;
  }

  async waitFor(
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<WaitForMessage | null> {
    this.calls.push({ method: "waitFor", args: [roomId, participantId, timeoutMs, kinds, from] });
    if (this.waitForQueue.length > 0) {
      return this.waitForQueue.shift()!;
    }
    return null;
  }

  async roomJoin(roomId: string, participantId: string, displayName: string, role?: string): Promise<boolean> {
    this.calls.push({ method: "roomJoin", args: [roomId, participantId, displayName, role] });
    return this.roomJoinResult;
  }

  async roomLeave(roomId: string, participantId: string, timeoutMs?: number): Promise<boolean> {
    this.calls.push({ method: "roomLeave", args: [roomId, participantId, timeoutMs] });
    return this.roomLeaveResult;
  }
}

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    message_id: "msg-1",
    from: "agent-a",
    kind: "finding",
    summary: "test message",
    sequence: 1,
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeWaitForMessage(overrides: Partial<WaitForMessage> = {}): WaitForMessage {
  return {
    message_id: "msg-1",
    from: "agent-a",
    kind: "finding",
    summary: "test message",
    sequence: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// drainInbox tests
// ---------------------------------------------------------------------------

Deno.test("drainInbox: empty inbox returns 0", async () => {
  const port = new MockCoordinationPort();
  port.inboxMessages = [];

  const count = await drainInbox(port, "room-1", "participant-1", async () => {});

  assertEquals(count, 0);
});

Deno.test("drainInbox: 3 messages calls handler 3 times, acks all IDs in one batch, returns 3", async () => {
  const port = new MockCoordinationPort();
  port.inboxMessages = [
    makeMessage({ message_id: "msg-1" }),
    makeMessage({ message_id: "msg-2" }),
    makeMessage({ message_id: "msg-3" }),
  ];

  const handledIds: string[] = [];
  const count = await drainInbox(port, "room-1", "participant-1", async (msg) => {
    handledIds.push(msg.message_id);
  });

  assertEquals(count, 3);
  assertEquals(handledIds, ["msg-1", "msg-2", "msg-3"]);

  const ackCall = port.calls.find((c) => c.method === "messageAck");
  assertEquals(ackCall?.args[2], ["msg-1", "msg-2", "msg-3"]);

  // Only one ack call (batch)
  assertEquals(port.calls.filter((c) => c.method === "messageAck").length, 1);
});

Deno.test("drainInbox: disconnected port returns 0", async () => {
  const port = new MockCoordinationPort();
  port.connected = false;
  port.inboxMessages = [makeMessage()];

  const handlerCalled: boolean[] = [];
  const count = await drainInbox(port, "room-1", "participant-1", async () => {
    handlerCalled.push(true);
  });

  assertEquals(count, 0);
  assertEquals(handlerCalled.length, 0);
});

Deno.test("drainInbox: handler error propagates", async () => {
  const port = new MockCoordinationPort();
  port.inboxMessages = [makeMessage({ message_id: "msg-1" })];

  await assertRejects(
    async () => {
      await drainInbox(port, "room-1", "participant-1", async (_msg) => {
        throw new Error("handler failure");
      });
    },
    Error,
    "handler failure",
  );
});

// ---------------------------------------------------------------------------
// waitAndProcessInbox tests
// ---------------------------------------------------------------------------

Deno.test("waitAndProcessInbox: direct match on first waitFor returns the message", async () => {
  const port = new MockCoordinationPort();
  const expected = makeWaitForMessage({ kind: "handoff", message_id: "msg-handoff" });
  port.waitForQueue = [expected];

  const result = await waitAndProcessInbox(port, "room-1", "participant-1", ["handoff"]);

  assertEquals(result, expected);
});

Deno.test("waitAndProcessInbox: interleaved message calls onInterleaved, acks it, then returns expected message", async () => {
  const port = new MockCoordinationPort();
  const interleaved = makeWaitForMessage({ kind: "blocker", message_id: "msg-blocker" });
  const expected = makeWaitForMessage({ kind: "handoff", message_id: "msg-handoff" });
  port.waitForQueue = [interleaved, expected];

  const interleavedMessages: WaitForMessage[] = [];
  const result = await waitAndProcessInbox(port, "room-1", "participant-1", ["handoff"], {
    onInterleaved: async (msg) => {
      interleavedMessages.push(msg);
    },
  });

  assertEquals(result, expected);
  assertEquals(interleavedMessages.length, 1);
  assertEquals(interleavedMessages[0].message_id, "msg-blocker");

  // Ack called for the interleaved message
  const ackCalls = port.calls.filter((c) => c.method === "messageAck");
  assertEquals(ackCalls.length, 1);
  assertEquals(ackCalls[0].args[2], ["msg-blocker"]);
});

Deno.test("waitAndProcessInbox: timeout (waitFor returns null) returns null", async () => {
  const port = new MockCoordinationPort();
  port.waitForQueue = [null];

  const result = await waitAndProcessInbox(port, "room-1", "participant-1", ["handoff"]);

  assertEquals(result, null);
});

Deno.test("waitAndProcessInbox: max iterations guard returns null after N interleaved messages", async () => {
  const port = new MockCoordinationPort();
  // Fill queue with interleaved messages beyond maxIterations
  port.waitForQueue = Array.from({ length: 5 }, (_, i) =>
    makeWaitForMessage({ kind: "blocker", message_id: `msg-${i}` })
  );

  const result = await waitAndProcessInbox(port, "room-1", "participant-1", ["handoff"], {
    maxIterations: 3,
  });

  assertEquals(result, null);
  // waitFor called exactly 3 times (maxIterations)
  assertEquals(port.calls.filter((c) => c.method === "waitFor").length, 3);
});

Deno.test("waitAndProcessInbox: no onInterleaved callback still acks interleaved messages and continues", async () => {
  const port = new MockCoordinationPort();
  const interleaved = makeWaitForMessage({ kind: "blocker", message_id: "msg-blocker" });
  const expected = makeWaitForMessage({ kind: "handoff", message_id: "msg-handoff" });
  port.waitForQueue = [interleaved, expected];

  const result = await waitAndProcessInbox(port, "room-1", "participant-1", ["handoff"]);

  assertEquals(result, expected);

  const ackCalls = port.calls.filter((c) => c.method === "messageAck");
  assertEquals(ackCalls.length, 1);
  assertEquals(ackCalls[0].args[2], ["msg-blocker"]);
});

// ---------------------------------------------------------------------------
// withParticipation tests
// ---------------------------------------------------------------------------

Deno.test("withParticipation: happy path joins, runs work, sends handoff with success summary, leaves, returns work result", async () => {
  const port = new MockCoordinationPort();

  const result = await withParticipation(
    port,
    "room-1",
    { id: "agent-1", displayName: "Agent One", role: "executor" },
    async (_ctx) => {
      return 42;
    },
  );

  assertEquals(result, 42);

  const joinCall = port.calls.find((c) => c.method === "roomJoin");
  assertEquals(joinCall?.args[0], "room-1");
  assertEquals(joinCall?.args[1], "agent-1");

  const sendCall = port.calls.find((c) => c.method === "messageSend");
  const sendParams = sendCall?.args[0] as { kind: string; summary: string; from: string };
  assertEquals(sendParams.kind, MessageKind.Handoff);
  assertEquals(sendParams.summary, "Work completed successfully");
  assertEquals(sendParams.from, "agent-1");

  const leaveCall = port.calls.find((c) => c.method === "roomLeave");
  assertEquals(leaveCall?.args[0], "room-1");
  assertEquals(leaveCall?.args[1], "agent-1");
});

Deno.test("withParticipation: join failure throws without calling work or leave", async () => {
  const port = new MockCoordinationPort();
  port.roomJoinResult = false;

  let workCalled = false;

  await assertRejects(
    async () => {
      await withParticipation(
        port,
        "room-1",
        { id: "agent-1", displayName: "Agent One" },
        async (_ctx) => {
          workCalled = true;
          return "done";
        },
      );
    },
    Error,
    "Failed to join room room-1 as agent-1",
  );

  assertEquals(workCalled, false);
  assertEquals(port.calls.filter((c) => c.method === "roomLeave").length, 0);
});

Deno.test("withParticipation: work error still sends handoff with error message, still calls roomLeave, then re-throws", async () => {
  const port = new MockCoordinationPort();

  await assertRejects(
    async () => {
      await withParticipation(
        port,
        "room-1",
        { id: "agent-1", displayName: "Agent One" },
        async (_ctx) => {
          throw new Error("work failed");
        },
      );
    },
    Error,
    "work failed",
  );

  const sendCall = port.calls.find((c) => c.method === "messageSend");
  const sendParams = sendCall?.args[0] as { kind: string; summary: string };
  assertEquals(sendParams.kind, MessageKind.Handoff);
  assertEquals(sendParams.summary, "Error: work failed");

  assertEquals(port.calls.filter((c) => c.method === "roomLeave").length, 1);
});

Deno.test("withParticipation: handoff message has kind 'handoff' and from is participant.id", async () => {
  const port = new MockCoordinationPort();

  await withParticipation(
    port,
    "room-1",
    { id: "my-agent", displayName: "My Agent" },
    async (_ctx) => "result",
  );

  const sendCall = port.calls.find((c) => c.method === "messageSend");
  const sendParams = sendCall?.args[0] as { kind: string; from: string };
  assertEquals(sendParams.kind, "handoff");
  assertEquals(sendParams.from, "my-agent");
});
