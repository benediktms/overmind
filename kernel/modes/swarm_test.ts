import { assertEquals } from "@std/assert";

import { MessageKind } from "../../adapters/neural_link/adapter.ts";
import { Mode, RunState, type RunContext } from "../types.ts";
import type { SwarmTask, WaitForMessage } from "../types.ts";
import { MockBrainAdapter, type MockCall } from "../test_helpers/mock_brain.ts";
import { MockNeuralLinkAdapter } from "../test_helpers/mock_neural_link.ts";
import { createRunContext } from "./shared.ts";
import { computeWaves, executeSwarm } from "./swarm.ts";
import type { TaskGraph } from "../planner/planner.ts";
import { MockDispatcher } from "../agent_dispatcher.ts";

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

Deno.test("executeSwarm sends wave-0 tasks before first waitFor call", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeHappyPathWaitQueue());

  await executeSwarm(makeContext(), brain, neuralLink);

  // Default tasks: wave 0 = [Task 1] (1 task with no deps)
  // Only wave-0 dispatches should precede the first waitFor
  const firstWaitIndex = neuralLink.calls.findIndex((call) => call.method === "waitFor");
  const wave0DispatchIndexes = neuralLink.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call, index }) => {
      if (call.method !== "messageSend") return false;
      const params = call.args[0] as { summary: string };
      return params.summary.startsWith("Execute") && index < firstWaitIndex;
    })
    .map(({ index }) => index);

  // Wave 0 has exactly 1 task (Task 1 has no dependencies)
  assertEquals(wave0DispatchIndexes.length, 1);
});

// --- Outcome model tests ---

Deno.test("executeSwarm skips fix-loop on stuck outcome and returns Failed", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  // Provide pipeline strategies so verifyWithPipeline is used
  const mockBash = {
    run: async (_cmd: string, _cwd?: string) => ({
      success: false,
      exitCode: 1,
      output: "Build failed: error",
      duration_ms: 100,
    }),
  };

  // 5 handoffs then pipeline will detect stuck (same failure 3x with retry)
  mockWaitForQueue(neuralLink, [
    { from: "cortex", summary: "Task 1 done" },
    { from: "probe", summary: "Task 2 done" },
    { from: "liaison", summary: "Task 3 done" },
    { from: "probe-2", summary: "Task 4 done" },
    { from: "cortex-2", summary: "Task 5 done" },
  ]);

  const ctx = makeContext({ max_iterations: 5 });
  const finalCtx = await executeSwarm(
    ctx,
    brain,
    neuralLink,
    undefined,
    [{ type: "build", command: "exit 1" }],
    undefined,
    mockBash,
  );

  assertEquals(finalCtx.state, RunState.Failed);

  // No fix messages should have been dispatched — stuck skips fix-loop
  const fixMessages = callsByMethod(neuralLink.calls, "messageSend").filter((call) => {
    const params = call.args[0] as { summary: string };
    return params.summary.startsWith("Fix");
  });
  assertEquals(fixMessages.length, 0);

  // Room should be closed as failed
  const roomClose = callsByMethod(neuralLink.calls, "roomClose")[0];
  assertEquals(roomClose.args[1], "failed");
});

Deno.test("executeSwarm passes interactionMode informative in roomOpen call", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeHappyPathWaitQueue());

  await executeSwarm(makeContext(), brain, neuralLink);

  const roomOpen = callsByMethod(neuralLink.calls, "roomOpen")[0];
  const params = roomOpen.args[0] as { interactionMode: string };
  assertEquals(params.interactionMode, "informative");
});

Deno.test("executeSwarm includes threadId on task dispatch messageSend calls", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, makeHappyPathWaitQueue());

  await executeSwarm(makeContext(), brain, neuralLink);

  const messages = callsByMethod(neuralLink.calls, "messageSend");
  const taskDispatches = messages.filter((message) => {
    const params = message.args[0] as { kind: MessageKind; summary: string };
    return params.kind === MessageKind.Finding && params.summary.startsWith("Execute");
  });

  for (const message of taskDispatches) {
    const params = message.args[0] as { threadId?: string };
    assertEquals(typeof params.threadId, "string");
  }
});

Deno.test("executeSwarm fresh-context mode produces clean fix body", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  mockWaitForQueue(neuralLink, [
    { from: "cortex", summary: "Task 1 done" },
    { from: "probe", summary: "Task 2 done" },
    { from: "liaison", summary: "Task 3 done" },
    { from: "probe-2", summary: "Task 4 done" },
    { from: "cortex-2", summary: "Task 5 done" },
    { passed: false, details: "tests failed", failedTasks: ["Task 2"] },
    { from: "probe", summary: "Fix done" },
    { passed: true, details: "all passed" },
  ]);

  const ctx = makeContext();
  await executeSwarm(ctx, brain, neuralLink, undefined, undefined, undefined, undefined, "fresh-context");

  const fixMessages = callsByMethod(neuralLink.calls, "messageSend").filter((call) => {
    const params = call.args[0] as { summary: string };
    return params.summary.startsWith("Fix");
  });

  assertEquals(fixMessages.length >= 1, true);
  const body = (fixMessages[0].args[0] as { body: string }).body;
  assertEquals(body.startsWith("Objective:"), true, `Expected fresh-context body starting with 'Objective:', got: ${body}`);
  assertEquals(body.includes("Previous attempt"), true);
});

