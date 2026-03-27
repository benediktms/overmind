import { assertEquals } from "@std/assert";

import { MessageKind } from "../../adapters/neural_link/adapter.ts";
import { Mode, RunState, type RunContext } from "../types.ts";
import { MockBrainAdapter, type MockCall } from "../test_helpers/mock_brain.ts";
import { MockNeuralLinkAdapter } from "../test_helpers/mock_neural_link.ts";
import { createRunContext } from "./shared.ts";
import { executeSwarm } from "./swarm.ts";

function makeContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    ...createRunContext({
      run_id: "run-swarm-1",
      mode: Mode.Swarm,
      objective: "Ship swarm orchestration for parallel execution and verification",
      workspace: "/tmp/overmind",
      brain_task_id: "BRN-SEED-1",
      room_id: "room-seed-1",
    }),
    ...overrides,
  };
}

function mockWaitForQueue(neuralLink: MockNeuralLinkAdapter, values: Array<unknown | null>): void {
  const queue = [...values];
  neuralLink.waitFor = async (
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<unknown | null> => {
    neuralLink.calls.push({ method: "waitFor", args: [roomId, participantId, timeoutMs, kinds, from] });
    return queue.shift() ?? null;
  };
}

function callsByMethod(calls: MockCall[], method: string): MockCall[] {
  return calls.filter((call) => call.method === method);
}

function makeHappyPathWaitQueue(): Array<unknown> {
  return [
    { from: "cortex", summary: "Task 1 done" },
    { from: "probe", summary: "Task 2 done" },
    { from: "liaison", summary: "Task 3 done" },
    { from: "probe-2", summary: "Task 4 done" },
    { from: "cortex-2", summary: "Task 5 done" },
    { passed: true, details: "integration checks passed" },
  ];
}

Deno.test("executeSwarm creates brain task with swarm-prefixed title", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeHappyPathWaitQueue());

  await executeSwarm(makeContext(), brain, neuralLink);

  const taskCreate = callsByMethod(brain.calls, "taskCreate")[0];
  assertEquals(
    taskCreate.args[0],
    {
      title: "[overmind:swarm] Ship swarm orchestration for parallel execution and verification",
    },
  );
});

Deno.test("executeSwarm adds external run ID to created task", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeHappyPathWaitQueue());

  await executeSwarm(makeContext({ run_id: "run-swarm-ext-5" }), brain, neuralLink);

  const externalCall = callsByMethod(brain.calls, "taskAddExternalId")[0];
  assertEquals(externalCall.args[0], "BRN-MOCK-1");
  assertEquals(externalCall.args[1], "overmind_run_id:run-swarm-ext-5");
});

Deno.test("executeSwarm opens room with swarm lead identity", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeHappyPathWaitQueue());

  await executeSwarm(makeContext({ run_id: "run-swarm-room-2" }), brain, neuralLink);

  const roomOpen = callsByMethod(neuralLink.calls, "roomOpen")[0];
  const params = roomOpen.args[0] as { title: string; participantId: string; displayName: string };
  assertEquals(params.title.includes("run-swarm-room-2"), true);
  assertEquals(params.participantId, "overmind-swarm-lead");
  assertEquals(params.displayName, "Overmind Swarm Lead");
});

Deno.test("executeSwarm dispatches five parallel task messages before verification", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeHappyPathWaitQueue());

  await executeSwarm(makeContext(), brain, neuralLink);

  const messages = callsByMethod(neuralLink.calls, "messageSend");
  const taskDispatches = messages.filter((message) => {
    const params = message.args[0] as { kind: MessageKind; summary: string };
    return params.kind === MessageKind.Finding && params.summary.startsWith("Execute");
  });
  const verifyDispatches = messages.filter((message) => {
    const params = message.args[0] as { kind: MessageKind; summary: string };
    return params.kind === MessageKind.ReviewRequest;
  });

  assertEquals(taskDispatches.length, 5);
  assertEquals(verifyDispatches.length, 1);
});

