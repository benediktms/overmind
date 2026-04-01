import { assertEquals } from "@std/assert";

import { MessageKind } from "../../adapters/neural_link/adapter.ts";
import { RunState, type RunContext } from "../types.ts";
import type { WaitForMessage } from "../types.ts";
import { MockBrainAdapter, type MockCall } from "../test_helpers/mock_brain.ts";
import { MockNeuralLinkAdapter } from "../test_helpers/mock_neural_link.ts";
import { createRunContext } from "./shared.ts";
import { executeRelay } from "./relay.ts";

function makeContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    ...createRunContext({
      run_id: "run-relay-1",
      mode: "relay" as RunContext["mode"],
      objective: "Implement relay mode orchestration for a sample objective",
      workspace: "/tmp/overmind",
      brain_task_id: "BRN-SEED-1",
      room_id: "room-seed-1",
    }),
    ...overrides,
  };
}

function mockWaitForQueue(neuralLink: MockNeuralLinkAdapter, values: Array<unknown>): void {
  const queue = [...values];
  neuralLink.waitFor = async (
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<WaitForMessage | null> => {
    neuralLink.calls.push({ method: "waitFor", args: [roomId, participantId, timeoutMs, kinds, from] });
    return (queue.shift() ?? null) as WaitForMessage | null;
  };
}

function callsByMethod(calls: MockCall[], method: string): MockCall[] {
  return calls.filter((call) => call.method === method);
}

function makeAllPassWaitQueue(): Array<unknown> {
  return [
    { from: "cortex", summary: "Step 1 handoff complete" },
    { passed: true, details: "Step 1 verify passed" },
    { from: "probe", summary: "Step 2 handoff complete" },
    { passed: true, details: "Step 2 verify passed" },
    { from: "liaison", summary: "Step 3 handoff complete" },
    { passed: true, details: "Step 3 verify passed" },
  ];
}

Deno.test("executeRelay creates brain task with relay-prefixed title", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeAllPassWaitQueue());

  await executeRelay(makeContext(), brain, neuralLink);

  const taskCreate = callsByMethod(brain.calls, "taskCreate")[0];
  assertEquals(
    taskCreate.args[0],
    {
      title: "[overmind:relay] Implement relay mode orchestration for a sample objective",
    },
  );
});

Deno.test("executeRelay adds external run ID to created task", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeAllPassWaitQueue());

  await executeRelay(makeContext({ run_id: "run-relay-ext-9" }), brain, neuralLink);

  const externalCall = callsByMethod(brain.calls, "taskAddExternalId")[0];
  assertEquals(externalCall.args[0], "BRN-MOCK-1");
  assertEquals(externalCall.args[1], "overmind_run_id:run-relay-ext-9");
});

Deno.test("executeRelay opens room with relay lead identity", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeAllPassWaitQueue());

  await executeRelay(makeContext({ run_id: "run-relay-room-3" }), brain, neuralLink);

  const roomOpen = callsByMethod(neuralLink.calls, "roomOpen")[0];
  const params = roomOpen.args[0] as { title: string; participantId: string; displayName: string };
  assertEquals(params.title.includes("run-relay-room-3"), true);
  assertEquals(params.participantId, "overmind-relay-lead");
  assertEquals(params.displayName, "Overmind Relay Lead");
});

Deno.test("executeRelay dispatches execute and verify messages for each of three steps", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeAllPassWaitQueue());

  await executeRelay(makeContext(), brain, neuralLink);

  const messages = callsByMethod(neuralLink.calls, "messageSend");
  assertEquals(messages.length, 6);

  const executeMessages = messages.filter((message) => {
    const params = message.args[0] as { kind: MessageKind; summary: string };
    return params.kind === MessageKind.Finding;
  });
  const verifyMessages = messages.filter((message) => {
    const params = message.args[0] as { kind: MessageKind; summary: string };
    return params.kind === MessageKind.ReviewRequest;
  });

  assertEquals(executeMessages.length, 3);
  assertEquals(verifyMessages.length, 3);
  assertEquals((executeMessages[0].args[0] as { summary: string }).summary.includes("Step 1"), true);
  assertEquals((verifyMessages[2].args[0] as { summary: string }).summary.includes("Step 3"), true);
});

Deno.test("executeRelay waits for handoff then review result for each successful step", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeAllPassWaitQueue());

  await executeRelay(makeContext(), brain, neuralLink);

  const waitCalls = callsByMethod(neuralLink.calls, "waitFor");
  assertEquals(waitCalls.length, 6);
  assertEquals(waitCalls[0].args[3], [MessageKind.Handoff]);
  assertEquals(waitCalls[1].args[3], [MessageKind.ReviewResult]);
  assertEquals(waitCalls[4].args[3], [MessageKind.Handoff]);
  assertEquals(waitCalls[5].args[3], [MessageKind.ReviewResult]);
});