Deno.test("executeSwarm uses graph tasks as swarm tasks when graph is provided", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  const graph: TaskGraph = {
    tasks: [
      {
        id: "t1",
        title: "Scaffold module",
        description: "Create module skeleton",
        agentRole: "probe",
        dependencies: [],
        acceptanceCriteria: [],
      },
      {
        id: "t2",
        title: "Write tests",
        description: "Add unit tests for module",
        agentRole: "liaison",
        dependencies: [],
        acceptanceCriteria: [],
      },
      {
        id: "t3",
        title: "Integrate module",
        description: "Wire module into system",
        agentRole: "cortex",
        dependencies: ["t1", "t2"],
        acceptanceCriteria: [],
      },
    ],
    parallelGroups: [["t1", "t2"]],
    entryPoints: ["t1", "t2"],
  };

  mockWaitForQueue(neuralLink, [
    { from: "probe", summary: "Scaffold done" },
    { from: "liaison", summary: "Tests done" },
    { from: "cortex", summary: "Integration done" },
    { passed: true, details: "all checks passed" },
  ]);

  const finalCtx = await executeSwarm(
    makeContext(),
    brain,
    neuralLink,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    graph,
  );

  assertEquals(finalCtx.state, RunState.Completed);

  const taskDispatches = callsByMethod(neuralLink.calls, "messageSend").filter((call) => {
    const params = call.args[0] as { kind: MessageKind; summary: string };
    return params.kind === MessageKind.Finding && params.summary.startsWith("Execute");
  });

  assertEquals(taskDispatches.length, 3);
  assertEquals(
    (taskDispatches[0].args[0] as { summary: string }).summary.includes("Scaffold module"),
    true,
  );
  assertEquals(
    (taskDispatches[1].args[0] as { summary: string }).summary.includes("Write tests"),
    true,
  );
  assertEquals(
    (taskDispatches[2].args[0] as { summary: string }).summary.includes("Integrate module"),
    true,
  );
});

// --- computeWaves unit tests ---

Deno.test("computeWaves returns single wave when no dependencies", () => {
  const tasks: SwarmTask[] = [
    { id: "A", title: "A", description: "desc A", agentRole: "probe", dependencies: [] },
    { id: "B", title: "B", description: "desc B", agentRole: "liaison", dependencies: [] },
    { id: "C", title: "C", description: "desc C", agentRole: "cortex", dependencies: [] },
  ];

  const waves = computeWaves(tasks);

  assertEquals(waves.length, 1);
  assertEquals(waves[0].map((t) => t.title), ["A", "B", "C"]);
});

Deno.test("computeWaves returns multiple waves respecting dependencies", () => {
  const tasks: SwarmTask[] = [
    { id: "A", title: "A", description: "desc A", agentRole: "probe", dependencies: [] },
    { id: "B", title: "B", description: "desc B", agentRole: "liaison", dependencies: ["A"] },
    { id: "C", title: "C", description: "desc C", agentRole: "cortex", dependencies: ["A"] },
    { id: "D", title: "D", description: "desc D", agentRole: "probe-2", dependencies: ["B", "C"] },
  ];

  const waves = computeWaves(tasks);

  assertEquals(waves.length, 3);
  assertEquals(waves[0].map((t) => t.title), ["A"]);
  assertEquals(waves[1].map((t) => t.title), ["B", "C"]);
  assertEquals(waves[2].map((t) => t.title), ["D"]);
});

Deno.test("computeWaves handles circular dependencies gracefully", () => {
  const tasks: SwarmTask[] = [
    { id: "A", title: "A", description: "desc A", agentRole: "probe", dependencies: ["B"] },
    { id: "B", title: "B", description: "desc B", agentRole: "liaison", dependencies: ["A"] },
    { id: "C", title: "C", description: "desc C", agentRole: "cortex", dependencies: [] },
  ];

  const waves = computeWaves(tasks);

  assertEquals(waves.length, 2);
  assertEquals(waves[0].map((t) => t.title), ["C"]);
  assertEquals(waves[1].map((t) => t.title).sort(), ["A", "B"].sort());
});

Deno.test("computeWaves resolves dependencies by id, not title (regression: ovr-9bc)", () => {
  // Distinct ids and titles, with deps expressed as ids — matching the
  // planner/topologicalSort contract. Previous implementation keyed
  // bookkeeping on title and would collapse waves 2+ into a single dump wave.
  const tasks: SwarmTask[] = [
    { id: "t1", title: "Scaffold module", description: "", agentRole: "probe", dependencies: [] },
    { id: "t2", title: "Write tests", description: "", agentRole: "liaison", dependencies: ["t1"] },
    { id: "t3", title: "Integrate module", description: "", agentRole: "cortex", dependencies: ["t1", "t2"] },
  ];

  const waves = computeWaves(tasks);

  assertEquals(waves.length, 3);
  assertEquals(waves[0].map((t) => t.id), ["t1"]);
  assertEquals(waves[1].map((t) => t.id), ["t2"]);
  assertEquals(waves[2].map((t) => t.id), ["t3"]);
});

