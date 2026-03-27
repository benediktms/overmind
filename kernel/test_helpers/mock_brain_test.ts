import { assertEquals } from "@std/assert";

import { MessageKind, MockNeuralLinkAdapter } from "./mock_neural_link.ts";
import { MockBrainAdapter } from "./mock_brain.ts";

Deno.test("MockBrainAdapter records task mutation calls", async () => {
  const brain = new MockBrainAdapter();

  await brain.taskComment("BRN-123", "note added");
  await brain.taskAddExternalId("BRN-123", "JIRA-99");
  await brain.taskSetPriority("BRN-123", 2);

  assertEquals(brain.calls, [
    { method: "taskComment", args: ["BRN-123", "note added"] },
    { method: "taskAddExternalId", args: ["BRN-123", "JIRA-99"] },
    { method: "taskSetPriority", args: ["BRN-123", 2] },
  ]);
});

Deno.test("MockBrainAdapter records core methods too", async () => {
  const brain = new MockBrainAdapter();

  await brain.connect({ enabled: true, brainName: "brain", taskPrefix: "BRN" });
  const taskId = await brain.taskCreate({ title: "task" });
  const connected = brain.isConnected();
  await brain.disconnect();

  assertEquals(taskId, "BRN-MOCK-1");
  assertEquals(connected, true);
  assertEquals(brain.calls.map((call) => call.method), ["connect", "taskCreate", "isConnected", "disconnect"]);
});

Deno.test("MockNeuralLinkAdapter records room and wait calls", async () => {
  const neuralLink = new MockNeuralLinkAdapter();

  await neuralLink.connect({ enabled: true, httpUrl: "http://localhost", roomTtlSeconds: 60 });
  const roomId = await neuralLink.roomOpen({
    title: "coordination",
    participantId: "agent-1",
    displayName: "Agent One",
  });
  await neuralLink.messageSend({
    roomId: roomId ?? "room-mock-1",
    from: "agent-1",
    kind: MessageKind.Finding,
    summary: "found something",
  });
  const message = await neuralLink.waitFor(roomId ?? "room-mock-1", "agent-1", 1000, ["finding"], ["lead"]);

  assertEquals(roomId, "room-mock-1");
  assertEquals(message, null);
  assertEquals(neuralLink.calls.map((call) => call.method), ["connect", "roomOpen", "messageSend", "waitFor"]);
});
