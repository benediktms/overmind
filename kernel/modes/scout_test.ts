import { assertEquals } from "@std/assert";

import { MessageKind } from "../../adapters/neural_link/adapter.ts";
import { type RunContext, RunState } from "../types.ts";
import type { WaitForMessage } from "../types.ts";
import { MockBrainAdapter, type MockCall } from "../test_helpers/mock_brain.ts";
import { MockNeuralLinkAdapter } from "../test_helpers/mock_neural_link.ts";
import { createRunContext } from "./shared.ts";
import { executeScout } from "./scout.ts";
import type { TaskGraph } from "../planner/planner.ts";
import { MockDispatcher } from "../agent_dispatcher.ts";

function makeContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    ...createRunContext({
      run_id: "run-scout-1",
      mode: "scout" as RunContext["mode"],
      objective: "Map orchestration flow for scout mode",
      workspace: "/tmp/overmind",
      brain_task_id: "BRN-SEED-1",
      room_id: "room-seed-1",
    }),
    ...overrides,
  };
}

function mockWaitForQueue(
  neuralLink: MockNeuralLinkAdapter,
  values: Array<unknown>,
): void {
  const queue = [...values];
  neuralLink.waitFor = async (
    roomId: string,
    participantId: string,
    timeoutMs: number,
    kinds?: string[],
    from?: string[],
  ): Promise<WaitForMessage | null> => {
    neuralLink.calls.push({
      method: "waitFor",
      args: [roomId, participantId, timeoutMs, kinds, from],
    });
    return (queue.shift() ?? null) as WaitForMessage | null;
  };
}

function callsByMethod(calls: MockCall[], method: string): MockCall[] {
  return calls.filter((call) => call.method === method);
}

Deno.test("executeScout creates brain task with scout-prefixed title", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  await executeScout(makeContext(), brain, neuralLink);

  const taskCreate = callsByMethod(brain.calls, "taskCreate")[0];
  assertEquals(
    taskCreate.args[0],
    {
      title: "[overmind:scout] Map orchestration flow for scout mode",
    },
  );
});

Deno.test("executeScout adds external run ID to created task", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  await executeScout(makeContext({ run_id: "run-ext-77" }), brain, neuralLink);

  const externalCall = callsByMethod(brain.calls, "taskAddExternalId")[0];
  assertEquals(externalCall.args[0], "BRN-MOCK-1");
  assertEquals(externalCall.args[1], "overmind_run_id:run-ext-77");
});

Deno.test("executeScout opens room with run ID in title", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  await executeScout(makeContext({ run_id: "run-room-9" }), brain, neuralLink);

  const roomOpen = callsByMethod(neuralLink.calls, "roomOpen")[0];
  const params = roomOpen.args[0] as {
    title: string;
    participantId: string;
    displayName: string;
  };
  assertEquals(params.title.includes("run-room-9"), true);
  assertEquals(params.participantId, "overmind-scout-lead");
  assertEquals(params.displayName, "Overmind Scout Lead");
});

Deno.test("executeScout dispatches three parallel explore finding messages by default", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  await executeScout(makeContext(), brain, neuralLink);

  const messages = callsByMethod(neuralLink.calls, "messageSend");
  assertEquals(messages.length, 3);
  for (const message of messages) {
    const params = message.args[0] as { kind: MessageKind; summary: string };
    assertEquals(params.kind, MessageKind.Finding);
    assertEquals(params.summary.includes("Explore"), true);
  }
});

Deno.test("executeScout waits for handoff messages using timeout", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  await executeScout(makeContext(), brain, neuralLink);

  const waitCalls = callsByMethod(neuralLink.calls, "waitFor");
  assertEquals(waitCalls.length, 3);
  for (const call of waitCalls) {
    assertEquals(call.args[1], "overmind-scout-lead");
    assertEquals(call.args[2], 30000);
    assertEquals(call.args[3], [MessageKind.Handoff]);
  }
});

