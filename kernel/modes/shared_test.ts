import { assertEquals, assertThrows } from "@std/assert";

import { Mode, RunState, type RunContext } from "../types.ts";
import { MockBrainAdapter } from "../test_helpers/mock_brain.ts";
import {
  createRunContext,
  recordFailure,
  recordStepCompletion,
  recordVerifyResult,
  shouldRetry,
  transitionState,
} from "./shared.ts";

function makeContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    run_id: "run-123",
    mode: Mode.Relay,
    objective: "Implement shared utilities",
    workspace: "/tmp/workspace",
    state: RunState.Pending,
    brain_task_id: "BRN-123",
    room_id: "room-123",
    iteration: 0,
    max_iterations: 3,
    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    isVerifying: false,
    ...overrides,
  };
}

Deno.test("createRunContext sets required fields and sensible defaults", () => {
  const before = Date.now();
  const ctx = createRunContext({
    run_id: "run-ctx-1",
    mode: Mode.Scout,
    objective: "Gather context",
    workspace: "/tmp/ws",
    brain_task_id: "BRN-CTX-1",
    room_id: "room-ctx-1",
  });
  const after = Date.now();

  assertEquals(ctx.state, RunState.Pending);
  assertEquals(ctx.iteration, 0);
  assertEquals(ctx.max_iterations, 0);
  assertEquals(ctx.run_id, "run-ctx-1");
  assertEquals(ctx.mode, Mode.Scout);
  assertEquals(ctx.objective, "Gather context");
  assertEquals(ctx.workspace, "/tmp/ws");
  assertEquals(ctx.brain_task_id, "BRN-CTX-1");
  assertEquals(ctx.room_id, "room-ctx-1");

  const createdAtTs = Date.parse(ctx.created_at);
  assertEquals(Number.isNaN(createdAtTs), false);
  assertEquals(createdAtTs >= before && createdAtTs <= after, true);
});

Deno.test("transitionState returns a new context for valid transitions", () => {
  const pendingCtx = makeContext({ state: RunState.Pending });
  const runningCtx = transitionState(pendingCtx, RunState.Running);

  assertEquals(runningCtx.state, RunState.Running);
  assertEquals(pendingCtx.state, RunState.Pending);
  assertEquals(runningCtx === pendingCtx, false);
});

Deno.test("transitionState rejects invalid transitions", () => {
  const completedCtx = makeContext({ state: RunState.Completed });

  assertThrows(
    () => transitionState(completedCtx, RunState.Running),
    Error,
    "Invalid state transition",
  );
});

Deno.test("recordStepCompletion writes formatted comment to brain task", async () => {
  const brain = new MockBrainAdapter();
  const ctx = makeContext({ brain_task_id: "BRN-STEP-1" });

  await recordStepCompletion(brain, ctx, "analyze", "Found all required symbols");

  assertEquals(brain.calls.length, 1);
  assertEquals(brain.calls[0].method, "taskComment");
  assertEquals(brain.calls[0].args[0], "BRN-STEP-1");
  assertEquals(
    brain.calls[0].args[1],
    "[step:analyze] completed - Found all required symbols",
  );
});

Deno.test("recordVerifyResult writes outcome with details", async () => {
  const brain = new MockBrainAdapter();
  const ctx = makeContext({ brain_task_id: "BRN-VERIFY-1" });

  await recordVerifyResult(brain, ctx, "passed", "deno test --allow-all passed");

  assertEquals(brain.calls.length, 1);
  assertEquals(brain.calls[0].method, "taskComment");
  assertEquals(brain.calls[0].args[0], "BRN-VERIFY-1");
  assertEquals(
    brain.calls[0].args[1],
    "[verify:passed] deno test --allow-all passed",
  );
});

Deno.test("shouldRetry returns true only when iteration below max", () => {
  const canRetry = makeContext({ iteration: 2, max_iterations: 3 });
  const cannotRetry = makeContext({ iteration: 3, max_iterations: 3 });

  assertEquals(shouldRetry(canRetry), true);
  assertEquals(shouldRetry(cannotRetry), false);
});

Deno.test("recordFailure escalates task priority and adds failure comment", async () => {
  const brain = new MockBrainAdapter();
  const ctx = makeContext({ brain_task_id: "BRN-FAIL-1" });

  await recordFailure(brain, ctx, "Build failed with compilation error");

  assertEquals(brain.calls.length, 2);
  assertEquals(brain.calls[0].method, "taskSetPriority");
  assertEquals(brain.calls[0].args[0], "BRN-FAIL-1");
  assertEquals(brain.calls[0].args[1], 1);
  assertEquals(brain.calls[1].method, "taskComment");
  assertEquals(brain.calls[1].args[0], "BRN-FAIL-1");
  assertEquals(
    brain.calls[1].args[1],
    "[failure] Build failed with compilation error",
  );
});