Deno.test("executeSwarm dispatches tasks in dependency order", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();

  // Graph: A (no deps), B depends on A, C depends on B
  // Expected waves: [A], [B], [C]
  const graph: TaskGraph = {
    tasks: [
      { id: "a", title: "Task A", description: "desc A", agentRole: "probe", dependencies: [], acceptanceCriteria: [] },
      { id: "b", title: "Task B", description: "desc B", agentRole: "liaison", dependencies: ["a"], acceptanceCriteria: [] },
      { id: "c", title: "Task C", description: "desc C", agentRole: "cortex", dependencies: ["b"], acceptanceCriteria: [] },
    ],
    parallelGroups: [],
    entryPoints: ["a"],
  };

  // Wave 0: 1 handoff, wave 1: 1 handoff, wave 2: 1 handoff, then verify passes
  mockWaitForQueue(neuralLink, [
    { from: "probe", summary: "Task A done" },
    { from: "liaison", summary: "Task B done" },
    { from: "cortex", summary: "Task C done" },
    { passed: true, details: "all checks passed" },
  ]);

  const finalCtx = await executeSwarm(
    makeContext(),
    brain,
    neuralLink,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    graph,
  );

  assertEquals(finalCtx.state, RunState.Completed);

  // Collect Execute dispatches in call order
  const dispatches = callsByMethod(neuralLink.calls, "messageSend")
    .filter((call) => {
      const params = call.args[0] as { kind: MessageKind; summary: string };
      return params.kind === MessageKind.Finding && params.summary.startsWith("Execute");
    })
    .map((call) => (call.args[0] as { summary: string }).summary);

  // A must be dispatched before first waitFor, B before second, C before third
  assertEquals(dispatches, ["Execute Task A", "Execute Task B", "Execute Task C"]);

  // Verify dispatch A comes before first waitFor
  const firstWaitIndex = neuralLink.calls.findIndex((call) => call.method === "waitFor");
  const dispatchAIndex = neuralLink.calls.findIndex(
    (call) => call.method === "messageSend" &&
      ((call.args[0] as { summary: string }).summary === "Execute Task A"),
  );
  const dispatchBIndex = neuralLink.calls.findIndex(
    (call) => call.method === "messageSend" &&
      ((call.args[0] as { summary: string }).summary === "Execute Task B"),
  );

  assertEquals(dispatchAIndex < firstWaitIndex, true);
  assertEquals(dispatchBIndex > firstWaitIndex, true);
});

Deno.test("executeSwarm aborts cleanly mid-run and returns Cancelled (regression: ovr-4cf)", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  const controller = new AbortController();

  // Abort the run as soon as the room is opened so cancellation hits the
  // wave-loop boundary, exercising the catch + roomClose("cancelled") path.
  const originalRoomOpen = neuralLink.roomOpen.bind(neuralLink);
  neuralLink.roomOpen = async (...args: Parameters<typeof originalRoomOpen>) => {
    const result = await originalRoomOpen(...args);
    controller.abort();
    return result;
  };

  const ctx = makeContext();
  const finalCtx = await executeSwarm(
    { ...ctx, signal: controller.signal },
    brain,
    neuralLink,
  );

  assertEquals(finalCtx.state, RunState.Cancelled);

  const dispatchMessages = callsByMethod(neuralLink.calls, "messageSend").filter((call) => {
    const params = call.args[0] as { summary: string };
    return params.summary.startsWith("Execute") || params.summary.startsWith("Fix");
  });
  assertEquals(dispatchMessages.length, 0);

  const roomClose = callsByMethod(neuralLink.calls, "roomClose")[0];
  assertEquals(roomClose.args[1], "cancelled");
});

Deno.test("executeSwarm pre-aborted signal returns Cancelled without opening room (regression: ovr-4cf)", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  const controller = new AbortController();
  controller.abort();

  const ctx = makeContext();
  const finalCtx = await executeSwarm(
    { ...ctx, signal: controller.signal },
    brain,
    neuralLink,
  );

  assertEquals(finalCtx.state, RunState.Cancelled);
  assertEquals(callsByMethod(neuralLink.calls, "roomOpen").length, 0);
});

Deno.test("executeSwarm dispatches agents via dispatcher for each task", async () => {
  const brain = new MockBrainAdapter();
  const neuralLink = new MockNeuralLinkAdapter();
  const dispatcher = new MockDispatcher();
  mockWaitForQueue(neuralLink, makeHappyPathWaitQueue());

  await executeSwarm(
    makeContext(),
    brain,
    neuralLink,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    dispatcher,
  );

  assertEquals(dispatcher.dispatched.length, 5);

  const roles = dispatcher.dispatched.map((d) => d.role);
  assertEquals(roles.includes("cortex"), true);
  assertEquals(roles.includes("probe"), true);
  assertEquals(roles.includes("liaison"), true);
  assertEquals(dispatcher.dispatched[0].roomId, "room-mock-1");
});