Deno.test("executeScout synthesizes available findings when only two of three handoffs arrive", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, [
    { from: "probe-1", summary: "deps mapped", body: "kernel/modes/shared.ts" },
    {
      from: "probe-2",
      summary: "tests mapped",
      body: "kernel/modes/shared_test.ts",
    },
    null,
  ]);

  await executeScout(
    makeContext({ run_id: "run-partial-2of3" }),
    brain,
    neuralLink,
  );

  const memoryEpisode = callsByMethod(brain.calls, "memoryEpisode")[0];
  const payload = memoryEpisode.args[0] as {
    goal: string;
    actions: string;
    outcome: string;
    tags: string[];
  };

  assertEquals(payload.goal.includes("run-partial-2of3"), true);
  assertEquals(payload.actions.includes("deps mapped"), true);
  assertEquals(payload.actions.includes("tests mapped"), true);
  assertEquals(payload.outcome.includes("2/3"), true);
  assertEquals(payload.tags.includes("scout"), true);

  const complete = callsByMethod(brain.calls, "taskComplete")[0];
  assertEquals(complete.args[0], "BRN-MOCK-1");
});

Deno.test("executeScout closes room and returns completed run state", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  const finalCtx = await executeScout(makeContext(), brain, neuralLink);

  const roomClose = callsByMethod(neuralLink.calls, "roomClose")[0];
  assertEquals(roomClose.args[0], "room-mock-1");
  assertEquals(roomClose.args[1], "completed");
  assertEquals(finalCtx.state, RunState.Completed);
});

Deno.test("executeScout passes interactionMode informative in roomOpen call", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  await executeScout(makeContext(), brain, neuralLink);

  const roomOpen = callsByMethod(neuralLink.calls, "roomOpen")[0];
  const params = roomOpen.args[0] as { interactionMode: string };
  assertEquals(params.interactionMode, "informative");
});

Deno.test("executeScout includes threadId on probe dispatch messageSend calls", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  await executeScout(makeContext(), brain, neuralLink);

  const messages = callsByMethod(neuralLink.calls, "messageSend");
  for (const message of messages) {
    const params = message.args[0] as { threadId?: string };
    assertEquals(typeof params.threadId, "string");
  }
});

Deno.test("executeScout performs key lifecycle calls in expected order", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  await executeScout(makeContext({ run_id: "run-order-1" }), brain, neuralLink);

  const combined = [
    ...brain.calls.map((call) => `brain:${call.method}`),
    ...neuralLink.calls.map((call) => `neural:${call.method}`),
  ];

  const mustInclude = [
    "brain:taskCreate",
    "brain:taskAddExternalId",
    "neural:roomOpen",
    "neural:messageSend",
    "neural:waitFor",
    "brain:memoryEpisode",
    "neural:roomClose",
    "brain:taskComplete",
  ];

  for (const expected of mustInclude) {
    assertEquals(combined.includes(expected), true);
  }
});

Deno.test("executeScout uses graph tasks as explore angles when graph is provided", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  const graph: TaskGraph = {
    tasks: [
      {
        id: "t1",
        title: "Explore API surface",
        description: "Map all public endpoints",
        agentRole: "probe",
        dependencies: [],
        acceptanceCriteria: [],
      },
      {
        id: "t2",
        title: "Explore data model",
        description: "Catalog schema and relations",
        agentRole: "cortex",
        dependencies: [],
        acceptanceCriteria: [],
      },
    ],
    parallelGroups: [["t1", "t2"]],
    entryPoints: ["t1", "t2"],
  };

  mockWaitForQueue(neuralLink, [
    { from: "probe-1", summary: "API mapped" },
    { from: "probe-2", summary: "Data model mapped" },
  ]);

  await executeScout(makeContext(), brain, neuralLink, undefined, graph);

  const messages = callsByMethod(neuralLink.calls, "messageSend");
  assertEquals(messages.length, 2);
  assertEquals(
    (messages[0].args[0] as { summary: string }).summary.includes(
      "Explore API surface",
    ),
    true,
  );
  assertEquals(
    (messages[1].args[0] as { summary: string }).summary.includes(
      "Explore data model",
    ),
    true,
  );
});

Deno.test("executeScout dispatches agents via dispatcher for each probe", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  const dispatcher = new MockDispatcher();

  await executeScout(
    makeContext(),
    brain,
    neuralLink,
    undefined,
    undefined,
    dispatcher,
  );

  assertEquals(dispatcher.dispatched.length, 3);
  assertEquals(dispatcher.dispatched[0].participantId, "probe-1");
  assertEquals(dispatcher.dispatched[1].participantId, "probe-2");
  assertEquals(dispatcher.dispatched[2].participantId, "probe-3");
  assertEquals(dispatcher.dispatched[0].role, "probe");
  assertEquals(dispatcher.dispatched[0].roomId, "room-mock-1");
});