Deno.test("executeRelay happy path records verify pass comments and returns completed", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeAllPassWaitQueue());

  const finalCtx = await executeRelay(makeContext(), brain, neuralLink);

  const verifyPassComments = callsByMethod(brain.calls, "taskComment").filter((call) => {
    const comment = call.args[1] as string;
    return comment.startsWith("[verify:passed]");
  });
  assertEquals(verifyPassComments.length, 3);
  assertEquals(finalCtx.state, RunState.Completed);
  assertEquals(finalCtx.iteration, 0);
});

Deno.test("executeRelay fix loop can recover from one verify failure and finish", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, [
    { from: "cortex", summary: "Step 1 handoff complete" },
    { passed: false, details: "Step 1 verify failed" },
    { from: "cortex", summary: "Step 1 fix handoff complete" },
    { passed: true, details: "Step 1 verify passed after fix" },
    { from: "probe", summary: "Step 2 handoff complete" },
    { passed: true, details: "Step 2 verify passed" },
    { from: "liaison", summary: "Step 3 handoff complete" },
    { passed: true, details: "Step 3 verify passed" },
  ]);

  const finalCtx = await executeRelay(makeContext(), brain, neuralLink);

  const fixMessages = callsByMethod(neuralLink.calls, "messageSend").filter((call) => {
    const params = call.args[0] as { summary: string };
    return params.summary.toLowerCase().includes("fix");
  });

  assertEquals(fixMessages.length, 1);
  assertEquals(finalCtx.iteration, 1);
  assertEquals(finalCtx.state, RunState.Completed);
});

Deno.test("executeRelay fix loop exhaustion records failure and returns failed context", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, [
    { from: "cortex", summary: "Step 1 handoff complete" },
    { passed: false, details: "verify fail 1" },
    { from: "cortex", summary: "Step 1 fix handoff #1" },
    { passed: false, details: "verify fail 2" },
    { from: "cortex", summary: "Step 1 fix handoff #2" },
    { passed: false, details: "verify fail 3" },
  ]);

  const finalCtx = await executeRelay(makeContext({ max_iterations: 2 }), brain, neuralLink);

  const priorityCalls = callsByMethod(brain.calls, "taskSetPriority");
  assertEquals(priorityCalls.length, 1);
  assertEquals(priorityCalls[0].args[0], "BRN-MOCK-1");
  assertEquals(priorityCalls[0].args[1], 1);

  const failureComments = callsByMethod(brain.calls, "taskComment").filter((call) => {
    const comment = call.args[1] as string;
    return comment.startsWith("[failure]");
  });
  assertEquals(failureComments.length, 1);
  assertEquals(finalCtx.state, RunState.Failed);
  assertEquals(finalCtx.iteration, 2);
});

Deno.test("executeRelay passes interactionMode supervisory in roomOpen call", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeAllPassWaitQueue());

  await executeRelay(makeContext(), brain, neuralLink);

  const roomOpen = callsByMethod(neuralLink.calls, "roomOpen")[0];
  const params = roomOpen.args[0] as { interactionMode: string };
  assertEquals(params.interactionMode, "supervisory");
});

Deno.test("executeRelay includes threadId on all messageSend calls", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeAllPassWaitQueue());

  await executeRelay(makeContext(), brain, neuralLink);

  const messages = callsByMethod(neuralLink.calls, "messageSend");
  for (const message of messages) {
    const params = message.args[0] as { threadId?: string };
    assertEquals(typeof params.threadId, "string");
  }
});

Deno.test("executeRelay does not continue to downstream steps after terminal verify failure", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, [
    { from: "cortex", summary: "Step 1 handoff complete" },
    { passed: false, details: "verify fail 1" },
    { from: "cortex", summary: "Step 1 fix handoff #1" },
    { passed: false, details: "verify fail 2" },
    { from: "cortex", summary: "Step 1 fix handoff #2" },
    { passed: false, details: "verify fail 3" },
  ]);

  await executeRelay(makeContext({ max_iterations: 2 }), brain, neuralLink);

  const stepComments = callsByMethod(brain.calls, "taskComment").filter((call) => {
    const comment = call.args[1] as string;
    return comment.startsWith("[step:");
  });
  assertEquals(stepComments.length, 3);
});