Deno.test("executeSwarm waits for five handoffs then one review result", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeHappyPathWaitQueue());

  await executeSwarm(makeContext(), brain, neuralLink);

  const waitCalls = callsByMethod(neuralLink.calls, "waitFor");
  assertEquals(waitCalls.length, 6);
  assertEquals(waitCalls[0].args[3], [MessageKind.Handoff]);
  assertEquals(waitCalls[4].args[3], [MessageKind.Handoff]);
  assertEquals(waitCalls[5].args[3], [MessageKind.ReviewResult]);
});

Deno.test("executeSwarm happy path closes room, completes task, and returns completed", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeHappyPathWaitQueue());

  const finalCtx = await executeSwarm(makeContext(), brain, neuralLink);

  const roomClose = callsByMethod(neuralLink.calls, "roomClose")[0];
  const taskComplete = callsByMethod(brain.calls, "taskComplete")[0];
  assertEquals(roomClose.args[1], "completed");
  assertEquals(taskComplete.args[0], "BRN-MOCK-1");
  assertEquals(finalCtx.state, RunState.Completed);
  assertEquals(finalCtx.iteration, 0);
});

Deno.test("executeSwarm fix loop can recover from verify failure and then complete", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, [
    { from: "cortex", summary: "Task 1 done" },
    { from: "probe", summary: "Task 2 done" },
    { from: "liaison", summary: "Task 3 done" },
    { from: "probe-2", summary: "Task 4 done" },
    { from: "cortex-2", summary: "Task 5 done" },
    { passed: false, details: "integration failed", failedTasks: ["Task 2", "Task 4"] },
    { from: "probe", summary: "Fix Task 2 done" },
    { from: "probe-2", summary: "Fix Task 4 done" },
    { passed: true, details: "integration passed after fixes" },
  ]);

  const finalCtx = await executeSwarm(makeContext(), brain, neuralLink);

  const fixMessages = callsByMethod(neuralLink.calls, "messageSend").filter((call) => {
    const params = call.args[0] as { summary: string };
    return params.summary.startsWith("Fix");
  });

  assertEquals(fixMessages.length, 2);
  assertEquals(finalCtx.iteration, 1);
  assertEquals(finalCtx.state, RunState.Completed);
});

Deno.test("executeSwarm fix loop exhaustion records failure and returns failed context", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, [
    { from: "cortex", summary: "Task 1 done" },
    { from: "probe", summary: "Task 2 done" },
    { from: "liaison", summary: "Task 3 done" },
    { from: "probe-2", summary: "Task 4 done" },
    { from: "cortex-2", summary: "Task 5 done" },
    { passed: false, details: "verify fail 1", failedTasks: ["Task 2"] },
    { from: "probe", summary: "Fix Task 2 #1" },
    { passed: false, details: "verify fail 2", failedTasks: ["Task 2"] },
    { from: "probe", summary: "Fix Task 2 #2" },
    { passed: false, details: "verify fail 3", failedTasks: ["Task 2"] },
  ]);

  const finalCtx = await executeSwarm(makeContext({ max_iterations: 2 }), brain, neuralLink);

  const priorityCalls = callsByMethod(brain.calls, "taskSetPriority");
  const failureComments = callsByMethod(brain.calls, "taskComment").filter((call) => {
    const comment = call.args[1] as string;
    return comment.startsWith("[failure]");
  });

  assertEquals(priorityCalls.length, 1);
  assertEquals(priorityCalls[0].args[1], 1);
  assertEquals(failureComments.length, 1);
  assertEquals(finalCtx.state, RunState.Failed);
  assertEquals(finalCtx.iteration, 2);
});

Deno.test("executeSwarm sends full parallel wave before first waitFor call", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeHappyPathWaitQueue());

  await executeSwarm(makeContext(), brain, neuralLink);

  const firstWaitIndex = neuralLink.calls.findIndex((call) => call.method === "waitFor");
  const dispatchIndexes = neuralLink.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => {
      if (call.method !== "messageSend") {
        return false;
      }
      const params = call.args[0] as { summary: string };
      return params.summary.startsWith("Execute");
    })
    .map(({ index }) => index);

  assertEquals(dispatchIndexes.length, 5);
  assertEquals(dispatchIndexes.every((index) => index < firstWaitIndex), true);
});
